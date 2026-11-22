import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Actor, Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import { hashToken, newToken } from "../../platform/tokens.ts";
import { recordAudit } from "../audit/service.ts";
import { MEMBER_TOKEN_IDLE_MS } from "./service.ts";

// What an app may ask for (design §6.7); our own sites usually want `profile` alone, Agents what
// the MCP needs.
export const APP_SCOPES = ["profile", "read", "act"] as const;
export type AppScope = (typeof APP_SCOPES)[number];
const AGENT_SCOPES = ["read", "act"];

// Callbacks to a program on the member's own computer.
export const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
// What a token may be for (RFC 8707): the API, or the MCP.
const RESOURCES = [env.PUBLIC_URL, `${env.PUBLIC_URL}/mcp`];

const CODE_TTL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// PKCE's S256 challenge: the base64url of a SHA-256, without padding.
const CHALLENGE = /^[\w-]{43}$/;

type AppInput = { name: string; redirect_uris: string[]; scopes: AppScope[] };

// Our own sites, with how many people's tokens are in force and when one was last used. Agents'
// apps have no secret and are their members' to see, in their settings.
export async function listApps() {
  return db
    .selectFrom("oauth_clients")
    .leftJoin("api_tokens", (join) =>
      join
        .onRef("api_tokens.client_id", "=", "oauth_clients.id")
        .on("api_tokens.revoked_at", "is", null)
        .on(
          sql<Date>`coalesce(api_tokens.last_used_at, api_tokens.created_at)`,
          ">",
          new Date(Date.now() - MEMBER_TOKEN_IDLE_MS),
        ),
    )
    .select((eb) => [
      "oauth_clients.id",
      "oauth_clients.client_id",
      "oauth_clients.name",
      "oauth_clients.redirect_uris",
      "oauth_clients.scopes",
      "oauth_clients.disabled_at",
      eb.fn.count<number>("api_tokens.id").as("tokens"),
      eb.fn.max("api_tokens.last_used_at").as("last_used_at"),
    ])
    .where("oauth_clients.secret_hash", "is not", null)
    .groupBy("oauth_clients.id")
    .orderBy("oauth_clients.id", "desc")
    .execute();
}

// The secret is shown this once; the forum keeps its hash.
export async function createApp(actor: Actor, input: AppInput) {
  const clientId = randomUUID();
  const secret = newToken();
  return db.transaction().execute(async (trx) => {
    const { id } = await trx
      .insertInto("oauth_clients")
      .values({ ...input, client_id: clientId, secret_hash: hashToken(secret) })
      .returning("id")
      .executeTakeFirstOrThrow();
    await recordAudit(trx, actor, {
      action: "app.create",
      target_type: "app",
      target_id: id,
      data: input,
    });
    return { id, client_id: clientId, client_secret: secret };
  });
}

// Disabling an app ends its tokens there and then; enabled again, people log in afresh.
export async function updateApp(
  actor: Actor,
  id: number,
  input: Partial<AppInput> & { disabled?: boolean },
) {
  const { disabled, ...fields } = input;
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("oauth_clients")
      .set({
        ...fields,
        ...(disabled !== undefined && { disabled_at: disabled ? new Date() : null }),
      })
      .where("id", "=", id)
      .where("secret_hash", "is not", null)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) throw new AppError(404, "not_found", "应用不存在");
    if (disabled) {
      await trx
        .updateTable("api_tokens")
        .set({ revoked_at: new Date() })
        .where("client_id", "=", id)
        .where("revoked_at", "is", null)
        .execute();
    }
    await recordAudit(trx, actor, {
      action: "app.update",
      target_type: "app",
      target_id: id,
      data: input,
    });
  });
}

export async function renewAppSecret(actor: Actor, id: number) {
  const secret = newToken();
  await db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("oauth_clients")
      .set({ secret_hash: hashToken(secret) })
      .where("id", "=", id)
      .where("secret_hash", "is not", null)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) throw new AppError(404, "not_found", "应用不存在");
    await recordAudit(trx, actor, { action: "app.secret", target_type: "app", target_id: id });
  });
  return { client_secret: secret };
}

// An Agent connecting for the first time (RFC 7591). It runs on the member's computer, so it has
// no secret to keep; it may ask for any scope, and the member sees which on the page.
export async function registerAgent(input: { client_name: string; redirect_uris: string[] }) {
  const clientId = randomUUID();
  const { created_at } = await db
    .insertInto("oauth_clients")
    .values({
      client_id: clientId,
      name: input.client_name,
      redirect_uris: input.redirect_uris,
      scopes: [...APP_SCOPES],
    })
    .returning("created_at")
    .executeTakeFirstOrThrow();
  return { client_id: clientId, created_at };
}

// Daily: anyone may register, so Agents that did a day ago and never got a token go, unless a code
// of theirs is still waiting.
export async function clearUnusedAgentApps() {
  await db
    .deleteFrom("oauth_clients")
    .where("secret_hash", "is", null)
    .where("created_at", "<", new Date(Date.now() - DAY_MS))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("api_tokens")
            .select("id")
            .whereRef("api_tokens.client_id", "=", "oauth_clients.id"),
        ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("oauth_codes")
            .select("code_hash")
            .whereRef("oauth_codes.client_id", "=", "oauth_clients.id"),
        ),
      ),
    )
    .execute();
}

// An authorization request as the app sent it, unchecked.
export type AuthorizationRequest = {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  resource?: string;
  prompt?: string;
};

// Registered callbacks match as written, a loopback one on any port (RFC 8252 §7.3): Agents listen
// on whichever is free.
function matches(registered: string, uri: string) {
  if (registered === uri) return true;
  const a = new URL(registered);
  const b = URL.parse(uri);
  if (!b || a.protocol !== "http:" || !LOOPBACK.includes(a.hostname)) return false;
  a.port = "";
  b.port = "";
  return a.href === b.href;
}

// A request as docs/api.md §8.3 has it. A wrong app or callback is told on the page and goes
// nowhere; past those, what is wrong goes back to the app, as OAuth says. Someone not logged in
// logs in first, unless the app only asked whether they are.
async function checkRequest<Who extends { viewer: Viewer }>(
  who: Who | null,
  req: AuthorizationRequest,
) {
  const app =
    req.client_id &&
    (await db
      .selectFrom("oauth_clients")
      .select([
        "id",
        "name",
        "redirect_uris",
        "scopes",
        sql<boolean>`secret_hash IS NOT NULL`.as("first_party"),
      ])
      .where("client_id", "=", req.client_id)
      .where("disabled_at", "is", null)
      .executeTakeFirst());
  const redirectUri = req.redirect_uri;
  if (!app || !redirectUri || !app.redirect_uris.some((uri) => matches(uri, redirectUri))) {
    throw new AppError(400, "invalid_client", "应用不存在或已停用，或者回调地址没有登记");
  }
  const back = (params: Record<string, string>) => {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    if (req.state !== undefined) url.searchParams.set("state", req.state);
    url.searchParams.set("iss", env.PUBLIC_URL);
    return url.href;
  };

  if (req.response_type !== "code")
    return { refused: back({ error: "unsupported_response_type" }) };
  const challenge = req.code_challenge;
  if (req.code_challenge_method !== "S256" || !challenge || !CHALLENGE.test(challenge)) {
    return { refused: back({ error: "invalid_request", error_description: "要用 PKCE 的 S256" }) };
  }
  const scopes = req.scope
    ? [...new Set(req.scope.split(" ").filter(Boolean))]
    : app.first_party
      ? app.scopes
      : AGENT_SCOPES;
  if (scopes.length === 0 || !scopes.every((s) => app.scopes.includes(s))) {
    return { refused: back({ error: "invalid_scope" }) };
  }
  if (req.resource !== undefined && !RESOURCES.includes(req.resource)) {
    return { refused: back({ error: "invalid_target" }) };
  }
  if (!who) {
    if (req.prompt === "none") return { refused: back({ error: "login_required" }) };
    throw new AppError(401, "unauthorized", "请先登录");
  }
  // Frozen accounts count as guests and the owner only runs the system, so neither gives an Agent
  // the run of the forum; both still log in to our own sites.
  const { viewer } = who;
  if (!app.first_party && (viewer.member_status !== "member" || viewer.role === "owner")) {
    throw new AppError(403, "forbidden", "冻结的账号和站长只能登录自家应用，不能授权 Agent");
  }
  return { who, app, redirectUri, scopes, challenge, back };
}

// What the authorization page shows, or where the browser goes back right away.
export async function describeAuthorization(viewer: Viewer | null, req: AuthorizationRequest) {
  const checked = await checkRequest(viewer && { viewer }, req);
  if (checked.refused !== undefined) return { redirect_url: checked.refused };
  const { hostname } = new URL(checked.redirectUri);
  return {
    app: { name: checked.app.name, first_party: checked.app.first_party },
    redirect_host: hostname,
    local: LOOPBACK.includes(hostname),
    scopes: checked.scopes,
    level: checked.who.viewer.level,
    role: checked.who.viewer.role,
  };
}

// Where the browser goes back to the app: with a code, or an error. Our own sites get no page to
// approve on; an Agent is what the member approved, with what they left ticked of what it asked.
export async function authorizeApp(
  who: { viewer: Viewer; actor: Actor } | null,
  req: AuthorizationRequest,
  choice: { approve?: boolean; scopes?: AppScope[] },
) {
  const checked = await checkRequest(who, req);
  if (checked.refused !== undefined) return checked.refused;
  const { app, back, who: by } = checked;
  if (!app.first_party && !choice.approve) return back({ error: "access_denied" });
  const scopes = app.first_party ? checked.scopes : (choice.scopes ?? checked.scopes);
  if (!scopes.every((s) => checked.scopes.includes(s))) {
    throw new AppError(400, "invalid_request", "只能去掉应用要的权限，不能加");
  }

  const code = newToken();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("oauth_codes")
      .values({
        code_hash: hashToken(code),
        client_id: app.id,
        user_id: by.actor.userId,
        redirect_uri: checked.redirectUri,
        scopes,
        code_challenge: checked.challenge,
        expires_at: new Date(Date.now() + CODE_TTL_MS),
      })
      .execute();
    await recordAudit(trx, by.actor, {
      action: "auth.authorize",
      target_type: "app",
      target_id: app.id,
      data: { scopes },
    });
  });
  return back({ code });
}

export type TokenRequest = {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  client_id?: string;
  client_secret?: string;
  resource?: string;
};

// A code for the person's token at the app. Our own sites prove themselves with their secret;
// Agents have none. The code is gone once tried, right or wrong. Each person has one token at each
// of our sites, a new one ending the last, but one at each Agent they authorize (design §6.7).
export async function exchangeCode(req: TokenRequest) {
  const secret = req.client_secret;
  const app =
    req.client_id &&
    (await db
      .selectFrom("oauth_clients")
      .select(["id", "name", sql<boolean>`secret_hash IS NOT NULL`.as("first_party")])
      .where("client_id", "=", req.client_id)
      .where((eb) =>
        secret === undefined
          ? eb("secret_hash", "is", null)
          : eb("secret_hash", "=", hashToken(secret)),
      )
      .where("disabled_at", "is", null)
      .executeTakeFirst());
  if (!app) throw new AppError(401, "invalid_client", "应用不存在、密钥不对或应用已停用");
  if (req.grant_type !== "authorization_code") {
    throw new AppError(400, "unsupported_grant_type", "只支持 authorization_code");
  }
  if (req.resource !== undefined && !RESOURCES.includes(req.resource)) {
    throw new AppError(400, "invalid_target", "resource 只能是论坛或它的 MCP 的地址");
  }
  // The code goes with the token in one transaction: until it commits, the code still holds a new
  // Agent's app against the daily clearing. A wrong try commits only the code's going.
  const token = await db.transaction().execute(async (trx) => {
    const grant =
      req.code &&
      (await trx
        .deleteFrom("oauth_codes")
        .where("code_hash", "=", hashToken(req.code))
        .where("expires_at", ">", new Date())
        .returning(["client_id", "user_id", "redirect_uri", "scopes", "code_challenge"])
        .executeTakeFirst());
    const verifier = req.code_verifier;
    if (
      !grant ||
      grant.client_id !== app.id ||
      grant.redirect_uri !== req.redirect_uri ||
      !verifier ||
      createHash("sha256").update(verifier).digest("base64url") !== grant.code_challenge
    ) {
      return null;
    }
    if (app.first_party) {
      await trx
        .updateTable("api_tokens")
        .set({ revoked_at: new Date() })
        .where("user_id", "=", grant.user_id)
        .where("client_id", "=", app.id)
        .where("revoked_at", "is", null)
        .execute();
    }
    const issued = newToken();
    await trx
      .insertInto("api_tokens")
      .values({
        name: app.name,
        token_hash: hashToken(issued),
        scopes: grant.scopes,
        user_id: grant.user_id,
        client_id: app.id,
      })
      .execute();
    return { access_token: issued, token_type: "Bearer", scope: grant.scopes.join(" ") };
  });
  if (!token) {
    throw new AppError(400, "invalid_grant", "授权码不对、已过期或已用过，或者和授权时的对不上");
  }
  return token;
}
