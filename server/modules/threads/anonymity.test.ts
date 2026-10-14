import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

const people = {
  admin: as(""),
  moderator: as(""),
  author: as(""),
  first: as(""),
  second: as(""),
  follower: as(""),
};
const ids = { author: 0, first: 0 };

beforeAll(async () => {
  for (const role of ["admin", "moderator"] as const) {
    people[role] = as(await login((await createUser(role)).id));
  }
  for (const name of ["author", "first", "second", "follower"] as const) {
    const { id } = await createUser();
    if (name === "author" || name === "first") ids[name] = id;
    people[name] = as(await login(id));
  }
  await api.boards.$post({ json: { slug: "anon", name: "匿名" } }, people.admin);
  await api.users[":user"].follow.$put({ param: { user: String(ids.author) } }, people.follower);
});

async function newThread(json: { anonymous?: boolean; anonymous_replies?: boolean }) {
  const res = await api.threads.$post(
    { json: { board: "anon", title: "匿名测试的帖子", content: { markdown: "主楼" }, ...json } },
    people.author,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function reply(thread: number, who: Who, markdown: string, replyTo?: number) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(thread) }, json: { content: { markdown }, reply_to_id: replyTo } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function floors(thread: number, who: Who) {
  const res = await api.threads[":id"].posts.$get(
    { param: { id: String(thread) }, query: {} },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

async function detail(thread: number, who: Who) {
  const res = await api.threads[":id"].$get({ param: { id: String(thread) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function counts(user: number) {
  return db
    .selectFrom("users")
    .select(["thread_count", "post_count"])
    .where("id", "=", user)
    .executeTakeFirstOrThrow();
}

const anonymous = (number: number) => ({
  anonymous: true,
  number,
  display_name: `匿名鼠 ${number}`,
});

describe("匿名", () => {
  test("楼主匿名：楼主是 1 号，回复的人按出现顺序编号，同一个人编号不变；只有本人知道自己的编号", async () => {
    const thread = await newThread({ anonymous: true, anonymous_replies: true });
    const [opening] = await floors(thread, people.first);
    await reply(thread, people.first, "我是第一个", opening.id);
    await reply(thread, people.second, "我是第二个");
    await reply(thread, people.first, "我又来了");
    await reply(thread, people.author, "楼主回复");

    const authors = (await floors(thread, people.second)).map((p) => p.author);
    expect(authors).toEqual([1, 2, 3, 2, 1].map(anonymous));
    expect((await floors(thread, people.second))[1].reply_to?.author).toEqual(anonymous(1));
    expect(await detail(thread, people.first)).toMatchObject({
      author: anonymous(1),
      author_anonymous: true,
      anonymous_replies: true,
      my_alias: 2,
    });
    expect((await detail(thread, people.follower)).my_alias).toBeNull();
  });

  test("匿名的帖子不在本人主页和按楼主搜索里，也不通知关注的人；回复我的通知里是编号", async () => {
    const thread = await newThread({ anonymous: true });
    const mine = await api.users[":user"].threads.$get({
      param: { user: String(ids.author) },
      query: {},
    });
    if (!mine.ok) throw new Error(`status ${mine.status}`);
    expect((await mine.json()).items.map((t) => t.id)).not.toContain(thread);

    const found = await api.search.$get({
      query: { q: "匿名测试", author: String(ids.author) },
    });
    if (!found.ok) throw new Error(`status ${found.status}`);
    expect((await found.json()).items.map((r) => r.thread.id)).not.toContain(thread);

    const followed = await db
      .selectFrom("notifications")
      .select("id")
      .where("thread_id", "=", thread)
      .where("type", "=", "following")
      .execute();
    expect(followed).toEqual([]);

    // The author answers someone: they hear it from 1 号.
    const theirs = await reply(thread, people.first, "公开的回复");
    await reply(thread, people.author, "楼主回你", theirs.id);
    const inbox = await api.notifications.$get({ query: {} }, people.first);
    if (!inbox.ok) throw new Error(`status ${inbox.status}`);
    expect((await inbox.json()).items[0]).toMatchObject({ type: "reply", actor: anonymous(1) });
  });

  test("匿名的帖子和回复不算进本人的发帖数和回复数，删除时也不减", async () => {
    const before = { author: await counts(ids.author), first: await counts(ids.first) };
    const thread = await newThread({ anonymous: true, anonymous_replies: true });
    const { id } = await reply(thread, people.first, "匿名回复");
    expect(await counts(ids.author)).toEqual(before.author);
    expect(await counts(ids.first)).toEqual(before.first);

    const deleted = [
      await api.posts[":id"].$delete({ param: { id: String(id) } }, people.first),
      await api.threads[":id"].$delete({ param: { id: String(thread) } }, people.author),
    ];
    expect(deleted.map((res) => res.status)).toEqual([204, 204]);
    expect(await counts(ids.author)).toEqual(before.author);
    expect(await counts(ids.first)).toEqual(before.first);
  });

  test("回复匿名、楼主公开：楼主自己回复照常实名，别人匿名；短评跟着匿名", async () => {
    const thread = await newThread({ anonymous_replies: true });
    const answer = await reply(thread, people.first, "匿名的回答");
    await reply(thread, people.author, "楼主实名回复");
    await api.posts[":id"].boost.$put(
      { param: { id: String(answer.id) }, json: { body: "顶" } },
      people.second,
    );
    const [opening, first, second] = await floors(thread, people.follower);
    expect(opening.author).toMatchObject({ id: ids.author });
    expect(first.author).toEqual(anonymous(1));
    expect(first.boosts.map((b) => b.user)).toEqual([anonymous(2)]);
    expect(second.author).toMatchObject({ id: ids.author });
  });

  test("管理员可以查看匿名的人是谁，记操作日志；版主不行", async () => {
    const thread = await newThread({ anonymous: true, anonymous_replies: true });
    await reply(thread, people.first, "我是 2 号");
    const param = { id: String(thread) };
    expect((await api.threads[":id"].aliases.$get({ param }, people.moderator)).status).toBe(403);

    const res = await api.threads[":id"].aliases.$get({ param }, people.admin);
    if (!res.ok) throw new Error(`status ${res.status}`);
    expect((await res.json()).items).toMatchObject([
      { number: 1, user: { id: ids.author } },
      { number: 2, user: { id: ids.first } },
    ]);
    const logged = await db
      .selectFrom("audit_logs")
      .select("action")
      .where("target_type", "=", "thread")
      .where("target_id", "=", thread)
      .where("action", "=", "thread.reveal")
      .execute();
    expect(logged).toHaveLength(1);
  });
});
