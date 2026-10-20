import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who = as("");
let bot: Who = { headers: {} };
let lastMessage = 1000;

beforeAll(async () => {
  const { id } = await createUser("admin");
  admin = as(await login(id));
  const { token } = await createBotToken(
    { userId: id, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "act"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  await api.boards.$post({ json: { slug: "active", name: "活跃" } }, admin);
});

// A member acting through the bot; `archived` for what it collects from a group message.
function viaBot(qq: number) {
  return { headers: { ...bot.headers, "x-act-as": `qq:${qq}` } };
}

function archived() {
  const source = { chat_type: "group" as const, chat_id: 1, message_ids: [++lastMessage] };
  return { source, created_at: Math.floor(Date.now() / 1000) };
}

async function member(role: "user" | "moderator" = "user", level = 1) {
  const { id, qq } = await createUser(role, level);
  return { id, qq, who: as(await login(id)) };
}

async function thread(who: Who, json: { kind?: "question" | "poll" } = {}) {
  const res = await api.threads.$post(
    {
      json: {
        board: "active",
        title: "活跃用户的帖子",
        content: { markdown: "正文" },
        ...json,
        poll: json.kind === "poll" ? { options: ["去", "不去"] } : undefined,
      },
    },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}

async function reply(who: Who, threadId: number, more = {}) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown: "回复" }, ...more } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}

async function listed(query: {
  sort?: "accepted" | "likes" | "votes" | "boosts";
  staff?: "false";
}) {
  const res = await api.admin.stats.users.$get({ query: { range: "7", ...query } }, admin);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

describe("活跃用户", () => {
  test("只算网页上以自己名义做的：群里收录的、bot 代发的、匿名的不算；按所选的一项排，为 0 的不列", async () => {
    const writer = await member();
    const asker = await member("user", 2);
    const fan = await member();
    const moderator = await member("moderator");

    // The asker: a question and a poll, and an answer of their own they accept, which counts for
    // nobody.
    const question = await thread(asker.who, { kind: "question" });
    const poll = await thread(asker.who, { kind: "poll" });
    const own = await reply(asker.who, question);
    // The writer: a thread and replies on the site, one of them later made anonymous; one
    // archived from a group, one left through the bot.
    await thread(writer.who);
    const answer = await reply(writer.who, question);
    const liked = await reply(writer.who, question);
    const hidden = await reply(writer.who, question);
    await db.updateTable("posts").set({ anonymous: true }).where("id", "=", hidden).execute();
    const collected = await reply(viaBot(writer.qq), question, archived());
    await reply(viaBot(writer.qq), question);
    for (const post of [answer, own]) {
      const res = await api.threads[":id"].answers[":post"].$put(
        { param: { id: String(question), post: String(post) } },
        asker.who,
      );
      expect(res.status).toBe(200);
    }
    // The fan: a like and a boost on the site, a vote; and through the bot, from the group.
    const react = (post: number, who: Who, more = {}) =>
      api.posts[":id"].reaction.$put(
        { param: { id: String(post) }, json: { emoji: "heart", ...more } },
        who,
      );
    const boost = (post: number, who: Who, more = {}) =>
      api.posts[":id"].boost.$put(
        { param: { id: String(post) }, json: { body: "学到了", ...more } },
        who,
      );
    expect((await react(liked, fan.who)).status).toBe(204);
    expect((await react(hidden, fan.who)).status).toBe(204);
    expect((await react(collected, viaBot(fan.qq), archived())).status).toBe(204);
    expect((await boost(liked, fan.who)).status).toBe(200);
    expect((await boost(collected, viaBot(fan.qq), archived())).status).toBe(200);
    const options = await db
      .selectFrom("poll_options")
      .select("id")
      .where("thread_id", "=", poll)
      .execute();
    const vote = await api.threads[":id"].poll.vote.$put(
      { param: { id: String(poll) }, json: { options: [options[0].id] } },
      fan.who,
    );
    expect(vote.status).toBe(200);
    // A moderator who replied the most.
    for (let i = 0; i < 4; i++) await reply(moderator.who, question);

    const ids = (items: Awaited<ReturnType<typeof listed>>) => items.map((i) => i.user.id);
    const all = await listed({});
    expect(ids(all)).toEqual([moderator.id, writer.id, asker.id]);
    expect(all[0].user.role).toBe("moderator");
    expect(all[1]).toMatchObject({
      days: 1,
      threads: 1,
      replies: 2,
      accepted: 1,
      likes: 1,
      votes: 0,
      boosts: 0,
    });
    expect(ids(await listed({ staff: "false" }))).toEqual([writer.id, asker.id]);
    expect(ids(await listed({ sort: "accepted" }))).toEqual([writer.id]);
    expect(ids(await listed({ sort: "likes" }))).toEqual([writer.id]);
    expect(ids(await listed({ sort: "votes" }))).toEqual([fan.id]);
    expect(ids(await listed({ sort: "boosts" }))).toEqual([fan.id]);
  });
});
