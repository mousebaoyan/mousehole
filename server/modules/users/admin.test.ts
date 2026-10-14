import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who = as("");
let adminId = 0;
let moderator: Who = as("");

beforeAll(async () => {
  const a = await createUser("admin");
  adminId = a.id;
  admin = as(await login(a.id));
  moderator = as(await login((await createUser("moderator")).id));
});

async function named(display_name: string) {
  const user = await createUser();
  await db.updateTable("users").set({ display_name }).where("id", "=", user.id).execute();
  return user;
}

async function members(query: Record<string, string>, who: Who = moderator) {
  const res = await api.admin.members.$get({ query }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((m) => m.display_name);
}

describe("后台的成员页", () => {
  test("按名字或 QQ 号找，按受限筛选", async () => {
    const owl = await named("夜猫子-清华");
    await named("早起鸟");
    expect(await members({ q: "夜猫" })).toEqual(["夜猫子-清华"]);
    expect(await members({ q: String(owl.qq) })).toEqual(["夜猫子-清华"]);

    await db.updateTable("users").set({ restriction: "mute" }).where("id", "=", owl.id).execute();
    expect(await members({ restricted: "true" })).toEqual(["夜猫子-清华"]);
  });

  test("管理员设置角色：锁定，记日志；不能改自己和 bot；版主不能设置", async () => {
    const user = await named("要当版主的人");
    const param = { user: String(user.id) };
    const set = await api.users[":user"].$patch({ param, json: { role: "moderator" } }, admin);
    expect(set.status).toBe(204);
    const row = await db
      .selectFrom("users")
      .select(["role", "role_locked"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ role: "moderator", role_locked: true });

    const logs = await api.admin["audit-logs"].$get(
      { query: { action: "member.role" } },
      await ownerSession(),
    );
    if (!logs.ok) throw new Error(`status ${logs.status}`);
    expect((await logs.json()).items[0]).toMatchObject({
      target_id: user.id,
      data: { from: "user", to: "moderator" },
      actor: { id: adminId },
    });

    const self = { user: String(adminId) };
    expect(
      (await api.users[":user"].$patch({ param: self, json: { role: "user" } }, admin)).status,
    ).toBe(403);
    expect(
      (await api.users[":user"].$patch({ param, json: { role: null } }, moderator)).status,
    ).toBe(403);
    expect((await api.admin["audit-logs"].$get({ query: {} }, moderator)).status).toBe(403);
  });
});
