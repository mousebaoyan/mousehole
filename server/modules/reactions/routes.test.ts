import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

let author = { id: 0, who: as("") };
let fan = as("");
let other = as("");
let moderator = as("");
let thread = 0;
let opening = 0;

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "r", name: "回应" } }, admin);
  const user = await createUser();
  author = { id: user.id, who: as(await login(user.id)) };
  fan = as(await login((await createUser()).id));
  other = as(await login((await createUser()).id));
  moderator = as(await login((await createUser("moderator")).id));
  const res = await api.threads.$post(
    { json: { board: "r", title: "求点赞的主题", content: { markdown: "主楼" } } },
    author.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  thread = (await res.json()).id;
  const posts = await api.threads[":id"].posts.$get({ param: { id: String(thread) }, query: {} });
  if (!posts.ok) throw new Error(`status ${posts.status}`);
  opening = (await posts.json()).items[0].id;
});

function react(emoji: "heart" | "clap" | null, who: { headers: Record<string, string> }) {
  const param = { id: String(opening) };
  return emoji === null
    ? api.posts[":id"].reaction.$delete({ param }, who)
    : api.posts[":id"].reaction.$put({ param, json: { emoji } }, who);
}

async function counts() {
  const post = await db
    .selectFrom("posts")
    .select(["like_count", "reactions"])
    .where("id", "=", opening)
    .executeTakeFirstOrThrow();
  const { like_count } = await db
    .selectFrom("threads")
    .select("like_count")
    .where("id", "=", thread)
    .executeTakeFirstOrThrow();
  const { like_received } = await db
    .selectFrom("users")
    .select("like_received")
    .where("id", "=", author.id)
    .executeTakeFirstOrThrow();
  return {
    post: post.like_count,
    reactions: post.reactions,
    thread: like_count,
    author: like_received,
  };
}

describe("表情回应", () => {
  test("每个表情都算一次赞；换表情只换种类，取消就减掉；不能给自己点赞", async () => {
    expect((await react("heart", fan)).status).toBe(204);
    expect((await react("clap", other)).status).toBe(204);
    expect(await counts()).toEqual({
      post: 2,
      reactions: { heart: 1, clap: 1 },
      thread: 2,
      author: 2,
    });

    await react("clap", fan);
    expect(await counts()).toMatchObject({ post: 2, reactions: { clap: 2 } });

    await react(null, other);
    await react(null, other);
    expect(await counts()).toEqual({ post: 1, reactions: { clap: 1 }, thread: 1, author: 1 });

    expect((await react("heart", author.who)).status).toBe(403);
  });

  test("楼层里带自己的回应；能按表情列出是谁", async () => {
    await react("heart", other);
    const posts = await api.threads[":id"].posts.$get(
      { param: { id: String(thread) }, query: {} },
      other,
    );
    if (!posts.ok) throw new Error(`status ${posts.status}`);
    expect((await posts.json()).items[0]).toMatchObject({ my_reaction: "heart" });

    const hearts = await api.posts[":id"].reactions.$get({
      param: { id: String(opening) },
      query: { emoji: "heart" },
    });
    if (!hearts.ok) throw new Error(`status ${hearts.status}`);
    const { items } = await hearts.json();
    expect(items.map((r) => r.emoji)).toEqual(["heart"]);
  });
});

function boost(body: string | null, who: { headers: Record<string, string> }) {
  const param = { id: String(opening) };
  return body === null
    ? api.posts[":id"].boost.$delete({ param }, who)
    : api.posts[":id"].boost.$put({ param, json: { body } }, who);
}

async function floor(who: { headers: Record<string, string> }) {
  const res = await api.posts[":id"].$get({ param: { id: String(opening) }, query: {} }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("短评", () => {
  test("每人每层一条，再留就改掉原来的；不超过 16 个字，emoji 算一个", async () => {
    expect((await boost("学到了", fan)).status).toBe(200);
    expect((await boost("同问", other)).status).toBe(200);
    expect((await boost("学到了，收藏", fan)).status).toBe(200);
    expect(await floor(fan)).toMatchObject({
      boost_count: 2,
      my_boost: "学到了，收藏",
      boosts: [{ body: "学到了，收藏" }, { body: "同问" }],
    });

    expect((await boost("🐭".repeat(16), author.who)).status).toBe(200);
    expect((await boost("一二三四五六七八九十一二三四五六七", author.who)).status).toBe(400);
    expect((await boost("  ", author.who)).status).toBe(400);
  });

  test("自己能删自己的；版主能删任何人的，记进操作日志", async () => {
    expect((await boost(null, author.who)).status).toBe(204);
    expect((await boost(null, author.who)).status).toBe(404);

    const { boosts } = await floor(other);
    const theirs = boosts.find((b) => b.body === "同问");
    if (!theirs) throw new Error("boost missing");
    const param = { id: String(theirs.id) };
    expect((await api.boosts[":id"].$delete({ param, json: {} }, fan)).status).toBe(403);
    const removed = await api.boosts[":id"].$delete({ param, json: { reason: "灌水" } }, moderator);
    expect(removed.status).toBe(204);

    expect(await floor(other)).toMatchObject({ boost_count: 1, my_boost: null });
    const log = await db
      .selectFrom("audit_logs")
      .select("data")
      .where("action", "=", "boost.delete")
      .where("target_id", "=", theirs.id)
      .executeTakeFirstOrThrow();
    expect(log.data).toMatchObject({ body: "同问", reason: "灌水" });
  });
});
