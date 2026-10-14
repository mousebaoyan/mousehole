import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { createUser, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
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
});
