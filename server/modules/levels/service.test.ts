import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { promoteActive, recheckL4 } from "./service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };
type Person = { id: number; who: Who };

// From L0, unless the level doesn't matter.
async function person(role: "user" | "admin" = "user", level = 0) {
  const { id } = await createUser(role, level);
  return { id, who: as(await login(id)) };
}

let admin: Person;
let other: Person;

beforeAll(async () => {
  admin = await person("admin");
  other = await person("user", 1);
  await api.boards.$post({ json: { slug: "lv", name: "等级" } }, admin.who);
});

async function thread(who: Who) {
  const res = await api.threads.$post(
    { json: { board: "lv", title: "聊聊等级的事", content: { markdown: "主楼" } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function reply(who: Who, threadId: number) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown: "回复" } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function levelOf(id: number) {
  const row = await db
    .selectFrom("users")
    .select("level")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row.level;
}

// What L1 needs: threads entered and floors read, as the reading reports leave them.
async function readEnough(id: number) {
  // By someone new each time, who stays under the hourly limit on threads.
  const author = await person("user", 1);
  const threads = await Promise.all(Array.from({ length: 10 }, () => thread(author.who)));
  await db
    .insertInto("thread_users")
    .values(threads.map((t) => ({ user_id: id, thread_id: t, last_read_at: new Date() })))
    .execute();
  await db.updateTable("users").set({ posts_read: 60 }).where("id", "=", id).execute();
  return threads;
}

function since(days: number) {
  return sql<Date>`now() - make_interval(days => ${days})`;
}

async function progress(of: number, who: Who) {
  const res = await api.users[":user"].level.$get({ param: { user: String(of) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("等级", () => {
  test("活跃的人够了条件就升级并收到通知；回复自己的、删掉了的帖子不算", async () => {
    const me = await person();
    const threads = await readEnough(me.id);
    await reply(me.who, await thread(me.who));
    const deleted = await thread(admin.who);
    await reply(me.who, deleted);
    await api.threads[":id"].$delete({ param: { id: String(deleted) } }, admin.who);
    for (const t of threads.slice(0, 9)) await reply(me.who, t);
    const liked = await reply(me.who, threads[0]);
    await api.posts[":id"].reaction.$put(
      { param: { id: String(liked) }, json: { emoji: "heart" } },
      other.who,
    );
    await db
      .updateTable("users")
      .set((eb) => ({ like_received: eb("like_received", "+", 4) }))
      .where("id", "=", me.id)
      .execute();

    // Nine other people's threads: still L1, short of L2.
    await promoteActive();
    expect(await levelOf(me.id)).toBe(1);
    expect((await progress(me.id, me.who)).next?.items).toContainEqual(
      expect.objectContaining({ key: "threads_replied", have: 9, need: 10 }),
    );

    await reply(me.who, threads[9]);
    await promoteActive();
    expect(await levelOf(me.id)).toBe(2);
    const inbox = await api.notifications.$get({ query: {} }, me.who);
    if (!inbox.ok) throw new Error(`status ${inbox.status}`);
    expect((await inbox.json()).items.filter((n) => n.type === "level")).toMatchObject([
      { data: { level: "2" }, thread: null },
      { data: { level: "1" } },
    ]);
  });

  test("一次升两级：从 L0 直接到 L2", async () => {
    const me = await person();
    const threads = await readEnough(me.id);
    for (const t of threads) await reply(me.who, t);
    await db.updateTable("users").set({ like_received: 5 }).where("id", "=", me.id).execute();
    await promoteActive();
    expect(await levelOf(me.id)).toBe(2);
  });

  test("L4 每天复查，最近 50 天不够就降回 L3；刚升两周内和锁定的不降", async () => {
    const [lapsed, fresh, locked] = await Promise.all([person(), person(), person()]);
    await db
      .updateTable("users")
      .set({ level: 4, level_since: since(20) })
      .where("id", "=", lapsed.id)
      .execute();
    await db
      .updateTable("users")
      .set({ level: 4, level_since: since(3) })
      .where("id", "=", fresh.id)
      .execute();
    await db
      .updateTable("users")
      .set({ level: 4, level_since: since(20), level_locked: true })
      .where("id", "=", locked.id)
      .execute();
    await recheckL4();
    expect([await levelOf(lapsed.id), await levelOf(fresh.id), await levelOf(locked.id)]).toEqual([
      3, 4, 4,
    ]);
  });

  test("禁言过后 50 天内不算满足 L4；进度只给本人和管理员看", async () => {
    const me = await person();
    await db.updateTable("users").set({ level: 3 }).where("id", "=", me.id).execute();
    const days = async () =>
      (await progress(me.id, admin.who)).next?.items.find((i) => i.key === "clean_days")?.have;
    expect(await days()).toBe(50);

    const moderator = await person("admin");
    await api.users[":user"].restriction.$put(
      { param: { user: String(me.id) }, json: { type: "mute", until: null, reason: "测试" } },
      moderator.who,
    );
    expect(await days()).toBe(0);
    await api.users[":user"].restriction.$delete(
      { param: { user: String(me.id) }, json: {} },
      moderator.who,
    );
    expect(await days()).toBe(0);

    const res = await api.users[":user"].level.$get({ param: { user: String(me.id) } }, other.who);
    expect(res.status).toBe(403);
  });

  test("管理员设定等级并锁定，记操作日志；锁定后不再自动变", async () => {
    const me = await person();
    const param = { user: String(me.id) };
    const denied = await api.users[":user"].level.$put(
      { param, json: { level: 5, locked: false } },
      other.who,
    );
    expect(denied.status).toBe(403);
    await api.users[":user"].level.$put({ param, json: { level: 1, locked: true } }, admin.who);
    for (const t of await readEnough(me.id)) await reply(me.who, t);
    await db.updateTable("users").set({ like_received: 5 }).where("id", "=", me.id).execute();
    await promoteActive();
    expect(await progress(me.id, me.who)).toEqual({ level: 1, locked: true, next: null });
    const logged = await db
      .selectFrom("audit_logs")
      .select("data")
      .where("action", "=", "user.level")
      .where("target_id", "=", me.id)
      .execute();
    expect(logged).toMatchObject([{ data: { from: 0, to: 1, locked: true } }]);
  });
});
