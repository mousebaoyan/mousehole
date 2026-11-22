import { createHash, randomBytes } from "node:crypto";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { clearUnusedAgentApps } from "./oauth.ts";

const api = testClient(app).api.v1;

const CALLBACK = "https://clock.example.com/login/callback";
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

type Who = { headers: Record<string, string> };
type Client = { id: number; client_id: string; client_secret: string };
let owner: Who;
let clock: Client;

const Issued = z.object({ access_token: z.string() });

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function register(name: string) {
  const res = await api.admin.apps.$post(
    { json: { name, redirect_uris: [CALLBACK], scopes: ["profile"] } },
    owner,
  );
  if (res.status !== 201) throw new Error(`status ${res.status}`);
  return res.json();
}

async function person() {
  const { id } = await createUser();
  return { id, who: as(await login(id)) };
}

function authorize(who: Who | undefined, params: Record<string, string> = {}) {
  return api.oauth.authorize.$post(
    {
      json: {
        response_type: "code",
        client_id: clock.client_id,
        redirect_uri: CALLBACK,
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...params,
      },
    },
    who,
  );
}

// The query the browser is sent back to the app with.
async function backAt(res: Awaited<ReturnType<typeof authorize>>) {
  if (!res.ok) throw new Error(`status ${res.status}`);
  const url = new URL((await res.json()).redirect_url);
  expect(url.origin + url.pathname).toBe(CALLBACK);
  return url.searchParams;
}

async function codeFor(who: Who, client = clock) {
  const code = (await backAt(await authorize(who, { client_id: client.client_id }))).get("code");
  if (!code) throw new Error("no code");
  return code;
}

// As an app's server calls it: a form, no Origin, the secret in Basic auth.
function exchange(fields: Record<string, string>, client = clock) {
  const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64");
  return app.request("/oauth/token", {
    method: "POST",
    headers: { authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: CALLBACK,
      code_verifier: verifier,
      ...fields,
    }),
  });
}

async function tokenFor(who: Who, client = clock) {
  const res = await exchange({ code: await codeFor(who, client) }, client);
  return bearer(Issued.parse(await res.json()).access_token);
}

beforeAll(async () => {
  owner = await ownerSession();
  clock = await register("鼠钟");
});

describe("自家应用的 OAuth", () => {
  test("登录了的直接带着授权码跳回，用码和密钥换到令牌，再用令牌取资料", async () => {
    const me = await person();
    const back = await backAt(await authorize(me.who));
    expect(back.get("state")).toBe("xyz");
    expect(back.get("iss")).toBe(env.PUBLIC_URL);

    const res = await exchange({ code: back.get("code") ?? "" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body: unknown = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", scope: "profile" });

    await db
      .updateTable("users")
      .set({ restriction: "mute", restricted_until: null })
      .where("id", "=", me.id)
      .execute();
    const profile = await api.me.$get({}, bearer(Issued.parse(body).access_token));
    expect(await profile.json()).toMatchObject({
      id: me.id,
      restriction: { type: "mute", until: null },
    });
    // Listed in their settings as the app, for them to revoke.
    const listed = await api.me.tokens.$get({}, me.who);
    if (!listed.ok) throw new Error(`status ${listed.status}`);
    expect((await listed.json()).items).toMatchObject([
      { name: "鼠钟", scopes: ["profile"], app: { name: "鼠钟", first_party: true } },
    ]);
  });

  test("授权码只能试一次：verifier 不对的那次也用掉了", async () => {
    const code = await codeFor((await person()).who);
    const wrong = await exchange({ code, code_verifier: randomBytes(32).toString("base64url") });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_grant" });
    const again = await exchange({ code });
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("回调地址对不上、密钥不对都换不到", async () => {
    const me = await person();
    const elsewhere = await exchange({
      code: await codeFor(me.who),
      redirect_uri: "https://clock.example.com/other",
    });
    expect(await elsewhere.json()).toMatchObject({ error: "invalid_grant" });

    const badSecret = await exchange(
      { code: await codeFor(me.who) },
      { ...clock, client_secret: "not-the-secret" },
    );
    expect(badSecret.status).toBe(401);
    expect(await badSecret.json()).toMatchObject({ error: "invalid_client" });
  });

  test("没登录：prompt=none 带着 login_required 跳回，否则要先登录", async () => {
    const silent = await backAt(await authorize(undefined, { prompt: "none" }));
    expect(silent.get("error")).toBe("login_required");
    expect(silent.get("state")).toBe("xyz");
    expect((await authorize(undefined)).status).toBe(401);
  });

  test("应用和回调地址不对时不跳回，其余的错误带回给应用", async () => {
    const { who } = await person();
    const unknown = await authorize(who, { redirect_uri: "https://evil.example.com/" });
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { code: "invalid_client" } });

    expect((await backAt(await authorize(who, { scope: "read" }))).get("error")).toBe(
      "invalid_scope",
    );
    expect(
      (await backAt(await authorize(who, { code_challenge_method: "plain" }))).get("error"),
    ).toBe("invalid_request");
  });

  test("每人在一个应用只有一个令牌：再登录一次，旧的失效", async () => {
    const { who } = await person();
    const first = await tokenFor(who);
    const second = await tokenFor(who);
    expect((await api.me.$get({}, first)).status).toBe(401);
    expect((await api.me.$get({}, second)).status).toBe(200);
  });

  test("封禁时没换的授权码也作废", async () => {
    const me = await person();
    const code = await codeFor(me.who);
    const admin = await createUser("admin");
    await api.users[":user"].restriction.$put(
      { param: { user: String(me.id) }, json: { type: "ban", until: null, reason: "刷屏" } },
      as(await login(admin.id)),
    );
    expect(await (await exchange({ code })).json()).toMatchObject({ error: "invalid_grant" });
  });

  test("停用后令牌失效，也不能再授权；只有站长能管", async () => {
    const other = await register("要停用的");
    const { who } = await person();
    const token = await tokenFor(who, other);
    const disable = { param: { id: String(other.id) }, json: { disabled: true } };

    expect((await api.admin.apps[":id"].$patch(disable, who)).status).toBe(403);
    expect((await api.admin.apps[":id"].$patch(disable, owner)).status).toBe(204);
    expect((await api.me.$get({}, token)).status).toBe(401);
    expect((await authorize(who, { client_id: other.client_id })).status).toBe(400);
  });

  test("自己的令牌列表里是应用现在的名字", async () => {
    const renamed = await register("改名前");
    const { who } = await person();
    await tokenFor(who, renamed);
    const rename = { param: { id: String(renamed.id) }, json: { name: "改名后" } };
    expect((await api.admin.apps[":id"].$patch(rename, owner)).status).toBe(204);
    const listed = await api.me.tokens.$get({}, who);
    if (!listed.ok) throw new Error(`status ${listed.status}`);
    expect((await listed.json()).items).toMatchObject([
      { app: { name: "改名后", first_party: true } },
    ]);
  });
});

// As Codex has it: a callback on whichever port is free when it logs in.
const AGENT_CALLBACK = "http://127.0.0.1:41234/callback";
let lastIp = 0;

// An Agent registering, each from an address of its own unless said.
function registerAgent(body: object, ip = `198.51.100.${++lastIp}`) {
  return app.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(body),
  });
}

const Registered = z.object({ client_id: z.string() });

async function agent(name = "Codex", redirect_uris = [AGENT_CALLBACK]) {
  const res = await registerAgent({ client_name: name, redirect_uris });
  if (res.status !== 201) throw new Error(`status ${res.status}`);
  return Registered.parse(await res.json()).client_id;
}

function agentRequest(clientId: string, params: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: AGENT_CALLBACK,
    state: "abc",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...params,
  };
}

// What the page sends when the member presses a button.
function decide(
  who: Who,
  clientId: string,
  choice: { approve: boolean; scopes?: ("profile" | "read" | "act")[] },
  params: Record<string, string> = {},
) {
  return api.oauth.authorize.$post({ json: { ...agentRequest(clientId, params), ...choice } }, who);
}

// As an Agent calls it: no secret, its client ID in the form.
function agentExchange(clientId: string, fields: Record<string, string>) {
  return app.request("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: AGENT_CALLBACK,
      code_verifier: verifier,
      ...fields,
    }),
  });
}

async function agentToken(who: Who, clientId: string) {
  const back = new URL(
    z
      .object({ redirect_url: z.string() })
      .parse(await (await decide(who, clientId, { approve: true })).json()).redirect_url,
  );
  const res = await agentExchange(clientId, { code: back.searchParams.get("code") ?? "" });
  return bearer(Issued.parse(await res.json()).access_token);
}

describe("Agent 的 OAuth", () => {
  test("元数据给出注册、授权和换令牌的地址，issuer 和回跳的 iss 一字不差，不说支持 CIMD", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server");
    const metadata = z
      .object({ issuer: z.string(), registration_endpoint: z.string() })
      .loose()
      .parse(await res.json());
    expect(metadata.issuer).toBe(env.PUBLIC_URL);
    expect(metadata.registration_endpoint).toBe(`${env.PUBLIC_URL}/oauth/register`);
    expect(metadata).not.toHaveProperty("client_id_metadata_document_supported");
  });

  test("注册后本人在授权页去掉发帖再允许，换到只能读的令牌；回调换了端口也认", async () => {
    const me = await person();
    const clientId = await agent();
    const elsewhere = { redirect_uri: "http://127.0.0.1:50999/callback" };

    const page = await api.oauth.authorize.$get(
      { query: agentRequest(clientId, elsewhere) },
      me.who,
    );
    expect(await page.json()).toEqual({
      app: { name: "Codex", first_party: false },
      redirect_host: "127.0.0.1",
      local: true,
      scopes: ["read", "act"],
      level: 1,
      role: "user",
    });

    const res = await decide(me.who, clientId, { approve: true, scopes: ["read"] }, elsewhere);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const back = new URL((await res.json()).redirect_url);
    expect(back.origin + back.pathname).toBe("http://127.0.0.1:50999/callback");
    expect(back.searchParams.get("state")).toBe("abc");
    expect(back.searchParams.get("iss")).toBe(env.PUBLIC_URL);

    const token = await agentExchange(clientId, {
      code: back.searchParams.get("code") ?? "",
      redirect_uri: elsewhere.redirect_uri,
      resource: `${env.PUBLIC_URL}/mcp`,
    });
    expect(token.status).toBe(200);
    const body: unknown = await token.json();
    expect(body).toMatchObject({ token_type: "Bearer", scope: "read" });
    const agentBearer = bearer(Issued.parse(body).access_token);
    expect((await api.me.$get({}, agentBearer)).status).toBe(200);
    const listed = await api.me.tokens.$get({}, me.who);
    if (!listed.ok) throw new Error(`status ${listed.status}`);
    expect((await listed.json()).items).toMatchObject([
      { name: "Codex", scopes: ["read"], app: { name: "Codex", first_party: false } },
    ]);
  });

  test("拒绝就带着 access_denied 跳回；不能比应用要的多；每次授权一个新令牌，旧的照样能用", async () => {
    const { who } = await person();
    const clientId = await agent();
    const denied = await decide(who, clientId, { approve: false });
    if (!denied.ok) throw new Error(`status ${denied.status}`);
    expect(new URL((await denied.json()).redirect_url).searchParams.get("error")).toBe(
      "access_denied",
    );
    const more = await decide(
      who,
      clientId,
      { approve: true, scopes: ["read", "act"] },
      {
        scope: "read",
      },
    );
    expect(more.status).toBe(400);

    const first = await agentToken(who, clientId);
    const second = await agentToken(who, clientId);
    expect((await api.me.$get({}, first)).status).toBe(200);
    expect((await api.me.$get({}, second)).status).toBe(200);
  });

  test("冻结的账号和站长不能授权 Agent", async () => {
    const clientId = await agent();
    const frozen = await person();
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", frozen.id)
      .execute();
    for (const who of [frozen.who, owner]) {
      const page = await api.oauth.authorize.$get({ query: agentRequest(clientId) }, who);
      expect(page.status).toBe(403);
      expect((await decide(who, clientId, { approve: true })).status).toBe(403);
    }
  });

  test("只有本机的回调不比端口，别的一字不差；resource 只能是论坛或 MCP", async () => {
    const { who } = await person();
    const local = await agent();
    const site = await agent("网页版", ["https://agent.example.com/callback"]);
    for (const [clientId, redirect_uri] of [
      [local, "http://localhost:41234/callback"],
      [local, "http://127.0.0.1:41234/other"],
      [site, "https://agent.example.com:8443/callback"],
    ]) {
      const res = await api.oauth.authorize.$get(
        { query: agentRequest(clientId, { redirect_uri }) },
        who,
      );
      expect(res.status).toBe(400);
    }

    const wrong = await decide(
      who,
      local,
      { approve: true },
      {
        resource: "https://evil.example.com/mcp",
      },
    );
    if (!wrong.ok) throw new Error(`status ${wrong.status}`);
    expect(new URL((await wrong.json()).redirect_url).searchParams.get("error")).toBe(
      "invalid_target",
    );
    const res = await decide(who, local, { approve: true });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const code = new URL((await res.json()).redirect_url).searchParams.get("code") ?? "";
    const token = await agentExchange(local, { code, resource: "https://evil.example.com/" });
    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "invalid_target" });
  });

  test("注册：回调要是 https 或本机的 http，不带密钥；一个地址每小时 10 次，请求体最多 4KB", async () => {
    const uri = await registerAgent({
      client_name: "Codex",
      redirect_uris: ["http://agent.example.com/callback"],
    });
    expect(uri.status).toBe(400);
    expect(await uri.json()).toMatchObject({ error: "invalid_redirect_uri" });
    const secret = await registerAgent({
      client_name: "Codex",
      redirect_uris: [AGENT_CALLBACK],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(await secret.json()).toMatchObject({ error: "invalid_client_metadata" });
    const big = await registerAgent({
      client_name: "Codex",
      redirect_uris: [AGENT_CALLBACK],
      logo_uri: "x".repeat(5000),
    });
    expect(big.status).toBe(413);

    const body = { client_name: "Codex", redirect_uris: [AGENT_CALLBACK] };
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await registerAgent(body, "192.0.2.1")).status);
    expect(statuses).toEqual([...Array<number>(10).fill(201), 429]);
  });

  test("第一次换令牌时碰上每天的清理，应用不会被删", async () => {
    const { who } = await person();
    const clientId = await agent();
    await db
      .updateTable("oauth_clients")
      .set({ created_at: sql`now() - interval '2 days'` })
      .where("client_id", "=", clientId)
      .execute();
    const res = await decide(who, clientId, { approve: true });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const code = new URL((await res.json()).redirect_url).searchParams.get("code") ?? "";

    // Holds the exchange just before it writes the token, then clears.
    const taken = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const lock = db.transaction().execute(async (trx) => {
      await sql`LOCK TABLE api_tokens IN SHARE MODE`.execute(trx);
      taken.resolve();
      await held.promise;
    });
    await taken.promise;
    const exchanging = agentExchange(clientId, { code });
    try {
      await vi.waitFor(async () => {
        const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE 'insert into "api_tokens"%'`.execute(db);
        expect(rows[0].n).toBe(1);
      });
      await clearUnusedAgentApps();
    } finally {
      held.resolve();
      await lock;
    }
    expect((await exchanging).status).toBe(200);
  });

  test("一天前注册、没换到令牌的被清掉；后台的应用列表里没有 Agent 的，站长也改不了", async () => {
    const { who } = await person();
    const unused = await agent("没用上的");
    const used = await agent("用上的");
    await agentToken(who, used);
    await db
      .updateTable("oauth_clients")
      .set({ created_at: sql`now() - interval '2 days'` })
      .where("client_id", "in", [unused, used])
      .execute();
    await clearUnusedAgentApps();
    const left = await db
      .selectFrom("oauth_clients")
      .select(["id", "client_id"])
      .where("client_id", "in", [unused, used])
      .execute();
    expect(left.map((a) => a.client_id)).toEqual([used]);

    const apps = await api.admin.apps.$get({}, owner);
    if (!apps.ok) throw new Error(`status ${apps.status}`);
    expect((await apps.json()).items.map((a) => a.client_id)).not.toContain(used);
    const disable = { param: { id: String(left[0].id) }, json: { disabled: true } };
    expect((await api.admin.apps[":id"].$patch(disable, owner)).status).toBe(404);
  });
});
