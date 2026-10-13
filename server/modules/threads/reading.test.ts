import { sql } from "kysely";
import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let author: Who = as("");
let reader: { id: number; who: Who } = { id: 0, who: as("") };

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "reading", name: "阅读" } }, admin);
  author = as(await login((await createUser()).id));
  const user = await createUser();
  reader = { id: user.id, who: as(await login(user.id)) };
});

async function newThread(replies: number) {
  const res = await api.threads.$post(
    { json: { board: "reading", title: "读一读这个主题", content: { markdown: "主楼" } } },
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

    await report(thread, [[2, 4]], 500);
    expect(await readState(thread)).toEqual({ read_floors: [[1, 6]], last_read_floor: 6 });
    const after = await stats();
    expect([
      after.posts_read - before.posts_read,
      after.read_seconds - before.read_seconds,
    ]).toEqual([6, 150]);
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

  test("北京时间的新一天第一次上报，访问天数加一", async () => {
    const thread = await newThread(0);
    const { days_visited } = await stats();
    await report(thread, [[1, 1]], 5);
    expect((await stats()).days_visited).toBe(days_visited);

    await db
      .updateTable("users")
      .set({ last_seen_at: sql<Date>`now() - interval '1 day'` })
      .where("id", "=", reader.id)
      .execute();
    await report(thread, [], 5);
    expect((await stats()).days_visited).toBe(days_visited + 1);
  });

  test("访客没有阅读记录，也不能上报", async () => {
    const thread = await newThread(0);
    const res = await api.threads[":id"].$get({ param: { id: String(thread) } });
    expect(await res.json()).not.toHaveProperty("read_floors");
    expect((await report(thread, [[1, 1]], 5, { headers: {} })).status).toBe(401);
  });
});
