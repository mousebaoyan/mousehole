import { sql } from "kysely";
import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

const guest: Who = { headers: {} };
let admin: Who = as("");
let moderator: Who = as("");
let author: { id: number; who: Who } = { id: 0, who: as("") };
let other: Who = as("");
let lastSlug = 0;

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  moderator = as(await login((await createUser("moderator")).id));
  const user = await createUser();
  author = { id: user.id, who: as(await login(user.id)) };
  other = as(await login((await createUser()).id));
});

async function newBoard(review_mode: "after" | "before") {
  const slug = `r${++lastSlug}`;
  const res = await api.boards.$post(
    { json: { slug, name: `审核${lastSlug}`, review_mode } },
    admin,
  );
  expect(res.status).toBe(201);
  return slug;
}

async function newThread(board: string, title = "夏令营材料清单") {
  const res = await api.threads.$post(
    { json: { board, title, content: { markdown: "正文" } } },
    author.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function reply(thread: number, who: Who = author.who) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(thread) }, json: { content: { markdown: "回复" } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function setThread(thread: number, status: "visible" | "hidden", who = moderator, reason?: string) {
  return api.threads[":id"].$patch(
    { param: { id: String(thread) }, json: { status, reason } },
    who,
  );
}

function setPost(post: number, status: "visible" | "hidden", reason?: string) {
  return api.posts[":id"].$patch(
    { param: { id: String(post) }, json: { status, reason } },
    moderator,
  );
}

function remove(path: "posts" | "threads", id: number) {
  return api[path][":id"].$delete({ param: { id: String(id) } }, moderator);
}

async function counts(slug: string, thread: number) {
  const board = await db
    .selectFrom("boards")
    .select(["thread_count", "post_count"])
    .where("slug", "=", slug)
    .executeTakeFirstOrThrow();
  const { reply_count } = await db
    .selectFrom("threads")
    .select("reply_count")
    .where("id", "=", thread)
    .executeTakeFirstOrThrow();
  return { threads: board.thread_count, posts: board.post_count, replies: reply_count };
}

// Events of a type whose data contains `match`.
function events(type: string, match: object) {
  return db
    .selectFrom("events")
    .select("data")
    .where("type", "=", type)
    .where(sql<boolean>`data @> ${JSON.stringify(match)}::jsonb`)
    .execute();
}

async function found(q: string) {
  const res = await api.search.$get({ query: { q } }, other);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((r) => r.thread.id);
}

async function lastNotice(who: Who) {
  const res = await api.notifications.$get({ query: {} }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items[0];
}

async function floors(thread: number, who: Who) {
  const res = await api.threads[":id"].posts.$get(
    { param: { id: String(thread) }, query: {} },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((p) => [p.floor, p.status]);
}

describe("先审后发", () => {
  test("成员发的帖子等待审核：只有作者和版主能看到，不计数，插件收到 content.pending", async () => {
    const board = await newBoard("before");
    const thread = await newThread(board);
    expect(thread.status).toBe("pending");

    const open = (who: Who) => api.threads[":id"].$get({ param: { id: String(thread.id) } }, who);
    expect((await open(author.who)).status).toBe(200);
    expect((await open(moderator)).status).toBe(200);
    expect((await open(other)).status).toBe(404);
    expect((await open(guest)).status).toBe(404);
    const list = await api.threads.$get({ query: { board } }, other);
    if (!list.ok) throw new Error(`status ${list.status}`);
    expect((await list.json()).items).toEqual([]);
    expect(await counts(board, thread.id)).toEqual({ threads: 0, posts: 0, replies: 0 });

    const about = { thread: { id: thread.id } };
    expect(await events("content.pending", about)).toHaveLength(1);
    expect(await events("thread.created", about)).toHaveLength(0);
    // Not even its author can reply before it is published.
    const early = await api.threads[":id"].posts.$post(
      { param: { id: String(thread.id) }, json: { content: { markdown: "补充" } } },
      author.who,
    );
    expect(early.status).toBe(403);
  });

  test("版主通过后才公开：计数、列表、搜索、事件都在这时加上，作者收到通知", async () => {
    const board = await newBoard("before");
    const thread = await newThread(board, "华东师范大学推免经验");
    expect(await found("华东师范")).not.toContain(thread.id);

    expect((await setThread(thread.id, "visible", author.who)).status).toBe(403);
    const res = await setThread(thread.id, "visible");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "visible" });
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 0, replies: 0 });
    expect(await found("华东师范")).toContain(thread.id);
    expect(await lastNotice(author.who)).toMatchObject({
      type: "moderation",
      data: { action: "approve" },
    });
    expect(await events("thread.created", { thread: { id: thread.id } })).toHaveLength(1);
  });

  test("回复照常占楼层号，别人看到的楼层跳过它；通过后才算进回复数", async () => {
    const board = await newBoard("before");
    const thread = await newThread(board);
    await setThread(thread.id, "visible");
    const pending = await reply(thread.id);
    const visible = await reply(thread.id, moderator);
    expect([pending.floor, pending.status]).toEqual([2, "pending"]);
    expect([visible.floor, visible.status]).toEqual([3, "visible"]);
    expect(await floors(thread.id, other)).toEqual([
      [1, "visible"],
      [3, "visible"],
    ]);
    expect(await floors(thread.id, author.who)).toHaveLength(3);
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 1, replies: 1 });

    expect((await setPost(pending.id, "visible")).status).toBe(200);
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 2, replies: 2 });
    expect(await events("post.created", { post: { id: pending.id } })).toHaveLength(1);
  });
});

describe("隐藏和恢复", () => {
  test("隐藏一层回复：从计数里扣掉，插件收到带理由的 post.deleted，作者收到通知；恢复后加回来，不再发 post.created", async () => {
    const board = await newBoard("after");
    const thread = await newThread(board);
    const post = await reply(thread.id);
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 1, replies: 1 });

    expect((await setPost(post.id, "hidden", "广告")).status).toBe(200);
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 0, replies: 0 });
    expect(await floors(thread.id, other)).toEqual([[1, "visible"]]);
    expect(await events("post.deleted", { post_id: post.id, reason: "广告" })).toHaveLength(1);
    expect(await lastNotice(author.who)).toMatchObject({
      type: "moderation",
      data: { action: "hide", reason: "广告" },
    });

    expect((await setPost(post.id, "visible")).status).toBe(200);
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 1, replies: 1 });
    expect(await events("post.created", { post: { id: post.id } })).toHaveLength(1);
  });

  test("从群里收录的楼层和帖子，隐藏、恢复都不通知作者", async () => {
    const board = await newBoard("after");
    const thread = await newThread(board);
    const post = await reply(thread.id);
    await db.updateTable("posts").set({ via: "qq" }).where("thread_id", "=", thread.id).execute();

    expect((await setPost(post.id, "hidden", "串台")).status).toBe(200);
    expect((await setPost(post.id, "visible")).status).toBe(200);
    expect((await setThread(thread.id, "hidden", moderator, "串台")).status).toBe(200);
    expect((await setThread(thread.id, "visible")).status).toBe(200);
    const notices = await db
      .selectFrom("notifications")
      .select("id")
      .where("user_id", "=", author.id)
      .where("thread_id", "=", thread.id)
      .execute();
    expect(notices).toEqual([]);
  });

  test("隐藏的帖子里删掉回复、再删掉帖子，计数不会重复扣", async () => {
    const board = await newBoard("after");
    const thread = await newThread(board);
    const first = await reply(thread.id);
    await reply(thread.id);
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 2, replies: 2 });

    await setThread(thread.id, "hidden", moderator, "重复");
    expect(await counts(board, thread.id)).toEqual({ threads: 0, posts: 0, replies: 2 });
    await api.posts[":id"].$delete({ param: { id: String(first.id) } }, moderator);
    expect(await counts(board, thread.id)).toEqual({ threads: 0, posts: 0, replies: 1 });

    await setThread(thread.id, "visible");
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 1, replies: 1 });
    await setThread(thread.id, "hidden");
    await api.threads[":id"].$delete({ param: { id: String(thread.id) } }, moderator);
    expect(await counts(board, thread.id)).toEqual({ threads: 0, posts: 0, replies: 1 });
  });

  test("几个人同时隐藏、删除同一层，或者同时删除同一个帖子，计数只扣一次", async () => {
    const board = await newBoard("after");
    const thread = await newThread(board);
    const post = await reply(thread.id);
    await reply(thread.id);
    await Promise.all([
      setPost(post.id, "hidden", "广告"),
      setPost(post.id, "hidden", "广告"),
      remove("posts", post.id),
    ]);
    expect(await counts(board, thread.id)).toEqual({ threads: 1, posts: 1, replies: 1 });

    await Promise.all([remove("threads", thread.id), remove("threads", thread.id)]);
    expect(await counts(board, thread.id)).toEqual({ threads: 0, posts: 0, replies: 1 });
  });

  test("主楼随帖子改状态；帖子隐藏时不能回复，也不能单独改回复的状态", async () => {
    const board = await newBoard("after");
    const thread = await newThread(board);
    const post = await reply(thread.id);
    const opening = await db
      .selectFrom("posts")
      .select("id")
      .where("thread_id", "=", thread.id)
      .where("floor", "=", 1)
      .executeTakeFirstOrThrow();
    expect((await setPost(opening.id, "hidden")).status).toBe(400);

    await setThread(thread.id, "hidden");
    expect(await floors(thread.id, author.who)).toEqual([
      [1, "hidden"],
      [2, "visible"],
    ]);
    expect((await setPost(post.id, "hidden")).status).toBe(403);
    const res = await api.threads[":id"].posts.$post(
      { param: { id: String(thread.id) }, json: { content: { markdown: "还在吗" } } },
      author.who,
    );
    expect(res.status).toBe(403);
  });
});

describe("后台的内容页", () => {
  test("版主按状态列出待审核和已隐藏的内容，帖子以主楼出现", async () => {
    const before = await newBoard("before");
    const pending = await newThread(before, "等待审核的帖子");
    const after = await newBoard("after");
    const shown = await newThread(after);
    const hidden = await reply(shown.id);
    await setPost(hidden.id, "hidden");

    const list = async (status: "pending" | "hidden") => {
      const res = await api.admin.content.$get({ query: { status } }, moderator);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items;
    };
    expect((await list("pending")).find((i) => i.thread_id === pending.id)).toMatchObject({
      floor: 1,
      title: "等待审核的帖子",
      board: { slug: before },
    });
    expect((await list("hidden")).map((i) => i.id)).toContain(hidden.id);
    const denied = await api.admin.content.$get({ query: {} }, other);
    expect(denied.status).toBe(403);
  });
});
