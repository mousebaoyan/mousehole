import { createHash, randomBytes } from "node:crypto";
import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";

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
});
