import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

let admin = as("");
let author = as("");
let other = as("");
let moderator = as("");
let lastSlug = 0;

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  author = as(await login((await createUser()).id));
  other = as(await login((await createUser()).id));
  moderator = as(await login((await createUser("moderator")).id));
});

async function newBoard() {
  const slug = `e${++lastSlug}`;
  await api.boards.$post({ json: { slug, name: `版块${lastSlug}` } }, admin);
  return slug;
}

async function newThread(board: string, tags: string[] = []) {
  const res = await api.threads.$post(
    { json: { board, title: "原来的标题", content: { markdown: "原来的正文" }, tags } },
    author,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function reply(thread: number, markdown: string, replyTo?: number) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(thread) }, json: { content: { markdown }, reply_to_id: replyTo } },
    other,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function posts(thread: number) {
  const res = await api.threads[":id"].posts.$get({ param: { id: String(thread) }, query: {} });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

function patchPost(id: number, markdown: string, who: { headers: Record<string, string> }) {
  return api.posts[":id"].$patch(
    { param: { id: String(id) }, json: { content: { markdown } } },
    who,
  );
}

async function revisions(id: number, who: { headers: Record<string, string> }) {
  return api.posts[":id"].revisions.$get({ param: { id: String(id) } }, who);
}

async function counts(table: "boards" | "tags", column: "slug" | "name", value: string) {
  return db
    .selectFrom(table)
    .select("thread_count")
    .where(column, "=", value)
    .executeTakeFirstOrThrow()
    .then((r) => r.thread_count);
}

describe("编辑", () => {
  test("作者改正文，旧正文进编辑记录；别人不能改，版主能改并记审计日志", async () => {
    const thread = await newThread(await newBoard());
    const [opening] = await posts(thread);

    expect((await patchPost(opening.id, "改过的正文", author)).status).toBe(200);
    expect((await patchPost(opening.id, "别人乱改", other)).status).toBe(403);
    expect((await patchPost(opening.id, "版主改的", moderator)).status).toBe(200);

    const [now] = await posts(thread);
    expect(now).toMatchObject({ html: "<p>版主改的</p>\n" });
    expect(now.edited_at).not.toBeNull();
    const history = await revisions(opening.id, author);
    if (!history.ok) throw new Error(`status ${history.status}`);
    expect((await history.json()).items.map((r) => [r.rev, r.body])).toEqual([
      [2, "改过的正文"],
      [1, "原来的正文"],
    ]);
    expect((await revisions(opening.id, other)).status).toBe(403);

    const audit = await db
      .selectFrom("audit_logs")
      .select("action")
      .where("target_type", "=", "post")
      .where("target_id", "=", opening.id)
      .execute();
    expect(audit).toEqual([{ action: "post.edit" }]);
  });

  test("改标题记在主楼的编辑记录里；改标签时两边的帖子数跟着变", async () => {
    const board = await newBoard();
    await api.tags.$post({ json: { name: "改前", kind: "topic" } }, admin);
    await api.tags.$post({ json: { name: "改后", kind: "topic" } }, admin);
    const thread = await newThread(board, ["改前"]);

    const res = await api.threads[":id"].$patch(
      { param: { id: String(thread) }, json: { title: "新的标题", tags: ["改后"] } },
      author,
    );
    expect(await res.json()).toMatchObject({ title: "新的标题", tags: ["改后"] });
    expect(await counts("tags", "name", "改前")).toBe(0);
    expect(await counts("tags", "name", "改后")).toBe(1);
    const [opening] = await posts(thread);
    const history = await revisions(opening.id, author);
    if (!history.ok) throw new Error(`status ${history.status}`);
    expect((await history.json()).items[0]).toMatchObject({ title: "原来的标题" });
  });

  test("只有版主能移动版块，两个版块的计数都跟着变", async () => {
    const [from, to] = [await newBoard(), await newBoard()];
    const thread = await newThread(from);
    await reply(thread, "一条回复");
    const param = { id: String(thread) };

    expect((await api.threads[":id"].$patch({ param, json: { board: to } }, author)).status).toBe(
      403,
    );
    expect(
      (await api.threads[":id"].$patch({ param, json: { board: to } }, moderator)).status,
    ).toBe(200);
    const rows = await db
      .selectFrom("boards")
      .select(["slug", "thread_count", "post_count"])
      .where("slug", "in", [from, to])
      .orderBy("slug")
      .execute();
    expect(rows).toEqual([
      { slug: from, thread_count: 0, post_count: 0 },
      { slug: to, thread_count: 1, post_count: 1 },
    ]);
  });
});

describe("删除", () => {
  test("删回复：楼层号保留，回复数和被回复的计数都减一；主楼不能单独删", async () => {
    const thread = await newThread(await newBoard());
    const first = await reply(thread, "二楼");
    const second = await reply(thread, "回复二楼", first.id);

    const res = await api.posts[":id"].$delete({ param: { id: String(second.id) } }, other);
    expect(res.status).toBe(204);
    const floors = await posts(thread);
    expect(floors.map((p) => [p.floor, p.deleted])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(floors[1]).toMatchObject({ reply_count: 0 });
    const detail = await api.threads[":id"].$get({ param: { id: String(thread) } });
    expect(await detail.json()).toMatchObject({ reply_count: 1, floor_count: 3 });

    const opening = await api.posts[":id"].$delete({ param: { id: String(floors[0].id) } }, author);
    expect(opening.status).toBe(400);
  });

  test("删帖子：有人回复后作者不能删，版主能删；删掉后打不开，版块计数减一", async () => {
    const board = await newBoard();
    const quiet = await newThread(board);
    const busy = await newThread(board);
    await reply(busy, "有人回复了");

    const own = await api.threads[":id"].$delete({ param: { id: String(quiet) } }, author);
    expect(own.status).toBe(204);
    const refused = await api.threads[":id"].$delete({ param: { id: String(busy) } }, author);
    expect(refused.status).toBe(403);
    const removed = await api.threads[":id"].$delete({ param: { id: String(busy) } }, moderator);
    expect(removed.status).toBe(204);

    expect((await api.threads[":id"].$get({ param: { id: String(busy) } })).status).toBe(404);
    expect(await counts("boards", "slug", board)).toBe(0);
  });
});
