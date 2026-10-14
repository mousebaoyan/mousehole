import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { createUser, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

const GROUP = 123456;
let bot = { headers: {} };
let asMember = { headers: {} };
let memberQq = 0;
let messageId = 1000;

beforeAll(async () => {
  const admin = await createUser("admin");
  const { token } = await createBotToken(
    { userId: admin.id, operatorId: null, tokenId: null, ip: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "act", "admin"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  const member = await createUser();
  memberQq = member.qq;
  asMember = { headers: { ...bot.headers, "x-act-as": `qq:${member.qq}` } };
  await api.boards.$post({ json: { slug: "qq", name: "群聊" } }, bot);
});

function source() {
  return { chat_type: "group" as const, chat_id: GROUP, message_id: ++messageId };
}

async function postThread(
  onebot: { type: string; data: Record<string, unknown> }[],
  from = source(),
) {
  return api.threads.$post(
    { json: { board: "qq", title: "群里转来的问题", content: { onebot }, source: from } },
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

describe("群消息转到论坛", () => {
  test("消息段转成正文，标为来自群聊；转存不了的图片显示「图片已失效」", async () => {
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

  test("同一条消息不能转两次，返回已有的帖子", async () => {
    const from = source();
    const first = await postThread([{ type: "text", data: { text: "第一次" } }], from);
    if (!first.ok) throw new Error(`status ${first.status}`);
    const { id } = await first.json();
    const again = await postThread([{ type: "text", data: { text: "第二次" } }], from);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "source_exists" }, thread_id: id });
  });

  test("群友引用 bot 的转存回执回复：找得到帖子；引用转过来的消息就是回复那一层", async () => {
    const asked = source();
    const res = await postThread([{ type: "text", data: { text: "提问" } }], asked);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const threadId = (await res.json()).id;

    const notice = {
      chat_type: "group" as const,
      chat_id: String(GROUP),
      message_id: String(++messageId),
    };
    const put = await api.bot.messages[":chat_type"][":chat_id"][":message_id"].$put(
      { param: notice, json: { thread_id: threadId } },
      asMember,
    );
    expect(put.status).toBe(204);
    const found = await api.bot.messages[":chat_type"][":chat_id"][":message_id"].$get(
      { param: notice },
      bot,
    );
    expect(await found.json()).toMatchObject({
      kind: "notice",
      thread_id: threadId,
      post_id: null,
    });

    const reply = await api.threads[":id"].posts.$post(
      {
        param: { id: String(threadId) },
        json: {
          content: {
            onebot: [
              { type: "reply", data: { id: String(asked.message_id) } },
              { type: "text", data: { text: "我也想知道" } },
            ],
          },
          source: source(),
        },
      },
      asMember,
    );
    if (!reply.ok) throw new Error(`status ${reply.status}: ${await reply.text()}`);
    const body = await reply.json();
    expect(body.reply_to).toMatchObject({ floor: 1 });

    const links = await db
      .selectFrom("qq_message_links")
      .select(["kind", "post_id"])
      .where("thread_id", "=", threadId)
      .orderBy("message_id")
      .execute();
    expect(links.map((l) => l.kind)).toEqual(["source", "notice", "source"]);
  });
});
