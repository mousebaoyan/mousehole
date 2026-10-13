import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";
import { flushViews, recordView } from "./service.ts";

const api = testClient(app).api.v1;

let admin = as("");
let member = as("");
let lastSlug = 0;

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  member = as(await login((await createUser()).id));
});

async function newBoard(change: { visibility?: "members"; post_role?: "moderator" } = {}) {
  const slug = `t${++lastSlug}`;
  const res = await api.boards.$post({ json: { slug, name: `版块${lastSlug}`, ...change } }, admin);
  expect(res.status).toBe(201);
  return slug;
}

async function newThread(board: string, extra: { kind?: "question"; tags?: string[] } = {}) {
  const res = await api.threads.$post(
    { json: { board, title: "主题标题", content: { markdown: "正文" }, ...extra } },
    member,
  );
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}

function reply(thread: number, json: { content: { markdown: string }; reply_to_id?: number }) {
  return api.threads[":id"].posts.$post({ param: { id: String(thread) }, json }, member);
}

async function replied(thread: number, markdown: string, reply_to_id?: number) {
  const res = await reply(thread, { content: { markdown }, reply_to_id });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function posts(thread: number, query: { after?: string; before?: string } = {}) {
  const res = await api.threads[":id"].posts.$get({ param: { id: String(thread) }, query });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

async function list(query: { board?: string; tag?: string; view?: "unsolved"; cursor?: string }) {
  const res = await api.threads.$get({ query });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function floors(thread: number, query: { after?: string; before?: string } = {}) {
  return (await posts(thread, query)).map((p) => p.floor);
}

describe("发主题和回复", () => {
  test("并发回复按顺序拿到楼层号，计数都对", async () => {
    const board = await newBoard();
    const thread = await newThread(board);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reply(thread, { content: { markdown: `第 ${i} 条` } })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));

    expect(await floors(thread)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const detail = await (await api.threads[":id"].$get({ param: { id: String(thread) } })).json();
    expect(detail).toMatchObject({ reply_count: 10, floor_count: 11 });
    const counts = await db
      .selectFrom("boards")
      .select(["thread_count", "post_count"])
      .where("slug", "=", board)
      .executeTakeFirstOrThrow();
    expect(counts).toEqual({ thread_count: 1, post_count: 10 });
  });

  test("回复某一层：记下回复关系；别的主题里的楼层不行", async () => {
    const board = await newBoard();
    const [thread, other] = [await newThread(board), await newThread(board)];
    const first = await replied(thread, "第二楼");
    const elsewhere = await replied(other, "别处");

    const res = await reply(thread, { content: { markdown: "回复二楼" }, reply_to_id: first.id });
    expect(await res.json()).toMatchObject({ floor: 3, reply_to: { id: first.id, floor: 2 } });
    const target = await api.posts[":id"].$get({ param: { id: String(first.id) }, query: {} });
    expect(await target.json()).toMatchObject({ reply_count: 1 });

    const wrong = await reply(thread, { content: { markdown: "x" }, reply_to_id: elsewhere.id });
    expect(wrong.status).toBe(400);
  });

  test("只有版主能在版主版块发主题；锁定的主题只有版主能回复", async () => {
    const board = await newBoard({ post_role: "moderator" });
    const refused = await api.threads.$post(
      { json: { board, title: "主题标题", content: { markdown: "正文" } } },
      member,
    );
    expect(refused.status).toBe(403);

    const open = await newBoard();
    const thread = await newThread(open);
    await db.updateTable("threads").set({ locked: true }).where("id", "=", thread).execute();
    const locked = await reply(thread, { content: { markdown: "x" } });
    expect(await locked.json()).toMatchObject({ error: { code: "thread_locked" } });
    const moderator = as(await login((await createUser("moderator")).id));
    const allowed = await api.threads[":id"].posts.$post(
      { param: { id: String(thread) }, json: { content: { markdown: "版主可以" } } },
      moderator,
    );
    expect(allowed.status).toBe(201);
  });

  test("bot 发的帖子记为 bot，并写进审计日志", async () => {
    const board = await newBoard();
    const { qq } = await createUser();
    const { token } = await createBotToken(
      { userId: (await createUser("admin")).id, operatorId: null, tokenId: null, ip: null },
      { name: "插件", botQq: nextQq(), scopes: ["act", "read"] },
    );
    const res = await api.threads.$post(
      { json: { board, title: "群里转来的", content: { markdown: "正文" } } },
      { headers: { authorization: `Bearer ${token}`, "x-act-as": `qq:${qq}` } },
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { id } = await res.json();
    expect((await posts(id))[0]).toMatchObject({ via: "bot" });
    const audit = await db
      .selectFrom("audit_logs")
      .select("action")
      .where("target_type", "=", "thread")
      .where("target_id", "=", id)
      .execute();
    expect(audit).toEqual([{ action: "thread.create" }]);
  });
});

describe("读主题", () => {
  test("仅成员版块的主题，访客打不开", async () => {
    const board = await newBoard({ visibility: "members" });
    const thread = await newThread(board);
    const param = { id: String(thread) };
    expect((await api.threads[":id"].$get({ param })).status).toBe(404);
    expect((await api.threads[":id"].posts.$get({ param, query: {} })).status).toBe(404);
    expect((await api.threads[":id"].$get({ param }, member)).status).toBe(200);
    const listed = await list({});
    expect(listed.items.map((t) => t.id)).not.toContain(thread);
  });

  test("楼层按批取：往后、往前各 20 层，不足 20 层就是到头了；删除的楼层保留位置", async () => {
    const board = await newBoard();
    const thread = await newThread(board);
    for (let i = 0; i < 44; i++) await reply(thread, { content: { markdown: `楼 ${i + 2}` } });
    await db
      .updateTable("posts")
      .set({ deleted_at: new Date() })
      .where("thread_id", "=", thread)
      .where("floor", "=", 3)
      .execute();

    expect(await floors(thread)).toEqual(range(1, 20));
    expect(await floors(thread, { after: "40" })).toEqual(range(41, 45));
    expect(await floors(thread, { before: "25" })).toEqual(range(5, 24));
    expect((await posts(thread))[2]).toMatchObject({ floor: 3, deleted: true, html: "" });
  });

  test("最新列表：翻页不重复不遗漏，置顶的只在第一页最前面", async () => {
    const board = await newBoard();
    const ids = [];
    for (let i = 0; i < 33; i++) ids.push(await newThread(board));
    const pinned = ids[5];
    await db.updateTable("threads").set({ pinned: 1 }).where("id", "=", pinned).execute();

    const first = await list({ board });
    expect(first.items[0].id).toBe(pinned);
    expect(first.items).toHaveLength(31);
    const second = await list({ board, cursor: first.next_cursor ?? "" });
    expect(second.next_cursor).toBeNull();
    const seen = [...first.items, ...second.items].map((t) => t.id);
    expect(seen.toSorted((a, b) => a - b)).toEqual(ids);
  });

  test("按标签和待解答筛选", async () => {
    const board = await newBoard();
    await api.tags.$post({ json: { name: "筛选用", kind: "topic" } }, admin);
    const tagged = await newThread(board, { tags: ["筛选用"] });
    const question = await newThread(board, { kind: "question" });
    await newThread(board);

    const byTag = await list({ board, tag: "筛选用" });
    expect(byTag.items.map((t) => t.id)).toEqual([tagged]);
    const unsolved = await list({ board, view: "unsolved" });
    expect(unsolved.items.map((t) => t.id)).toEqual([question]);
    const missing = await api.threads.$get({ query: { tag: "没有这个" } });
    expect(missing.status).toBe(404);
  });

  test("浏览数：同一个人一分钟内只算一次", async () => {
    const thread = await newThread(await newBoard());
    recordView(thread, "u1");
    recordView(thread, "u1");
    recordView(thread, "1.2.3.4");
    await flushViews();
    const { view_count } = await db
      .selectFrom("threads")
      .select("view_count")
      .where("id", "=", thread)
      .executeTakeFirstOrThrow();
    expect(view_count).toBe(2);
  });
});

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
