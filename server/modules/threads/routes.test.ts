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
    { json: { board, title: "帖子标题", content: { markdown: "正文" }, ...extra } },
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

async function detail(thread: number, who: { headers: Record<string, string> } = member) {
  const res = await api.threads[":id"].$get({ param: { id: String(thread) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function bookmark(thread: number, on: boolean) {
  const param = { id: String(thread) };
  return on
    ? api.threads[":id"].bookmark.$put({ param }, member)
    : api.threads[":id"].bookmark.$delete({ param }, member);
}

async function bookmarked() {
  const res = await api.threads.$get({ query: { view: "bookmarked" } }, member);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((t) => t.id);
}

describe("发帖和回复", () => {
  test("校验不通过时，提示是一句写明字段的话", async () => {
    const res = await api.threads.$post(
      { json: { board: await newBoard(), title: "两字", content: { markdown: "正文" } } },
      member,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { message: "标题至少 4 个字" } });
  });

  test("并发回复按顺序拿到楼层号，计数都对", async () => {
    const board = await newBoard();
    const thread = await newThread(board);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => reply(thread, { content: { markdown: `第 ${i} 条` } })),
    );
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(201));

    expect(await floors(thread)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(await detail(thread)).toMatchObject({ reply_count: 10, floor_count: 11 });
    const counts = await db
      .selectFrom("boards")
      .select(["thread_count", "post_count"])
      .where("slug", "=", board)
      .executeTakeFirstOrThrow();
    expect(counts).toEqual({ thread_count: 1, post_count: 10 });
  });

  test("回复某一层：记下回复关系；别的帖子里的楼层不行", async () => {
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

    const replies = await api.posts[":id"].replies.$get({
      param: { id: String(first.id) },
      query: {},
    });
    if (!replies.ok) throw new Error(`status ${replies.status}`);
    expect((await replies.json()).items.map((p) => p.floor)).toEqual([3]);
  });

  test("只有版主能在版主版块发帖；锁定的帖子只有版主能回复", async () => {
    const board = await newBoard({ post_role: "moderator" });
    const refused = await api.threads.$post(
      { json: { board, title: "帖子标题", content: { markdown: "正文" } } },
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
      {
        userId: (await createUser("admin")).id,
        operatorId: null,
        tokenId: null,
        ip: null,
        userAgent: null,
      },
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

  // Replies are limited the same way, at 60 in 10 minutes, which takes longer to reach.
  test("一个人一小时最多发 20 个帖子，再发返回 429 和 Retry-After", async () => {
    const board = await newBoard();
    const poster = as(await login((await createUser()).id));
    const post = () =>
      api.threads.$post(
        { json: { board, title: "刷屏的帖子", content: { markdown: "刷屏" } } },
        poster,
      );
    for (let i = 0; i < 20; i++) expect((await post()).status).toBe(201);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("读帖子", () => {
  test("仅成员版块的帖子，访客打不开", async () => {
    const board = await newBoard({ visibility: "members" });
    const thread = await newThread(board);
    const param = { id: String(thread) };
    expect((await api.threads[":id"].$get({ param })).status).toBe(404);
    expect((await api.threads[":id"].posts.$get({ param, query: {} })).status).toBe(404);
    expect((await api.threads[":id"].$get({ param }, member)).status).toBe(200);
    const listed = await list({});
    expect(listed.items.map((t) => t.id)).not.toContain(thread);
  });

  test("ID、楼层、游标和时间超出数据库能存的范围时是请求有误，不是服务器出错", async () => {
    const thread = String(await newThread(await newBoard()));
    const statuses = await Promise.all(
      [
        api.threads[":id"].$get({ param: { id: "9999999999" } }),
        api.threads[":id"].posts.$get({ param: { id: thread }, query: { after: "9999999999" } }),
        api.threads.$get({ query: { cursor: "99999999999999999999_1" } }),
        api.threads.$get({ query: { view: "created", cursor: "9999999999" } }),
        api.users[":user"].$get({ param: { user: "9999999999" } }),
        api.bot.bounties.$get({ query: { since: "99999999999999" } }, admin),
      ].map(async (res) => (await res).status),
    );
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400]);
  });

  test("楼层按批取：往后、往前各 20 层，不足 20 层就是到头了；删除的楼层保留位置", async () => {
    const board = await newBoard();
    const thread = await newThread(board);
    // Floors 2 to 45, written directly: only reading them is tested here, floor 3 deleted.
    const author = (
      await db
        .selectFrom("threads")
        .select("author_id")
        .where("id", "=", thread)
        .executeTakeFirstOrThrow()
    ).author_id;
    await db
      .insertInto("posts")
      .values(
        range(2, 45).map((floor) => ({
          thread_id: thread,
          floor,
          author_id: author,
          body: `楼 ${floor}`,
          html: `<p>楼 ${floor}</p>`,
          deleted_at: floor === 3 ? new Date() : null,
        })),
      )
      .execute();
    await db.updateTable("threads").set({ floor_count: 45 }).where("id", "=", thread).execute();

    expect(await floors(thread)).toEqual(range(1, 20));
    expect(await floors(thread, { after: "40" })).toEqual(range(41, 45));
    expect(await floors(thread, { before: "25" })).toEqual(range(5, 24));
    expect((await posts(thread))[2]).toMatchObject({ floor: 3, deleted: true, html: "" });
  });

  test("最新列表：翻页不重复不遗漏，置顶的只在第一页最前面", async () => {
    const board = await newBoard();
    // Written directly, a second apart: only the listing is tested here.
    const { id: boardId } = await db
      .selectFrom("boards")
      .select("id")
      .where("slug", "=", board)
      .executeTakeFirstOrThrow();
    const author = await createUser();
    const rows = await db
      .insertInto("threads")
      .values(
        range(1, 33).map((i) => ({
          board_id: boardId,
          author_id: author.id,
          title: `帖子 ${i}`,
          last_post_at: new Date(Date.now() - (34 - i) * 1000),
        })),
      )
      .returning("id")
      .execute();
    const ids = rows.map((r) => r.id);
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

  test("只有论坛上发的问答帖算待解答，收录来的不算", async () => {
    const board = await newBoard();
    const asked = await newThread(board);
    const collected = await newThread(board);
    // Made questions here rather than paying a coin for each.
    await db
      .updateTable("threads")
      .set({ kind: "question" })
      .where("id", "in", [asked, collected])
      .execute();
    await db
      .updateTable("posts")
      .set({ via: "qq" })
      .where("thread_id", "=", collected)
      .where("floor", "=", 1)
      .execute();
    await replied(asked, "论坛上的回答");

    const unsolved = await list({ board, view: "unsolved" });
    expect(unsolved.items.map((t) => t.id)).toEqual([asked]);
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

describe("收藏和关注", () => {
  test("发帖的人自动关注；访客的帖子详情里没有自己的状态", async () => {
    const thread = await newThread(await newBoard());
    expect(await detail(thread)).toMatchObject({ bookmarked: false, notify_level: "watching" });
    expect(await detail(thread, { headers: {} })).not.toHaveProperty("notify_level");

    const param = { id: String(thread) };
    await api.threads[":id"].subscription.$put({ param, json: { level: "muted" } }, member);
    expect(await detail(thread)).toMatchObject({ notify_level: "muted" });
  });

  test("收藏列表按收藏时间排，再收藏一次不挪位置；取消后就不在了；要登录", async () => {
    const board = await newBoard();
    const first = await newThread(board);
    const second = await newThread(board);
    expect((await bookmark(first, true)).status).toBe(204);
    await bookmark(second, true);
    await bookmark(first, true);
    expect(await bookmarked()).toEqual([second, first]);
    expect(await detail(first)).toMatchObject({ bookmarked: true });

    await bookmark(second, false);
    expect(await bookmarked()).toEqual([first]);
    expect((await api.threads.$get({ query: { view: "bookmarked" } })).status).toBe(401);
  });
});

describe("我的帖子", () => {
  test("自己发的和回复过的，按最后回复排；删掉的回复不算；要登录", async () => {
    const board = await newBoard();
    const poster = as(await login((await createUser()).id));
    const created = await api.threads.$post(
      { json: { board, title: "自己发的帖子", content: { markdown: "正文" } } },
      poster,
    );
    if (!created.ok) throw new Error(`status ${created.status}`);
    const own = (await created.json()).id;
    const answered = await newThread(board);
    const withdrawn = await newThread(board);
    const json = { content: { markdown: "回复" } };
    await api.threads[":id"].posts.$post({ param: { id: String(answered) }, json }, poster);
    const res = await api.threads[":id"].posts.$post(
      { param: { id: String(withdrawn) }, json },
      poster,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    await api.posts[":id"].$delete({ param: { id: String((await res.json()).id) } }, poster);

    const posted = await api.threads.$get({ query: { view: "posted" } }, poster);
    if (!posted.ok) throw new Error(`status ${posted.status}`);
    expect((await posted.json()).items.map((t) => t.id)).toEqual([answered, own]);
    expect((await api.threads.$get({ query: { view: "posted" } })).status).toBe(401);
  });
});

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
