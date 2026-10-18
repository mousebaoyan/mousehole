import { createMiddleware } from "hono/factory";
import { sql } from "kysely";
import { db } from "./db.ts";
import { AppError } from "./errors.ts";
import type { AppEnv } from "./http.ts";

// Bot POSTs with an Idempotency-Key run once; repeats get the first response. See docs/api.md §2.4.
export const idempotency = createMiddleware<AppEnv>(async (c, next) => {
  const key = c.req.header("idempotency-key");
  const bot = c.var.bot;
  if (key === undefined || !bot || c.req.method !== "POST") return next();
  if (key.length === 0 || key.length > 128) {
    throw new AppError(400, "invalid_request", "Idempotency-Key：长度应为 1–128 个字符");
  }

  const { method, path } = c.req;
  const id = { token_id: bot.tokenId, key };
  // Claims the key when it is new, older than 7 days, or its first run stopped 5 minutes ago.
  const claimed = await db
    .insertInto("idempotency_keys")
    .values({ ...id, method, path })
    .onConflict((oc) =>
      oc
        .columns(["token_id", "key"])
        .doUpdateSet({ method, path, status: null, response: null, created_at: sql`now()` })
        .where((eb) =>
          eb.or([
            eb("idempotency_keys.created_at", "<", sql<Date>`now() - interval '7 days'`),
            eb.and([
              eb("idempotency_keys.status", "is", null),
              eb("idempotency_keys.created_at", "<", sql<Date>`now() - interval '5 minutes'`),
            ]),
          ]),
        ),
    )
    .returning("key")
    .executeTakeFirst();

  if (!claimed) {
    const first = await db
      .selectFrom("idempotency_keys")
      .select(["method", "path", "status", "response"])
      .where((eb) => eb.and(id))
      .executeTakeFirstOrThrow();
    if (first.method !== method || first.path !== path) {
      throw new AppError(422, "idempotency_key_reused", "这个 Idempotency-Key 已经用在别的接口上");
    }
    if (first.status === null) {
      throw new AppError(409, "idempotency_in_progress", "同一个请求还在处理，请稍后重试");
    }
    return first.response === null
      ? new Response(null, { status: first.status })
      : Response.json(first.response, { status: first.status });
  }

  await next();
  const { status } = c.res;
  // An error did nothing, and the bot may send it again put right: forget the key so a retry
  // runs again.
  if (status >= 400) {
    await db
      .deleteFrom("idempotency_keys")
      .where((eb) => eb.and(id))
      .execute();
    return;
  }
  const json = c.res.headers.get("content-type")?.startsWith("application/json");
  const body = json ? await c.res.clone().text() : null;
  await db
    .updateTable("idempotency_keys")
    .set({ status, response: body === null ? null : sql`${body}::jsonb` })
    .where((eb) => eb.and(id))
    .execute();
});

// Daily: keys older than the 7 days a retry is answered from.
export async function clearIdempotencyKeys() {
  await db
    .deleteFrom("idempotency_keys")
    .where("created_at", "<", sql<Date>`now() - interval '7 days'`)
    .execute();
}
