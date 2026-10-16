import { testClient } from "hono/testing";
import { sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { as, createUser, login } from "../test/fixtures.ts";
import { app } from "./app.ts";
import { db } from "./platform/db.ts";
import { env } from "./platform/env.ts";

// Design §11.4: the queries behind the pages people open most go by index. With a year of
// threads and floors in the database, the pages below are opened while every query is recorded,
// and each is planned again. A plan that reads a table of over a thousand rows whole to keep
// under a tenth of them is missing an index and fails the test; reading one whole to join most
// of it, or reading a small table such as boards, is fine.
const api = testClient(app).api.v1;

type Plan = {
  "Node Type": string;
  "Relation Name"?: string;
  "Plan Rows": number;
  Plans?: Plan[];
};

function seqScans(plan: Plan): { table: string; rows: number }[] {
  const own =
    plan["Node Type"] === "Seq Scan" && plan["Relation Name"] !== undefined
      ? [{ table: plan["Relation Name"], rows: plan["Plan Rows"] }]
      : [];
  return [...own, ...(plan.Plans ?? []).flatMap(seqScans)];
}

let member = as("");
let memberId = 0;
let thread = 0;

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "hot", name: "热门" } }, admin);
  await api.tags.$post({ json: { name: "夏令营", kind: "topic" } }, admin);
  const user = await createUser();
  memberId = user.id;
  member = as(await login(user.id));
  const res = await api.threads.$post(
    {
      json: {
        board: "hot",
        title: "华东师范大学夏令营经验",
        content: { markdown: "流程和材料" },
        tags: ["夏令营"],
      },
    },
    member,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  thread = (await res.json()).id;
  await db.updateTable("users").set({ pins: [thread] }).where("id", "=", memberId).execute();
  await api.threads[":id"].posts.$post(
    { param: { id: String(thread) }, json: { content: { markdown: "rank 30% 也能进" } } },
    admin,
  );
  await fill(await createUser(), memberId);
});

// A year of threads, ten floors each, with what a reader leaves behind: reading records,
// bookmarks and notifications. Written directly, as the API would take too long.
async function fill(author: { id: number }, reader: number) {
  await sql`
    INSERT INTO threads (board_id, author_id, title, last_poster_id, floor_count, reply_count,
      created_at, last_post_at)
    SELECT boards.id, ${author.id}, '填充帖子 ' || i, ${author.id}, 10, 9,
      now() - i * interval '3 hours', now() - i * interval '3 hours'
    FROM boards, generate_series(1, 3000) i WHERE boards.slug = 'hot'`.execute(db);
  await sql`
    INSERT INTO posts (thread_id, floor, author_id, body, html, created_at)
    SELECT threads.id, f, ${author.id}, '填充', '<p>填充</p>', threads.created_at
    FROM threads, generate_series(1, 10) f WHERE threads.title LIKE '填充帖子%'`.execute(db);
  await sql`
    INSERT INTO post_search (post_id, document)
    SELECT id, to_tsvector('simple', '填充 内容 ' || id) FROM posts WHERE body = '填充'`.execute(
    db,
  );
  await sql`
    INSERT INTO thread_tags (thread_id, tag_id, last_post_at)
    SELECT threads.id, tags.id, threads.last_post_at FROM threads, tags
    WHERE threads.title LIKE '填充帖子%' AND threads.id % 3 = 0`.execute(db);
  await sql`
    INSERT INTO users (qq, display_name)
    SELECT 20000000 + i, '填充成员' || i FROM generate_series(1, 2000) i`.execute(db);
  // Each of them has read some twenty threads and has ten notifications, the reader more.
  await sql`
    INSERT INTO thread_users (user_id, thread_id, read_floors, last_read_at, bookmarked_at)
    SELECT users.id, threads.id, int4multirange(int4range(1, 6)), threads.last_post_at,
      CASE WHEN threads.id % 20 = 0 THEN threads.last_post_at END
    FROM users, threads
    WHERE threads.title LIKE '填充帖子%'
      AND (users.id = ${reader} AND threads.id % 5 = 0
        OR users.display_name LIKE '填充成员%' AND (threads.id + users.id) % 150 = 0)`.execute(db);
  await sql`
    INSERT INTO notifications (user_id, type, actor_id, thread_id, post_id, created_at)
    SELECT users.id, 'reply', ${author.id}, posts.thread_id, posts.id, posts.created_at
    FROM users, posts
    WHERE posts.body = '填充' AND posts.floor = 2
      AND (users.id = ${reader} AND posts.thread_id % 10 = 0
        OR users.display_name LIKE '填充成员%' AND (posts.thread_id + users.id) % 300 = 0)`.execute(
    db,
  );
  // Likes on opening posts, the reader's among them.
  await sql`
    INSERT INTO reactions (post_id, user_id, emoji, created_at)
    SELECT posts.id, users.id, 'heart', posts.created_at
    FROM users, posts
    WHERE posts.body = '填充' AND posts.floor = 1
      AND (users.id = ${reader} AND posts.thread_id % 7 = 0
        OR users.display_name LIKE '填充成员%' AND (posts.thread_id + users.id) % 200 = 0)`.execute(
    db,
  );
  // As autovacuum would: merges the full-text index's pending entries and updates statistics.
  await sql`VACUUM ANALYZE`.execute(db);
}

afterAll(() => {
  vi.restoreAllMocks();
});

describe("热点查询走索引", () => {
  test("列表、帖子、楼层、通知、搜索和个人主页，包括赞过、概要、关系和徽章", async () => {
    // Passes each query on, keeping its text and parameters.
    const query = vi.spyOn(Client.prototype, "query");
    const id = { id: String(thread) };
    const views = ["latest", "hot", "unsolved", "new", "unread", "posted", "bookmarked"] as const;
    for (const view of views) await api.threads.$get({ query: { view } }, member);
    await api.threads.$get({ query: { board: "hot" } });
    await api.threads.$get({ query: { tag: "夏令营" } });
    await api.threads[":id"].$get({ param: id }, member);
    await api.threads[":id"].posts.$get({ param: id, query: {} }, member);
    await api.threads[":id"].posts.$get({ param: id, query: { before: "2" } });
    await api.notifications.$get({ query: {} }, member);
    await api.notifications["unread-count"].$get({}, member);
    await api.search.$get({ query: { q: "华东师范" } });
    await api.users[":user"].$get({ param: { user: "1" } });
    const profile = { user: String(memberId) };
    await api.users[":user"].posts.$get({ param: profile, query: { solved: "true" } });
    await api.users[":user"].likes.$get({ param: profile, query: {} }, member);
    await api.users[":user"].summary.$get({ param: profile }, member);
    await api.users[":user"].badges.$get({ param: profile });
    await api.users[":user"].showcase.$get({ param: profile }, member);
    await api.badges.$get({});
    await api.users[":user"].relations.$get(
      { param: profile, query: { list: "endorsing" } },
      member,
    );
    const recorded = query.mock.calls.flatMap(([text, values]) =>
      typeof text === "string" && /^\s*select/i.test(text)
        ? [{ text, values: Array.isArray(values) ? values : [] }]
        : [],
    );
    vi.restoreAllMocks();

    const client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    const missing: string[] = [];
    try {
      const sizes = await client.query<{ relname: string; reltuples: number }>(
        "SELECT relname, reltuples FROM pg_class WHERE relkind = 'r'",
      );
      const size = new Map(sizes.rows.map((r) => [r.relname, r.reltuples]));
      for (const { text, values } of recorded) {
        const { rows } = await client.query<{ "QUERY PLAN": [{ Plan: Plan }] }>(
          `EXPLAIN (FORMAT JSON) ${text}`,
          values,
        );
        for (const { table, rows: kept } of seqScans(rows[0]["QUERY PLAN"][0].Plan)) {
          const all = size.get(table) ?? 0;
          if (all > 1000 && kept < all / 10) missing.push(`${table}: ${text}`);
        }
      }
    } finally {
      await client.end();
    }
    expect(recorded.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});
