import { testClient } from "hono/testing";
import sharp from "sharp";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

const GROUP = 123456;
let bot = { headers: {} };
let asMember = { headers: {} };
let memberQq = 0;
let lastMessage = 1000;

beforeAll(async () => {
  const admin = await createUser("admin");
  const { token } = await createBotToken(
    { userId: admin.id, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "act", "admin"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  const member = await createUser();
  memberQq = member.qq;
  asMember = { headers: { ...bot.headers, "x-act-as": `qq:${member.qq}` } };
  await api.boards.$post({ json: { slug: "qq", name: "群聊" } }, bot);
});

function source(count = 1) {
  const message_ids = Array.from({ length: count }, () => ++lastMessage);
  return { chat_type: "group" as const, chat_id: GROUP, message_ids };
}

type Segments = { type: string; data: Record<string, unknown> }[];

async function postThread(onebot: Segments, from = source()) {
  return api.threads.$post(
    { json: { board: "qq", title: "群里收录的问题", content: { onebot }, source: from } },
    asMember,
  );
}

async function opening(threadId: number) {
  const res = await api.threads[":id"].posts.$get({
    param: { id: String(threadId) },
    query: { body: "markdown" },
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items[0];
}

async function lookUp(message: number) {
  const res = await api.bot.messages[":chat_type"][":chat_id"][":message_id"].$get(
    { param: { chat_type: "group", chat_id: String(GROUP), message_id: String(message) } },
    bot,
  );
  return res.ok ? res.json() : res.status;
}

describe("群消息收录到论坛", () => {
  test("消息段转成正文，标为整理自群聊；转存不了的图片显示「图片已失效」", async () => {
    const res = await postThread([
      { type: "at", data: { qq: String(memberQq) } },
      { type: "text", data: { text: " rank 30% **能冲吗**" } },
      { type: "image", data: { url: "https://example.com/not-qq.png" } },
    ]);
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const post = await opening((await res.json()).id);
    expect(post).toMatchObject({ via: "qq" });
    expect(post.body).toMatch(
      /^\[@鼠鼠\]\(\/u\/\d+\) rank 30% \\\*\\\*能冲吗\\\*\\\*\[图片已失效\]$/,
    );
  });

  test("一层可以整理自几条消息，每条都查得到；其中任何一条已经收录过的，返回它所在的帖子", async () => {
    const from = source(3);
    const first = await postThread([{ type: "text", data: { text: "三条合成的提问" } }], from);
    if (!first.ok) throw new Error(`status ${first.status}`);
    const { id } = await first.json();
    const post = await opening(id);
    for (const message of from.message_ids) {
      expect(await lookUp(message)).toEqual({ thread_id: id, post_id: post.id });
    }

    const overlapping = { ...from, message_ids: [++lastMessage, from.message_ids[1]] };
    const again = await postThread([{ type: "text", data: { text: "又收一次" } }], overlapping);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "source_exists" }, thread_id: id });
    expect(await lookUp(overlapping.message_ids[0])).toBe(404);
  });

  test("引用收录过的消息回复，记为回复那一层", async () => {
    const asked = source();
    const res = await postThread([{ type: "text", data: { text: "提问" } }], asked);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const threadId = (await res.json()).id;
    const reply = await api.threads[":id"].posts.$post(
      {
        param: { id: String(threadId) },
        json: {
          content: {
            onebot: [
              { type: "reply", data: { id: String(asked.message_ids[0]) } },
              { type: "text", data: { text: "我也想知道" } },
            ],
          },
          source: source(),
        },
      },
      asMember,
    );
    if (!reply.ok) throw new Error(`status ${reply.status}: ${await reply.text()}`);
    expect((await reply.json()).reply_to).toMatchObject({ floor: 1 });
  });

  test("更新收录的一层：正文重新整理，来源换成完整的新列表，去掉的消息不再对应它", async () => {
    const from = source(2);
    const res = await postThread([{ type: "text", data: { text: "原来的提问" } }], from);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const threadId = (await res.json()).id;
    const post = await opening(threadId);
    const [kept, recalled] = from.message_ids;
    const added = ++lastMessage;

    const edited = await api.posts[":id"].$patch(
      {
        param: { id: String(post.id) },
        json: {
          content: { onebot: [{ type: "text", data: { text: "补充了背景的提问" } }] },
          source: { ...from, message_ids: [kept, added] },
        },
      },
      asMember,
    );
    if (!edited.ok) throw new Error(`status ${edited.status}: ${await edited.text()}`);
    expect((await opening(threadId)).body).toBe("补充了背景的提问");
    expect(await lookUp(kept)).toEqual({ thread_id: threadId, post_id: post.id });
    expect(await lookUp(added)).toEqual({ thread_id: threadId, post_id: post.id });
    expect(await lookUp(recalled)).toBe(404);

    // A message another floor came from stays that floor's, and nothing of this edit is kept.
    const other = source();
    const otherRes = await postThread([{ type: "text", data: { text: "另一个提问" } }], other);
    if (!otherRes.ok) throw new Error(`status ${otherRes.status}`);
    const taken = await api.posts[":id"].$patch(
      {
        param: { id: String(post.id) },
        json: {
          content: { markdown: "不该留下的正文" },
          source: { ...from, message_ids: [kept, other.message_ids[0]] },
        },
      },
      asMember,
    );
    expect(taken.status).toBe(409);
    expect((await opening(threadId)).body).toBe("补充了背景的提问");
    expect(await lookUp(added)).toEqual({ thread_id: threadId, post_id: post.id });
  });

  test("消息段里给论坛上已有图片的地址，直接用，不再下载", async () => {
    const png = await sharp({
      create: { width: 40, height: 30, channels: 4, background: "#e07b53" },
    })
      .png()
      .toBuffer();
    const uploaded = await api.uploads.$post(
      { form: { file: new File([new Uint8Array(png)], "图.png") } },
      asMember,
    );
    if (!uploaded.ok) throw new Error(`status ${uploaded.status}: ${await uploaded.text()}`);
    const { url } = await uploaded.json();
    const res = await postThread([
      { type: "text", data: { text: "截图里这个分数够吗" } },
      { type: "image", data: { url } },
    ]);
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    expect((await opening((await res.json()).id)).body).toBe(`截图里这个分数够吗![](${url})`);
  });
  test("收录的帖子和回复按群里发出的时间；收得晚的回复不把帖子的最后活动往回拨，晚于现在的按现在算", async () => {
    const said = Math.floor(Date.now() / 1000) - 3 * 86_400;
    const res = await api.threads.$post(
      {
        json: {
          board: "qq",
          title: "三天前群里的提问",
          content: { onebot: [{ type: "text", data: { text: "三天前问的" } }] },
          source: source(),
          created_at: said,
        },
      },
      asMember,
    );
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const { id } = await res.json();
    const param = { id: String(id) };
    async function reply(text: string, created_at: number) {
      const posted = await api.threads[":id"].posts.$post(
        {
          param,
          json: {
            content: { onebot: [{ type: "text", data: { text } }] },
            source: source(),
            created_at,
          },
        },
        asMember,
      );
      if (!posted.ok) throw new Error(`status ${posted.status}: ${await posted.text()}`);
      return (await posted.json()).created_at;
    }
    expect(await reply("一分钟后的回答", said + 60)).toBe(said + 60);
    expect(await reply("更早的回答，这一批才收", said + 30)).toBe(said + 30);
    const thread = await api.threads[":id"].$get({ param });
    if (!thread.ok) throw new Error(`status ${thread.status}`);
    expect(await thread.json()).toMatchObject({ created_at: said, last_post_at: said + 60 });

    const future = Math.floor(Date.now() / 1000) + 3600;
    expect(await reply("钟快了", future)).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
  });

  test("created_at 只有 bot 收录时能带", async () => {
    const onebot = [{ type: "text", data: { text: "没有来源" } }];
    const json = { board: "qq", title: "想改发帖时间", content: { onebot }, created_at: 1 };
    expect((await api.threads.$post({ json }, asMember)).status).toBe(400);
    const member = await createUser();
    const web = as(await login(member.id));
    const res = await api.threads.$post({ json: { ...json, source: source() } }, web);
    expect(res.status).toBe(403);
  });
  test("群里的表情回应和短评收录过来：按群里的时间，不提醒楼层作者", async () => {
    const asker = await createUser();
    const asAsker = { headers: { ...bot.headers, "x-act-as": `qq:${asker.qq}` } };
    const onebot = [{ type: "text", data: { text: "有人知道吗" } }];
    const res = await api.threads.$post(
      { json: { board: "qq", title: "群里问的问题", content: { onebot }, source: source() } },
      asAsker,
    );
    if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
    const param = { id: String((await opening((await res.json()).id)).id) };
    const said = Math.floor(Date.now() / 1000) - 86_400;
    const archived = { source: source(), created_at: said };
    const liked = await api.posts[":id"].reaction.$put(
      { param, json: { emoji: "+1", ...archived } },
      asMember,
    );
    expect(liked.status).toBe(204);
    const boosted = await api.posts[":id"].boost.$put(
      { param, json: { body: "同问", ...archived } },
      asMember,
    );
    if (!boosted.ok) throw new Error(`status ${boosted.status}: ${await boosted.text()}`);
    expect((await boosted.json()).created_at).toBe(said);
    const reactions = await api.posts[":id"].reactions.$get({ param, query: {} });
    if (!reactions.ok) throw new Error(`status ${reactions.status}`);
    expect((await reactions.json()).items).toMatchObject([{ emoji: "+1", created_at: said }]);
    const told = await db
      .selectFrom("notifications")
      .select("id")
      .where("user_id", "=", asker.id)
      .execute();
    expect(told).toEqual([]);
  });
  test("收录的内容按群里发出的那天算访问；补上的那天接起前后的连续访问", async () => {
    const asked = await postThread([{ type: "text", data: { text: "谁来回答" } }]);
    if (!asked.ok) throw new Error(`status ${asked.status}: ${await asked.text()}`);
    const param = { id: String((await opening((await asked.json()).id)).id) };
    const { id, qq } = await createUser();
    const asThem = { headers: { ...bot.headers, "x-act-as": `qq:${qq}` } };
    const now = Math.floor(Date.now() / 1000);
    const today = sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date`;
    await db
      .insertInto("user_days")
      .values([1, 3].map((back) => ({ user_id: id, day: sql<Date>`${today} - ${back}::integer` })))
      .execute();
    await db
      .updateTable("users")
      .set({ days_visited: 2, visit_streak: 1 })
      .where("id", "=", id)
      .execute();
    async function standing() {
      return db
        .selectFrom("users")
        .select(["days_visited", "visit_streak"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
    }

    const boosted = await api.posts[":id"].boost.$put(
      { param, json: { body: "确实", source: source(), created_at: now - 2 * 86_400 } },
      asThem,
    );
    expect(boosted.status).toBe(200);
    expect(await standing()).toEqual({ days_visited: 3, visit_streak: 3 });

    const liked = await api.posts[":id"].reaction.$put(
      { param, json: { emoji: "+1", source: source(), created_at: now - 5 * 86_400 } },
      asThem,
    );
    expect(liked.status).toBe(204);
    expect(await standing()).toEqual({ days_visited: 4, visit_streak: 3 });
  });
});

// Since a moment ago, in Unix seconds.
function justNow() {
  return Math.floor(Date.now() / 1000) - 1;
}

async function ask(asker: { qq: number }, kind: "question" | "discussion", from = source()) {
  const res = await api.threads.$post(
    {
      json: {
        board: "qq",
        kind,
        title: "群里问的问题",
        content: { onebot: [{ type: "text", data: { text: "有人知道吗" } }] },
        source: from,
      },
    },
    { headers: { ...bot.headers, "x-act-as": `qq:${asker.qq}` } },
  );
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}

async function answer(threadId: number, who: { headers: Record<string, string> }) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown: "论坛上的回答" } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return (await res.json()).floor;
}

async function answers(threadId: number, since: number, until?: number) {
  const query = { since: String(since), until: until === undefined ? undefined : String(until) };
  const res = await api.bot.answers.$get({ query }, bot);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.filter((item) => item.thread.id === threadId);
}

describe("提问在论坛上的新回答", () => {
  test("按帖子合起来，引用提问的第一条消息；收录的回复、楼主自己的回复和讨论帖不算", async () => {
    const since = justNow();
    const asker = await createUser();
    // NapCat's IDs don't grow with time: the first message has the larger one.
    const from = { ...source(), message_ids: [lastMessage + 2, lastMessage + 1] };
    lastMessage += 2;
    const threadId = await ask(asker, "question", from);
    const first = await answer(threadId, as(await login((await createUser()).id)));
    await answer(threadId, as(await login((await createUser()).id)));
    await answer(threadId, as(await login(asker.id)));
    await api.threads[":id"].posts.$post(
      {
        param: { id: String(threadId) },
        json: {
          content: { onebot: [{ type: "text", data: { text: "群里的回答" } }] },
          source: source(),
        },
      },
      asMember,
    );

    const [item] = await answers(threadId, since);
    expect(item).toMatchObject({
      thread: { id: threadId, title: "群里问的问题" },
      asker: { id: asker.id, display_name: "鼠鼠", qq: asker.qq },
      source: { chat_id: GROUP, message_id: from.message_ids[0] },
      count: 2,
    });
    expect(item.url).toMatch(new RegExp(`/t/${threadId}\\?floor=${first}$`));
    expect(await answers(threadId, since, since + 1)).toEqual([]);

    const discussion = await ask(asker, "discussion");
    await answer(discussion, as(await login((await createUser()).id)));
    expect(await answers(discussion, since)).toEqual([]);
  });

  test("楼主在论坛上读过了每一条新回答，或者已经退群，就不提醒", async () => {
    const since = justNow();
    const asker = await createUser();
    const asAsker = as(await login(asker.id));
    const threadId = await ask(asker, "question");
    const answerer = as(await login((await createUser()).id));
    const first = await answer(threadId, answerer);
    const last = await answer(threadId, answerer);
    const read = (floors: [number, number][]) =>
      api.threads[":id"].read.$post(
        { param: { id: String(threadId) }, json: { floors, seconds: 10 } },
        asAsker,
      );

    await read([[1, first]]);
    expect(await answers(threadId, since)).toMatchObject([{ count: 2 }]);
    await read([[1, last]]);
    expect(await answers(threadId, since)).toEqual([]);

    const other = await ask(asker, "question");
    await answer(other, answerer);
    expect(await answers(other, since)).toHaveLength(1);
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", asker.id)
      .execute();
    expect(await answers(other, since)).toEqual([]);
  });
});
