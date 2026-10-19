import { sql } from "kysely";
import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };
type Person = { id: number; who: Who };

let moderator: Who = as("");
let asker: Person = { id: 0, who: as("") };
let other: Person = { id: 0, who: as("") };
let answerer: Person = { id: 0, who: as("") };

async function person(role: "user" | "moderator" | "admin" = "user", level = 1) {
  const { id } = await createUser(role, level);
  return { id, who: as(await login(id)) };
}

beforeAll(async () => {
  const admin = (await person("admin")).who;
  await api.boards.$post({ json: { slug: "mg", name: "合并" } }, admin);
  await api.boards.$post({ json: { slug: "mg2", name: "合并二" } }, admin);
  for (const name of ["合一", "合二", "合三", "合四", "合五", "合六"]) {
    await api.tags.$post({ json: { name, kind: "topic" } }, admin);
  }
  moderator = (await person("moderator")).who;
  asker = await person();
  other = await person();
  answerer = await person();
  // Questions cost a coin each.
  await db
    .insertInto("coin_balances")
    .values([asker, other].map((p) => ({ user_id: p.id, coins: 50 })))
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ coins: 50 }))
    .execute();
});

// Minutes into a day, so floors can be posted in any order.
function at(minute: number) {
  return sql<Date>`timestamptz '2026-09-01 10:00+08' + make_interval(mins => ${minute})`;
}

async function thread(
  who: Person,
  minute: number,
  options: { kind?: "discussion" | "question"; tags?: string[]; anonymous?: boolean } = {},
) {
  const res = await api.threads.$post(
    {
      json: {
        board: "mg",
        title: "怎么找实习比较好",
        content: { markdown: `${minute} 分发的主楼` },
        kind: options.kind ?? "question",
        tags: options.tags,
        anonymous: options.anonymous,
      },
    },
    who.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id } = await res.json();
  const opening = await db
    .updateTable("posts")
    .set({ created_at: at(minute) })
    .where("thread_id", "=", id)
    .where("floor", "=", 1)
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .updateTable("threads")
    .set({ created_at: at(minute), last_post_at: at(minute) })
    .where("id", "=", id)
    .execute();
  return { id, opening: opening.id };
}

async function reply(who: Person, threadId: number, minute: number, replyTo?: number) {
  const res = await api.threads[":id"].posts.$post(
    {
      param: { id: String(threadId) },
      json: { content: { markdown: `${minute} 分的回复` }, reply_to_id: replyTo },
    },
    who.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id } = await res.json();
  await db
    .updateTable("posts")
    .set({ created_at: at(minute) })
    .where("id", "=", id)
    .execute();
  await db
    .updateTable("threads")
    .set({ last_post_at: sql<Date>`greatest(last_post_at, ${at(minute)})` })
    .where("id", "=", threadId)
    .execute();
  return id;
}

function merge(
  threadId: number,
  json: { into: number } & Record<string, unknown>,
  who = moderator,
) {
  return api.threads[":id"].merge.$post({ param: { id: String(threadId) }, json }, who);
}

async function floors(threadId: number) {
  return db
    .selectFrom("posts")
    .select(["id", "floor", "reply_to_id", "reply_count"])
    .where("thread_id", "=", threadId)
    .orderBy("floor")
    .execute();
}

async function counts() {
  const board = await db
    .selectFrom("boards")
    .select(["thread_count", "post_count"])
    .where("slug", "=", "mg")
    .executeTakeFirstOrThrow();
  const author = await db
    .selectFrom("users")
    .select(["thread_count", "post_count"])
    .where("id", "=", other.id)
    .executeTakeFirstOrThrow();
  const replier = await db
    .selectFrom("users")
    .select("post_count")
    .where("id", "=", answerer.id)
    .executeTakeFirstOrThrow();
  return { board, author, replier };
}

// The two boards' counts and those of the tags the threads share or not.
async function tally() {
  return {
    boards: await db
      .selectFrom("boards")
      .select(["slug", "thread_count", "post_count"])
      .where("slug", "in", ["mg", "mg2"])
      .orderBy("slug")
      .execute(),
    tags: Object.fromEntries(
      (
        await db
          .selectFrom("tags")
          .select(["name", "thread_count"])
          .where("name", "in", ["合二", "合三"])
          .execute()
      ).map((t) => [t.name, t.thread_count]),
    ),
  };
}

describe("合并帖子", () => {
  test("两边的楼层按发的时间排，留下的帖子的主楼还是 1 楼；回楼主的回复改成回它的主楼", async () => {
    const kept = await thread(asker, 10);
    const r1 = await reply(answerer, kept.id, 20);
    const r2 = await reply(other, kept.id, 40, r1);
    // Asked earlier than the one kept, its opening post still comes after the kept one's.
    const gone = await thread(other, 5);
    const s1 = await reply(answerer, gone.id, 30);
    const s2 = await reply(asker, gone.id, 50);
    const before = await counts();

    const res = await merge(gone.id, { into: kept.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ thread_id: kept.id, floor: 2 });
    expect(await floors(kept.id)).toEqual([
      { id: kept.opening, floor: 1, reply_to_id: null, reply_count: 0 },
      { id: gone.opening, floor: 2, reply_to_id: null, reply_count: 2 },
      { id: r1, floor: 3, reply_to_id: null, reply_count: 1 },
      { id: s1, floor: 4, reply_to_id: gone.opening, reply_count: 0 },
      { id: r2, floor: 5, reply_to_id: r1, reply_count: 0 },
      { id: s2, floor: 6, reply_to_id: gone.opening, reply_count: 0 },
    ]);
    const detail = await api.threads[":id"].$get({ param: { id: String(kept.id) } });
    expect(await detail.json()).toMatchObject({ floor_count: 6, reply_count: 5 });
    // The board has one thread less and the opening post as one more reply; so has its author.
    // The replies that came along still count for theirs.
    expect(await counts()).toEqual({
      board: {
        thread_count: before.board.thread_count - 1,
        post_count: before.board.post_count + 1,
      },
      author: {
        thread_count: before.author.thread_count - 1,
        post_count: before.author.post_count + 1,
      },
      replier: before.replier,
    });
  });

  test("被合并的帖子的地址说出它的楼层现在在哪；它的楼主收到通知，插件收到事件", async () => {
    const kept = await thread(asker, 10);
    await reply(answerer, kept.id, 20);
    const gone = await thread(other, 15);
    await reply(answerer, gone.id, 30);
    await reply(answerer, gone.id, 40);
    await merge(gone.id, { into: kept.id });

    const res = await api.threads[":id"].$get({ param: { id: String(gone.id) } });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      thread_id: kept.id,
      floor: 2,
      error: { code: "thread_merged" },
    });
    // Its third floor, at 40 minutes, is the fifth now; past its last, its opening post.
    const third = await api.threads[":id"].posts.$get({
      param: { id: String(gone.id) },
      query: { after: "2" },
    });
    expect(await third.json()).toMatchObject({ thread_id: kept.id, floor: 5 });
    const past = await api.threads[":id"].posts.$get({
      param: { id: String(gone.id) },
      query: { after: "9" },
    });
    expect(await past.json()).toMatchObject({ thread_id: kept.id, floor: 2 });

    const notice = await db
      .selectFrom("notifications")
      .select(["thread_id", "post_id", "data"])
      .where("user_id", "=", other.id)
      .where("type", "=", "moderation")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(notice).toEqual({
      thread_id: kept.id,
      post_id: gone.opening,
      data: { action: "merge", reason: "" },
    });
    const event = await db
      .selectFrom("events")
      .select("data")
      .where("type", "=", "thread.merged")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(event.data).toMatchObject({
      thread_id: gone.id,
      into: { id: kept.id },
      url: `${env.PUBLIC_URL}/t/${kept.id}?floor=2`,
    });
  });

  test("读过的楼层换成新的楼层号；收藏、草稿、通知和群消息都跟过去", async () => {
    const reader = await person();
    const kept = await thread(asker, 10);
    await reply(answerer, kept.id, 30);
    const gone = await thread(other, 20);
    const answer = await reply(answerer, gone.id, 40);
    // Read the kept one's opening post and reply, and the other's opening post.
    for (const [id, last] of [
      [kept.id, 2],
      [gone.id, 1],
    ]) {
      await api.threads[":id"].read.$post(
        { param: { id: String(id) }, json: { floors: [[1, last]], seconds: 30 } },
        reader.who,
      );
    }
    await api.threads[":id"].bookmark.$put({ param: { id: String(gone.id) } }, reader.who);
    await db
      .insertInto("drafts")
      .values([
        { user_id: reader.id, thread_id: gone.id, body: "写到一半的回复" },
        { user_id: answerer.id, thread_id: gone.id, body: "这份不留" },
        { user_id: answerer.id, thread_id: kept.id, body: "这份留着" },
      ])
      .execute();
    await db
      .insertInto("qq_message_links")
      .values({
        chat_type: "group",
        chat_id: 1,
        message_id: 9001,
        position: 0,
        thread_id: gone.id,
        post_id: answer,
      })
      .execute();
    await merge(gone.id, { into: kept.id });

    // Floors now: the kept opening post, the other's (20), the reply (30), the answer (40).
    const mine = await api.threads[":id"].$get({ param: { id: String(kept.id) } }, reader.who);
    expect(await mine.json()).toMatchObject({ read_floors: [[1, 3]], bookmarked: true });
    const drafts = await db
      .selectFrom("drafts")
      .select(["user_id", "thread_id", "body"])
      .where("user_id", "in", [reader.id, answerer.id])
      .where("thread_id", "in", [kept.id, gone.id])
      .orderBy("user_id")
      .execute();
    expect(drafts).toEqual(
      [
        { user_id: reader.id, thread_id: kept.id, body: "写到一半的回复" },
        { user_id: answerer.id, thread_id: kept.id, body: "这份留着" },
      ].toSorted((a, b) => a.user_id - b.user_id),
    );
    const link = await db
      .selectFrom("qq_message_links")
      .select("thread_id")
      .where("message_id", "=", 9001)
      .executeTakeFirstOrThrow();
    expect(link.thread_id).toBe(kept.id);
  });

  test("标题、版块、标签和类型按选的；改成讨论帖就取消采纳；改了标题记进编辑记录", async () => {
    const kept = await thread(asker, 10, { tags: ["合一", "合二"] });
    const answer = await reply(answerer, kept.id, 20);
    await api.threads[":id"].answers[":post"].$put(
      { param: { id: String(kept.id), post: String(answer) } },
      asker.who,
    );
    const gone = await thread(other, 15, { kind: "discussion", tags: ["合二", "合三"] });
    const before = await tally();

    const res = await merge(gone.id, {
      into: kept.id,
      title: "实习怎么找：投递和内推",
      board: "mg2",
      kind: "discussion",
    });
    expect(res.status).toBe(200);
    const detail = await api.threads[":id"].$get({ param: { id: String(kept.id) } });
    expect(await detail.json()).toMatchObject({
      title: "实习怎么找：投递和内推",
      board: { slug: "mg2" },
      tags: ["合一", "合三", "合二"].toSorted(),
      kind: "discussion",
      accepted_floors: [],
    });
    // Both threads leave their board for the other one, as one thread with both openings and the
    // reply; a tag both had counts it once.
    const [mg, mg2] = before.boards;
    expect(await tally()).toEqual({
      boards: [
        { ...mg, thread_count: mg.thread_count - 2, post_count: mg.post_count - 1 },
        { ...mg2, thread_count: mg2.thread_count + 1, post_count: mg2.post_count + 2 },
      ],
      tags: { ...before.tags, 合二: before.tags["合二"] - 1 },
    });
    const revision = await db
      .selectFrom("post_revisions")
      .select("title")
      .where("post_id", "=", kept.opening)
      .executeTakeFirstOrThrow();
    expect(revision.title).toBe("怎么找实习比较好");
  });

  test("不能合并的：同一个帖子、匿名的、标签合起来超过 5 个；只有版主能合并", async () => {
    const kept = await thread(asker, 10, { tags: ["合一", "合二", "合三"] });
    const tagged = await thread(other, 20, { tags: ["合四", "合五", "合六"] });
    const anonymous = await thread(other, 30, { anonymous: true });

    expect((await merge(kept.id, { into: kept.id })).status).toBe(400);
    const masked = await merge(anonymous.id, { into: kept.id });
    expect(masked.status).toBe(400);
    expect(await masked.json()).toMatchObject({ error: { message: "打开了匿名的帖子不能合并" } });
    expect((await merge(tagged.id, { into: kept.id })).status).toBe(400);
    expect((await merge(tagged.id, { into: kept.id }, (await person("user", 5)).who)).status).toBe(
      403,
    );
    // Chosen down to five, they go.
    const res = await merge(tagged.id, {
      into: kept.id,
      tags: ["合一", "合二", "合三", "合四", "合五"],
    });
    expect(res.status).toBe(200);
  });

  test("合并过的帖子可以再合并，旧地址跟着找到楼层", async () => {
    const first = await thread(asker, 10);
    const second = await thread(other, 20);
    const third = await thread(other, 30);
    await merge(first.id, { into: second.id });
    await merge(second.id, { into: third.id });
    const res = await api.threads[":id"].$get({ param: { id: String(first.id) } });
    expect(await res.json()).toMatchObject({ thread_id: third.id, floor: 2 });
  });
});

describe("按时间重排楼层号", () => {
  test("主楼还是 1 楼，其余按发的时间排，读过的楼层跟着换号", async () => {
    const reader = await person();
    const t = await thread(asker, 10);
    const late = await reply(answerer, t.id, 50);
    const early = await reply(other, t.id, 20);
    await api.threads[":id"].read.$post(
      { param: { id: String(t.id) }, json: { floors: [[1, 2]], seconds: 30 } },
      reader.who,
    );

    const renumber = () =>
      api.threads[":id"].renumber.$post({ param: { id: String(t.id) } }, moderator);
    const res = await renumber();
    expect(await res.json()).toEqual({ moved: 2 });
    expect((await floors(t.id)).map((f) => f.id)).toEqual([t.opening, early, late]);
    const mine = await api.threads[":id"].$get({ param: { id: String(t.id) } }, reader.who);
    expect(await mine.json()).toMatchObject({
      read_floors: [
        [1, 1],
        [3, 3],
      ],
    });
    expect(await (await renumber()).json()).toEqual({ moved: 0 });
  });
});
