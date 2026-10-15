import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let asker: Who = as("");
let answerer: { id: number; who: Who } = { id: 0, who: as("") };
let moderator: Who = as("");

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "qa", name: "问答", default_kind: "question" } }, admin);
  asker = as(await login((await createUser()).id));
  const user = await createUser();
  answerer = { id: user.id, who: as(await login(user.id)) };
  moderator = as(await login((await createUser("moderator")).id));
});

async function question(kind?: "discussion") {
  const res = await api.threads.$post(
    { json: { board: "qa", title: "rank 30% 能冲吗", content: { markdown: "求问" }, kind } },
    asker,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id } = await res.json();
  for (const markdown of ["能冲", "也能冲"]) {
    const answer = await api.threads[":id"].posts.$post(
      { param: { id: String(id) }, json: { content: { markdown } } },
      answerer.who,
    );
    if (!answer.ok) throw new Error(`status ${answer.status}`);
  }
  const posts = await api.threads[":id"].posts.$get({ param: { id: String(id) }, query: {} });
  if (!posts.ok) throw new Error(`status ${posts.status}`);
  const [opening, first, second] = (await posts.json()).items;
  return { id, opening: opening.id, answer: first.id, another: second.id };
}

function param(threadId: number, postId: number) {
  return { param: { id: String(threadId), post: String(postId) } };
}

function accept(threadId: number, postId: number, who: Who) {
  return api.threads[":id"].answers[":post"].$put(param(threadId, postId), who);
}

function unaccept(threadId: number, postId: number, who: Who) {
  return api.threads[":id"].answers[":post"].$delete(param(threadId, postId), who);
}

// The thread's count, and the floors accepted, from the database.
async function answers(threadId: number) {
  const { accepted_count } = await db
    .selectFrom("threads")
    .select("accepted_count")
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom("posts")
    .select("id")
    .where("thread_id", "=", threadId)
    .where("accepted_at", "is not", null)
    .orderBy("id")
    .execute();
  return { count: accepted_count, ids: rows.map((r) => r.id) };
}

describe("采纳答案", () => {
  test("可以采纳几层：每层的回答者收到通知，插件收到事件；都取消了才回到待解答", async () => {
    const q = await question();
    const res = await accept(q.id, q.answer, asker);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ solved: true, accepted_floors: [2] });
    const both = await accept(q.id, q.another, asker);
    expect(await both.json()).toMatchObject({ accepted_floors: [2, 3] });
    // Accepting again changes nothing and tells nobody twice.
    await accept(q.id, q.another, asker);
    expect(await answers(q.id)).toEqual({ count: 2, ids: [q.answer, q.another] });

    const inbox = await api.notifications.$get({ query: {} }, answerer.who);
    if (!inbox.ok) throw new Error(`status ${inbox.status}`);
    const told = (await inbox.json()).items.filter((n) => n.type === "solved");
    expect(told.map((n) => n.post?.id)).toEqual([q.another, q.answer]);
    const events = await db
      .selectFrom("events")
      .select("data")
      .where("type", "=", "thread.solved")
      .orderBy("id", "desc")
      .limit(2)
      .execute();
    expect(events.map((e) => e.data)).toMatchObject([
      { post: { id: q.another }, answerer: { id: answerer.id } },
      { post: { id: q.answer } },
    ]);

    const one = await unaccept(q.id, q.answer, asker);
    expect(await one.json()).toMatchObject({ solved: true, accepted_floors: [3] });
    const none = await unaccept(q.id, q.another, asker);
    expect(await none.json()).toMatchObject({ solved: false, accepted_floors: [] });
    expect(await answers(q.id)).toEqual({ count: 0, ids: [] });
  });

  test("只有提问的人和版主能采纳；只能采纳问答帖子里没删的回复", async () => {
    const q = await question();
    expect((await accept(q.id, q.answer, answerer.who)).status).toBe(403);
    expect((await accept(q.id, q.answer, moderator)).status).toBe(200);
    expect((await accept(q.id, q.opening, asker)).status).toBe(400);

    const talk = await question("discussion");
    expect((await accept(talk.id, talk.answer, asker)).status).toBe(400);
  });

  test("采纳的回答被删掉就不再算采纳，另一层还在时帖子仍是已解决", async () => {
    const q = await question();
    await accept(q.id, q.answer, asker);
    await accept(q.id, q.another, asker);
    await api.posts[":id"].$delete({ param: { id: String(q.answer) } }, answerer.who);
    expect(await answers(q.id)).toEqual({ count: 1, ids: [q.another] });
    await api.posts[":id"].$delete({ param: { id: String(q.another) } }, answerer.who);
    expect(await answers(q.id)).toEqual({ count: 0, ids: [] });
  });
});
