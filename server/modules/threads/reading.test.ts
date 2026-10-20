import { sql } from "kysely";
import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { recountPeopleReached } from "../users/service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who = as("");
let author: Who = as("");
let reader: { id: number; who: Who } = { id: 0, who: as("") };

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "reading", name: "阅读" } }, admin);
  author = as(await login((await createUser()).id));
  const user = await createUser();
  reader = { id: user.id, who: as(await login(user.id)) };
});

async function newThread(replies: number, board = "reading") {
  const res = await api.threads.$post(
    { json: { board, title: "读一读这个帖子", content: { markdown: "主楼" } } },
    author,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id } = await res.json();
  for (let i = 0; i < replies; i++) {
    await api.threads[":id"].posts.$post(
      { param: { id: String(id) }, json: { content: { markdown: `第 ${i + 2} 楼` } } },
      author,
    );
  }
  return id;
}

function report(thread: number, floors: [number, number][], seconds: number, who = reader.who) {
  return api.threads[":id"].read.$post(
    { param: { id: String(thread) }, json: { floors, seconds } },
    who,
  );
}

async function readState(thread: number, who = reader.who) {
  const res = await api.threads[":id"].$get({ param: { id: String(thread) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { read_floors, last_read_floor } = await res.json();
  return { read_floors, last_read_floor };
}

// As if the last report or visit were long ago, so the seconds reported all count.
function lastSeen(ago: string, id = reader.id) {
  return db
    .updateTable("users")
    .set({ last_seen_at: sql<Date>`now() - ${ago}::interval` })
    .where("id", "=", id)
    .execute();
}

async function stats() {
  return db
    .selectFrom("users")
    .select(["posts_read", "read_seconds", "days_visited"])
    .where("id", "=", reader.id)
    .executeTakeFirstOrThrow();
}

describe("阅读记录", () => {
  test("读过的楼层并进去，相邻的合并；新读的楼层和时间计入统计，单次最多算 120 秒", async () => {
    const thread = await newThread(5);
    const before = await stats();

    await lastSeen("10 minutes");
    expect(
      (
        await report(
          thread,
          [
            [1, 2],
            [5, 9],
          ],
          30,
        )
      ).status,
    ).toBe(204);
    expect(await readState(thread)).toEqual({
      read_floors: [
        [1, 2],
        [5, 6],
      ],
      last_read_floor: 6,
    });

    await lastSeen("10 minutes");
    await report(thread, [[2, 4]], 500);
    expect(await readState(thread)).toEqual({ read_floors: [[1, 6]], last_read_floor: 6 });
    const after = await stats();
    expect([
      after.posts_read - before.posts_read,
      after.read_seconds - before.read_seconds,
    ]).toEqual([6, 150]);
  });

  test("阅读时间不超过距上次上报或访问过去的时间：两个页面同时上报也只算一份", async () => {
    const thread = await newThread(0);
    await lastSeen("20 seconds");
    const before = await stats();
    await report(thread, [], 60);
    await report(thread, [], 60);
    expect((await stats()).read_seconds - before.read_seconds).toBe(20);
  });

  test("自己发的楼层直接算读过", async () => {
    const thread = await newThread(2);
    expect(await readState(thread, author)).toEqual({ read_floors: [[1, 3]], last_read_floor: 3 });

    await api.threads[":id"].posts.$post(
      { param: { id: String(thread) }, json: { content: { markdown: "第 4 楼" } } },
      reader.who,
    );
    expect(await readState(thread)).toEqual({ read_floors: [[4, 4]], last_read_floor: 4 });
  });

  test("看不到的楼层，读过它后面的一楼或者读到最后一楼时一并算读过，不计入阅读统计", async () => {
    const thread = await newThread(4);
    await db
      .updateTable("posts")
      .set({ status: "hidden" })
      .where("thread_id", "=", thread)
      .where("floor", "in", [3, 5])
      .execute();
    const before = await stats();

    await report(thread, [[1, 2]], 5);
    expect(await readState(thread)).toEqual({ read_floors: [[1, 2]], last_read_floor: 2 });
    await report(thread, [[4, 4]], 5);
    expect(await readState(thread)).toEqual({ read_floors: [[1, 5]], last_read_floor: 5 });
    expect((await stats()).posts_read - before.posts_read).toBe(3);
  });

  test("北京时间的新一天第一次上报，访问天数加一，阅读记在这一天", async () => {
    const thread = await newThread(0);
    const { days_visited } = await stats();
    await report(thread, [[1, 1]], 5);
    expect((await stats()).days_visited).toBe(days_visited);

    // Today's activity becomes yesterday's.
    await db
      .updateTable("user_days")
      .set({ day: sql<Date>`day - 1` })
      .where("user_id", "=", reader.id)
      .execute();
    await lastSeen("1 minute");
    await report(thread, [], 7);
    expect((await stats()).days_visited).toBe(days_visited + 1);
    const today = await db
      .selectFrom("user_days")
      .select("read_seconds")
      .where("user_id", "=", reader.id)
      .where("day", "=", sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date`)
      .executeTakeFirstOrThrow();
    expect(today.read_seconds).toBe(7);
  });

  test("访客没有阅读记录，也不能上报", async () => {
    const thread = await newThread(0);
    const res = await api.threads[":id"].$get({ param: { id: String(thread) } });
    expect(await res.json()).not.toHaveProperty("read_floors");
    expect((await report(thread, [[1, 1]], 5, { headers: {} })).status).toBe(401);
  });
});

async function list(view: "unread" | "read") {
  const res = await api.threads.$get({ query: { board: "lists", view } }, reader.who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((t) => t.id);
}

async function counts() {
  const res = await api.threads.counts.$get({ query: { board: "lists" } }, reader.who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("未读和已读", () => {
  test("读过又有新楼层的是未读，没打开过的不算，已读按最后阅读时间排", async () => {
    await api.boards.$post({ json: { slug: "lists", name: "列表" } }, admin);
    const replied = await newThread(0, "lists");
    const partly = await newThread(2, "lists");
    // Never opened, so in neither list.
    await newThread(0, "lists");
    await report(replied, [[1, 1]], 5);
    await report(partly, [[1, 1]], 5);
    await api.threads[":id"].posts.$post(
      { param: { id: String(replied) }, json: { content: { markdown: "新的一楼" } } },
      author,
    );

    expect(await list("unread")).toEqual([replied, partly]);
    expect(await list("read")).toEqual([partly, replied]);
    expect(await counts()).toEqual({ unread: 2, unsolved: 0, unvoted: 0 });

    await report(replied, [[2, 2]], 5);
    expect(await counts()).toEqual({ unread: 1, unsolved: 0, unvoted: 0 });
    expect(await list("read")).toEqual([replied, partly]);
  });

  test("侧栏的数量只算看得到的帖子", async () => {
    const who = as(await login((await createUser()).id));
    const shown = await newThread(0);
    const hidden = await newThread(0);
    for (const thread of [shown, hidden]) {
      await report(thread, [[1, 1]], 5, who);
      await api.threads[":id"].bookmark.$put({ param: { id: String(thread) } }, who);
      await api.threads[":id"].posts.$post(
        { param: { id: String(thread) }, json: { content: { markdown: "回复" } } },
        who,
      );
    }
    await db.updateTable("threads").set({ status: "hidden" }).where("id", "=", hidden).execute();
    const me = await api.me.$get({}, who);
    if (!me.ok) throw new Error(`status ${me.status}`);
    expect((await me.json()).counts).toEqual({ posted: 1, bookmarked: 1, read: 1, badges: 0 });
  });

  test("要登录", async () => {
    expect((await api.threads.$get({ query: { view: "unread" } })).status).toBe(401);
    expect((await api.threads.counts.$get({ query: {} })).status).toBe(401);
  });
});

describe("影响力", () => {
  test("别人第一次读到的楼层记在作者名下，自己读的和匿名的不算；帮到的人每人只算一次", async () => {
    const writer = await createUser();
    const writerWho = as(await login(writer.id));
    const res = await api.threads.$post(
      { json: { board: "reading", title: "读一读我的帖子", content: { markdown: "主楼" } } },
      writerWho,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { id: thread } = await res.json();
    await api.threads[":id"].posts.$post(
      { param: { id: String(thread) }, json: { content: { markdown: "我的回复" } } },
      writerWho,
    );
    await api.threads[":id"].posts.$post(
      { param: { id: String(thread) }, json: { content: { markdown: "别人的回复" } } },
      admin,
    );
    const impact = () =>
      db
        .selectFrom("users")
        .select([
          "reads_received",
          "people_reached",
          sql<number>`(SELECT coalesce(sum(reads), 0)::integer FROM user_reads
            WHERE user_id = users.id)`.as("days"),
        ])
        .where("id", "=", writer.id)
        .executeTakeFirstOrThrow();

    await report(thread, [[1, 3]], 10);
    await report(thread, [[1, 3]], 10);
    await report(thread, [[1, 3]], 10, writerWho);
    expect(await impact()).toMatchObject({ reads_received: 2, days: 2 });

    const other = as(await login((await createUser()).id));
    await report(thread, [[2, 2]], 10, other);
    await recountPeopleReached();
    expect(await impact()).toMatchObject({ reads_received: 3, people_reached: 2 });

    const hidden = await api.threads.$post(
      {
        json: {
          board: "reading",
          title: "匿名写的帖子",
          content: { markdown: "主楼" },
          anonymous: true,
        },
      },
      writerWho,
    );
    if (!hidden.ok) throw new Error(`status ${hidden.status}`);
    await report((await hidden.json()).id, [[1, 1]], 10);
    expect(await impact()).toMatchObject({ reads_received: 3 });
  });
});
