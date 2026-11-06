import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import { hashToken, newToken } from "../../platform/tokens.ts";
import { recordAudit } from "../audit/service.ts";
import { MEMBER_TOKEN_IDLE_MS } from "./service.ts";

// What an app may ask for (design §6.7); our own sites usually want `profile` alone.
export const APP_SCOPES = ["profile", "read", "act"] as const;
export type AppScope = (typeof APP_SCOPES)[number];

const CODE_TTL_MS = 5 * 60 * 1000;
// PKCE's S256 challenge: the base64url of a SHA-256, without padding.
const CHALLENGE = /^[\w-]{43}$/;

type AppInput = { name: string; redirect_uris: string[]; scopes: AppScope[] };

// Our own sites, with how many people's tokens are in force and when one was last used.
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
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) throw new AppError(404, "not_found", "应用不存在");
    await recordAudit(trx, actor, { action: "app.secret", target_type: "app", target_id: id });
  });
  return { client_secret: secret };
}

// An authorization request as the app sent it, unchecked: past the app and its redirect, what is
// wrong goes back to the app as OAuth says.
export type AuthorizationRequest = {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  prompt?: string;
};

// Where the browser goes back to the app (docs/api.md §8.3): with a code, or an error. Our own sites
// get no page to approve on; someone not logged in logs in first, unless the app only asked
// whether they are.
export async function authorizeApp(actor: Actor | null, req: AuthorizationRequest) {
  const app =
    req.client_id &&
    (await db
      .selectFrom("oauth_clients")
      .select(["id", "redirect_uris", "scopes"])
      .where("client_id", "=", req.client_id)
      .where("disabled_at", "is", null)
      .executeTakeFirst());
  const redirectUri = req.redirect_uri;
  if (!app || !redirectUri || !app.redirect_uris.includes(redirectUri)) {
    throw new AppError(400, "invalid_client", "应用不存在或已停用，或者回调地址没有登记");
  }
  const back = (params: Record<string, string>) => {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    if (req.state !== undefined) url.searchParams.set("state", req.state);
    url.searchParams.set("iss", env.PUBLIC_URL);
    return url.href;
  };

  if (req.response_type !== "code") return back({ error: "unsupported_response_type" });
  const challenge = req.code_challenge;
  if (req.code_challenge_method !== "S256" || !challenge || !CHALLENGE.test(challenge)) {
    return back({ error: "invalid_request", error_description: "要用 PKCE 的 S256" });
  }
  const scopes = req.scope ? [...new Set(req.scope.split(" ").filter(Boolean))] : app.scopes;
  if (!scopes.every((s) => app.scopes.includes(s))) return back({ error: "invalid_scope" });
  if (!actor) {
    if (req.prompt === "none") return back({ error: "login_required" });
    throw new AppError(401, "unauthorized", "请先登录");
  }

  const code = newToken();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("oauth_codes")
      .values({
        code_hash: hashToken(code),
        client_id: app.id,
        user_id: actor.userId,
        redirect_uri: redirectUri,
        scopes,
        code_challenge: challenge,
        expires_at: new Date(Date.now() + CODE_TTL_MS),
      })
      .execute();
    await recordAudit(trx, actor, {
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
};

// A code for the person's token at the app that proves itself with its secret. The code is gone
// once tried, right or wrong. Each person has one token at each of our sites: a new one ends the
// last (design §6.7).
export async function exchangeCode(req: TokenRequest) {
  const app =
    req.client_id &&
    req.client_secret &&
    (await db
      .selectFrom("oauth_clients")
      .select(["id", "name"])
      .where("client_id", "=", req.client_id)
      .where("secret_hash", "=", hashToken(req.client_secret))
      .where("disabled_at", "is", null)
      .executeTakeFirst());
  if (!app) throw new AppError(401, "invalid_client", "应用不存在、密钥不对或应用已停用");
  if (req.grant_type !== "authorization_code") {
    throw new AppError(400, "unsupported_grant_type", "只支持 authorization_code");
  }
  const grant =
    req.code &&
    (await db
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
    throw new AppError(400, "invalid_grant", "授权码不对、已过期或已用过，或者和授权时的对不上");
  }

  const token = newToken();
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("api_tokens")
      .set({ revoked_at: new Date() })
      .where("user_id", "=", grant.user_id)
      .where("client_id", "=", app.id)
      .where("revoked_at", "is", null)
      .execute();
    await trx
      .insertInto("api_tokens")
      .values({
        name: app.name,
        token_hash: hashToken(token),
        scopes: grant.scopes,
        user_id: grant.user_id,
        client_id: app.id,
      })
      .execute();
  });
  return { access_token: token, token_type: "Bearer", scope: grant.scopes.join(" ") };
}
