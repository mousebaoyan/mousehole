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

function patch(user: number, role: "user" | "admin" | null, who: Who) {
  return api.users[":user"].$patch({ param: { user: String(user) }, json: { role } }, who);
}

function roleOf(id: number) {
  return db
    .selectFrom("users")
    .select(["role", "role_locked"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
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

  test("按激活、邮件开关和最近访问筛选，按列排序，没有的值排在最后", async () => {
    const day = 24 * 3600_000;
    const people = [
      { name: "排序甲", activated: true, seen: Date.now(), posts: 5, email: true },
      { name: "排序乙", activated: false, seen: null, posts: 9, email: false },
      { name: "排序丙", activated: true, seen: Date.now() - 40 * day, posts: 1, email: true },
    ];
    for (const p of people) {
      const { id } = await named(p.name);
      await db
        .updateTable("users")
        .set({
          activated_at: p.activated ? new Date() : null,
          last_seen_at: p.seen === null ? null : new Date(p.seen),
          post_count: p.posts,
          notify_email: p.email,
        })
        .where("id", "=", id)
        .execute();
    }
    const q = "排序";
    expect(await members({ q, activated: "false" })).toEqual(["排序乙"]);
    expect(await members({ q, email: "false" })).toEqual(["排序乙"]);
    expect(await members({ q, seen_within: "7" })).toEqual(["排序甲"]);
    expect(await members({ q, unseen_for: "30" })).toEqual(["排序丙", "排序乙"]);
    expect(await members({ q, sort: "post_count" })).toEqual(["排序乙", "排序甲", "排序丙"]);
    expect(await members({ q, sort: "post_count", order: "asc" })).toEqual([
      "排序丙",
      "排序甲",
      "排序乙",
    ]);
    expect(await members({ q, sort: "last_seen_at" })).toEqual(["排序甲", "排序丙", "排序乙"]);
    expect(await members({ q, sort: "last_seen_at", order: "asc" })).toEqual([
      "排序丙",
      "排序甲",
      "排序乙",
    ]);
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

  test("任免管理员只有站长能做：设为管理员、改管理员、解锁后会变成管理员的", async () => {
    const plain = await named("普通成员");
    const other = await createUser("admin");
    const groupOwner = await named("群主");
    // The group owner, kept a moderator by hand: unlocking would make them an admin.
    const groupId = 900_000 + groupOwner.id;
    await db.insertInto("qq_groups").values({ id: groupId, name: "测试群" }).execute();
    await db
      .insertInto("group_members")
      .values({ group_id: groupId, user_id: groupOwner.id, role: "owner", observed_at: new Date() })
      .execute();
    await db
      .updateTable("users")
      .set({ role: "moderator", role_locked: true })
      .where("id", "=", groupOwner.id)
      .execute();

    expect((await patch(plain.id, "admin", admin)).status).toBe(403);
    expect((await patch(other.id, "user", admin)).status).toBe(403);
    expect((await patch(groupOwner.id, null, admin)).status).toBe(403);
    expect(await roleOf(groupOwner.id)).toEqual({ role: "moderator", role_locked: true });

    const owner = await ownerSession();
    expect((await patch(plain.id, "admin", owner)).status).toBe(204);
    expect((await patch(other.id, "user", owner)).status).toBe(204);
    expect((await patch(groupOwner.id, null, owner)).status).toBe(204);
    expect(await roleOf(groupOwner.id)).toEqual({ role: "admin", role_locked: false });
    const logs = await db
      .selectFrom("audit_logs")
      .select(["action", "data"])
      .where("target_type", "=", "user")
      .where("target_id", "=", groupOwner.id)
      .orderBy("id")
      .execute();
    expect(logs).toEqual([
      { action: "member.role_unlock", data: {} },
      { action: "member.role", data: { from: "moderator", to: "admin" } },
    ]);
  });
});
