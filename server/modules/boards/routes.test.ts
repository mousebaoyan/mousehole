import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

let admin = as("");
let lastSlug = 0;

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
});

async function newBoard(change: { visibility?: "members" } = {}) {
  const slug = `b${++lastSlug}`;
  const res = await api.boards.$post({ json: { slug, name: `版块${lastSlug}`, ...change } }, admin);
  expect(res.status).toBe(201);
  return slug;
}

async function newTag(name: string) {
  const res = await api.tags.$post({ json: { name, kind: "topic" } }, admin);
  if (res.status !== 201) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function slugs(init?: { headers: Record<string, string> }) {
  const res = await api.boards.$get({}, init);
  return (await res.json()).items.map((b) => b.slug);
}

async function newThread(slug: string) {
  const author = await createUser();
  const { id } = await db
    .insertInto("threads")
    .values((eb) => ({
      board_id: eb.selectFrom("boards").select("id").where("slug", "=", slug),
      author_id: author.id,
      title: "帖子",
    }))
    .returning("id")
    .executeTakeFirstOrThrow();
  return id;
}

describe("版块", () => {
  test("仅成员版块：成员看得到；访客、冻结的账号和没有 read 范围的 bot 看不到", async () => {
    const open = await newBoard();
    const closed = await newBoard({ visibility: "members" });

    const member = as(await login((await createUser()).id));
    const frozenUser = await createUser();
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", frozenUser.id)
      .execute();
    const frozen = as(await login(frozenUser.id));
    const { token } = await createBotToken(
      { userId: frozenUser.id, operatorId: null, tokenId: null, ip: null, userAgent: null },
      { name: "同步", botQq: nextQq(), scopes: ["sync"] },
    );
    const syncBot = { headers: { authorization: `Bearer ${token}` } };

    expect(await slugs(member)).toEqual(expect.arrayContaining([open, closed]));
    for (const viewer of [undefined, frozen, syncBot]) {
      const seen = await slugs(viewer);
      expect(seen).toContain(open);
      expect(seen).not.toContain(closed);
    }
    const res = await api.boards[":slug"].$get({ param: { slug: closed } });
    expect(res.status).toBe(404);
  });

  test("只有管理员能建版块", async () => {
    const moderator = as(await login((await createUser("moderator")).id));
    const res = await api.boards.$post({ json: { slug: "nope", name: "不行" } }, moderator);
    expect(res.status).toBe(403);
  });

  test("移动版块：移到第几位，其他版块依次顺延", async () => {
    const [a, b, c] = [await newBoard(), await newBoard(), await newBoard()];
    const before = (await slugs()).filter((s) => [a, b, c].includes(s));
    expect(before).toEqual([a, b, c]);

    const all = await slugs();
    const res = await api.boards[":slug"].$patch(
      { param: { slug: c }, json: { position: all.indexOf(a) } },
      admin,
    );
    expect(res.status).toBe(200);
    expect((await slugs()).filter((s) => [a, b, c].includes(s))).toEqual([c, a, b]);
  });

  test("有过帖子的版块不能删，删掉帖子也不行；空版块可以删，草稿里选了它的也行", async () => {
    const used = await newBoard();
    const thread = await newThread(used);
    await db
      .updateTable("threads")
      .set({ deleted_at: new Date() })
      .where("id", "=", thread)
      .execute();
    const refused = await api.boards[":slug"].$delete({ param: { slug: used } }, admin);
    expect(refused.status).toBe(409);

    const empty = await newBoard();
    const json = { title: "想发在这里", board: empty, body: "写了一半" };
    await api.me.drafts[":key"].$put({ param: { key: "new" }, json }, admin);
    const res = await api.boards[":slug"].$delete({ param: { slug: empty } }, admin);
    expect(res.status).toBe(204);
    expect(await slugs()).not.toContain(empty);
    const draft = await api.me.drafts[":key"].$get({ param: { key: "new" } }, admin);
    if (!draft.ok) throw new Error(`status ${draft.status}`);
    expect(await draft.json()).toMatchObject({ title: "想发在这里", board: null });
  });
});

describe("标签", () => {
  test("版主能管标签，普通成员不能", async () => {
    const user = as(await login((await createUser()).id));
    const moderator = as(await login((await createUser("moderator")).id));
    const refused = await api.tags.$post({ json: { name: "无权", kind: "topic" } }, user);
    expect(refused.status).toBe(403);
    const created = await api.tags.$post({ json: { name: "版主建", kind: "school" } }, moderator);
    expect(created.status).toBe(201);
  });

  test("改名撞上已有的标签返回 409", async () => {
    await newTag("已有");
    const id = await newTag("新名");
    const res = await api.tags[":id"].$patch(
      { param: { id: String(id) }, json: { name: "已有" } },
      admin,
    );
    expect(res.status).toBe(409);
  });

  test("合并：帖子都改用目标标签，两个都有的只留一个，重新计数", async () => {
    const board = await newBoard();
    const [both, onlyFrom, hidden] = [
      await newThread(board),
      await newThread(board),
      await newThread(board),
    ];
    await db.updateTable("threads").set({ status: "hidden" }).where("id", "=", hidden).execute();
    const from = await newTag("合并来源");
    const into = await newTag("合并目标");
    await db
      .insertInto("thread_tags")
      .values([
        { thread_id: both, tag_id: from },
        { thread_id: both, tag_id: into },
        { thread_id: onlyFrom, tag_id: from },
        { thread_id: hidden, tag_id: from },
      ])
      .execute();

    const res = await api.tags[":id"].merge.$post(
      { param: { id: String(from) }, json: { into } },
      admin,
    );
    // The hidden thread keeps the tag but isn't counted.
    expect(await res.json()).toMatchObject({ id: into, thread_count: 2 });
    const rows = await db
      .selectFrom("thread_tags")
      .select(["thread_id", "tag_id"])
      .where("thread_id", "in", [both, onlyFrom, hidden])
      .orderBy("thread_id")
      .execute();
    expect(rows).toEqual([
      { thread_id: both, tag_id: into },
      { thread_id: onlyFrom, tag_id: into },
      { thread_id: hidden, tag_id: into },
    ]);
    const ids = (await (await api.tags.$get()).json()).items.map((t) => t.id);
    expect(ids).not.toContain(from);
  });
});
