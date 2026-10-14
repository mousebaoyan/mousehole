import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };
type Person = { id: number; who: Who };

async function person() {
  const { id } = await createUser();
  return { id, who: as(await login(id)) };
}

let author: Person;
let replier: Person;
let other: Person;

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "n", name: "通知" } }, admin);
  [author, replier, other] = await Promise.all([person(), person(), person()]);
});

async function thread(who: Who) {
  const res = await api.threads.$post(
    { json: { board: "n", title: "等通知的帖子", content: { markdown: "主楼" } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id } = await res.json();
  const posts = await api.threads[":id"].posts.$get({ param: { id: String(id) }, query: {} });
  if (!posts.ok) throw new Error(`status ${posts.status}`);
  return { id, opening: (await posts.json()).items[0].id };
}

async function reply(who: Who, threadId: number, markdown: string, reply_to_id?: number) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown }, reply_to_id } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

// Each notification as type, who did it last and how many times.
async function inbox(who: Who) {
  const res = await api.notifications.$get({ query: {} }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map(
    (n) =>
      `${n.type}:${n.actor && "id" in n.actor ? n.actor.id : n.actor?.display_name}x${n.count}`,
  );
}

async function clear(...people: Person[]) {
  await Promise.all(
    people.map((p) => api.notifications.read.$post({ json: { all: true } }, p.who)),
  );
  await db.deleteFrom("notifications").execute();
}

describe("通知", () => {
  test("回复、@、关注的帖子有新楼层：每人只收到一条，自己做的不通知；新楼层按帖子合并", async () => {
    const watcher = await person();
    const t = await thread(author.who);
    await api.threads[":id"].subscription.$put(
      { param: { id: String(t.id) }, json: { level: "watching" } },
      watcher.who,
    );
    await reply(replier.who, t.id, `同问 [@某人](/u/${other.id})`, t.opening);
    expect(await inbox(author.who)).toEqual([`reply:${replier.id}x1`]);
    expect(await inbox(other.who)).toEqual([`mention:${replier.id}x1`]);
    expect(await inbox(watcher.who)).toEqual([`watching:${replier.id}x1`]);
    expect(await inbox(replier.who)).toEqual([]);

    await reply(other.who, t.id, "我也来");
    expect(await inbox(watcher.who)).toEqual([`watching:${other.id}x2`]);
    expect(await inbox(author.who)).toEqual([`watching:${other.id}x1`, `reply:${replier.id}x1`]);
    await clear(author, replier, other, watcher);
  });

  test("点赞和短评按楼层合并，最近的人在前；改表情不再通知", async () => {
    const t = await thread(author.who);
    const param = { id: String(t.opening) };
    await api.posts[":id"].reaction.$put({ param, json: { emoji: "heart" } }, replier.who);
    await api.posts[":id"].reaction.$put({ param, json: { emoji: "clap" } }, other.who);
    await api.posts[":id"].reaction.$put({ param, json: { emoji: "tada" } }, other.who);
    await api.posts[":id"].boost.$put({ param, json: { body: "学到了" } }, replier.who);
    expect(await inbox(author.who)).toEqual([`boost:${replier.id}x1`, `like:${other.id}x2`]);
    await clear(author);
  });

  test("静音的帖子、冻结的人、关掉的类型都不通知；关注的人发新帖会通知", async () => {
    const t = await thread(author.who);
    await api.threads[":id"].subscription.$put(
      { param: { id: String(t.id) }, json: { level: "muted" } },
      author.who,
    );
    await reply(replier.who, t.id, "回复静音的人", t.opening);
    expect(await inbox(author.who)).toEqual([]);

    const frozen = await person();
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", frozen.id)
      .execute();
    await reply(replier.who, t.id, `[@已退群](/u/${frozen.id})`);
    expect(
      await db.selectFrom("notifications").select("id").where("user_id", "=", frozen.id).execute(),
    ).toEqual([]);

    await db
      .updateTable("users")
      .set({ notify_prefs: { like: { site: false } } })
      .where("id", "=", author.id)
      .execute();
    await api.posts[":id"].reaction.$put(
      { param: { id: String(t.opening) }, json: { emoji: "heart" } },
      other.who,
    );
    expect(await inbox(author.who)).toEqual([]);

    await api.users[":user"].follow.$put({ param: { user: String(author.id) } }, other.who);
    await thread(author.who);
    expect(await inbox(other.who)).toEqual([`following:${author.id}x1`]);
    await clear(author, replier, other);
  });

  test("未读数、只看未读、标为已读", async () => {
    const t = await thread(author.who);
    const first = await reply(replier.who, t.id, "第一条", t.opening);
    await reply(replier.who, t.id, `[@楼主](/u/${author.id})`);
    const count = async () => {
      const res = await api.notifications["unread-count"].$get({}, author.who);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).count;
    };
    expect(await count()).toBe(2);

    const list = await api.notifications.$get({ query: {} }, author.who);
    if (!list.ok) throw new Error(`status ${list.status}`);
    const items = (await list.json()).items;
    const reply1 = items.find((n) => n.post?.id === first);
    if (!reply1) throw new Error("reply notification missing");
    expect(reply1).toMatchObject({ type: "reply", thread: { id: t.id }, excerpt: "第一条" });
    await api.notifications.read.$post({ json: { ids: [reply1.id] } }, author.who);
    expect(await count()).toBe(1);
    const unread = await api.notifications.$get({ query: { unread_only: "true" } }, author.who);
    if (!unread.ok) throw new Error(`status ${unread.status}`);
    expect((await unread.json()).items.map((n) => n.type)).toEqual(["mention"]);

    await api.notifications.read.$post({ json: { all: true } }, author.who);
    expect(await count()).toBe(0);
  });
});
