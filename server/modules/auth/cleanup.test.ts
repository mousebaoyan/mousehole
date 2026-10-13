import { describe, expect, test } from "vitest";
import { createUser } from "../../../test/fixtures.ts";
import { db } from "../../platform/db.ts";
import { clearExpiredLogins } from "./service.ts";

describe("每天清理", () => {
  test("过期的会话、登录口令和链接、邮件验证码删掉，没过期的留着", async () => {
    const { id } = await createUser();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    await db
      .insertInto("sessions")
      .values([
        { token_hash: Buffer.from("expired"), user_id: id, expires_at: past },
        { token_hash: Buffer.from("live"), user_id: id, expires_at: future },
      ])
      .execute();
    await db
      .insertInto("login_tickets")
      .values({ kind: "link", secret_hash: Buffer.from("old link"), user_id: id, expires_at: past })
      .execute();
    await db
      .insertInto("email_codes")
      .values({ user_id: id, code: "123456", expires_at: past })
      .execute();

    await clearExpiredLogins();

    const sessions = await db.selectFrom("sessions").select("token_hash").execute();
    expect(sessions.map((s) => s.token_hash.toString())).toEqual(["live"]);
    expect(await db.selectFrom("login_tickets").select("id").execute()).toEqual([]);
    expect(await db.selectFrom("email_codes").select("user_id").execute()).toEqual([]);
  });
});
