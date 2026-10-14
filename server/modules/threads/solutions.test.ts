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
  const answer = await api.threads[":id"].posts.$post(
    { param: { id: String(id) }, json: { content: { markdown: "能冲" } } },
    answerer.who,
  );
  if (!answer.ok) throw new Error(`status ${answer.status}`);
  const posts = await api.threads[":id"].posts.$get({ param: { id: String(id) }, query: {} });
  if (!posts.ok) throw new Error(`status ${posts.status}`);
  const [opening, reply] = (await posts.json()).items;
  return { id, opening: opening.id, answer: reply.id };
}

function accept(threadId: number, postId: number, who: Who) {
  return api.threads[":id"].solution.$put(
    { param: { id: String(threadId) }, json: { post_id: postId } },
    who,
  );
}

async function solved(threadId: number) {
  const { solved_post_id } = await db
    .selectFrom("threads")
    .select("solved_post_id")
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  return solved_post_id;
}

describe("采纳答案", () => {
  test("提问的人采纳一层回答：帖子标为已解决，回答的人收到通知，插件收到事件", async () => {
    const q = await question();
    const res = await accept(q.id, q.answer, asker);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ solved_post_id: q.answer });

    const inbox = await api.notifications.$get({ query: {} }, answerer.who);
    if (!inbox.ok) throw new Error(`status ${inbox.status}`);
    expect((await inbox.json()).items[0]).toMatchObject({ type: "solved", post: { id: q.answer } });
    const event = await db
      .selectFrom("events")
      .select("data")
      .where("type", "=", "thread.solved")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(event.data).toMatchObject({ post: { id: q.answer }, answerer: { id: answerer.id } });

    await api.threads[":id"].solution.$delete({ param: { id: String(q.id) } }, asker);
    expect(await solved(q.id)).toBeNull();
  });

  test("只有提问的人和版主能采纳；只能采纳问答帖子里没删的回复", async () => {
    const q = await question();
    expect((await accept(q.id, q.answer, answerer.who)).status).toBe(403);
    expect((await accept(q.id, q.answer, moderator)).status).toBe(200);
    expect((await accept(q.id, q.opening, asker)).status).toBe(400);

    const talk = await question("discussion");
    expect((await accept(talk.id, talk.answer, asker)).status).toBe(400);
  });

  test("采纳的回答被删掉，帖子回到待解答", async () => {
    const q = await question();
    await accept(q.id, q.answer, asker);
    await api.posts[":id"].$delete({ param: { id: String(q.answer) } }, answerer.who);
    expect(await solved(q.id)).toBeNull();
  });
});
