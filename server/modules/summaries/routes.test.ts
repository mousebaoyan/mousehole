import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let owner: Who;
let bot: Who;
let moderator: Who;
let author: { id: number; who: Who };
let replier: Who;

beforeAll(async () => {
  owner = await ownerSession();
  const admin = await createUser("admin");
  const adminWho = as(await login(admin.id));
  await api.boards.$post({ json: { slug: "sum", name: "总结" } }, adminWho);
  const { token } = await createBotToken(
    { userId: admin.id, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "moderate"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  moderator = as(await login((await createUser("moderator")).id));
  const a = await createUser();
  author = { id: a.id, who: as(await login(a.id)) };
  replier = as(await login((await createUser()).id));
});

function turn(summaries: boolean) {
  return api.admin.settings.$patch({ json: { site: { summaries } } }, owner);
}

// A thread with this many replies, gone quiet two hours ago.
async function quietThread(replies: number) {
  const res = await api.threads.$post(
    { json: { board: "sum", title: "回复很多的帖子", content: { markdown: "主楼的问题" } } },
    author.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { id } = await res.json();
  await more(id, replies);
  return id;
}

async function more(id: number, replies: number) {
  for (let i = 0; i < replies; i++) {
    const res = await api.threads[":id"].posts.$post(
      { param: { id: String(id) }, json: { content: { markdown: `第 ${i + 1} 条回答` } } },
      replier,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
  }
  await db
    .updateTable("threads")
    .set({ last_post_at: new Date(Date.now() - 2 * 3_600_000) })
    .where("id", "=", id)
    .execute();
}

async function due() {
  const res = await api.bot.summaries.due.$get({ query: { limit: "50" } }, bot);
  return (await res.json()).items.map((i) => i.thread_id);
}

function push(id: number, floors: number[], replies: number) {
  return api.bot.summaries[":thread"].$put(
    {
      param: { thread: String(id) },
      json: {
        lead: "问的是两所学校怎么选",
        points: [{ text: "多数人建议看导师", floors }],
        replies,
      },
    },
    bot,
  );
}

async function summaryOf(id: number, who?: Who) {
  const res = await api.threads[":id"].$get({ param: { id: String(id) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { summary, summary_disabled } = await res.json();
  return { summary, summary_disabled };
}

describe("AI 总结", () => {
  test("关着时不派活也不显示；打开后回复满 5 条、停下来 1 小时的帖子才派", async () => {
    await turn(false);
    const ready = await quietThread(5);
    const few = await quietThread(4);
    expect(await due()).not.toContain(ready);
    expect(await summaryOf(ready)).toEqual({ summary: undefined, summary_disabled: undefined });
    expect((await push(ready, [2], 5)).status).toBe(403);

    await turn(true);
    const ids = await due();
    expect(ids).toContain(ready);
    expect(ids).not.toContain(few);
    // Talking still.
    await api.threads[":id"].posts.$post(
      { param: { id: String(ready) }, json: { content: { markdown: "又一条" } } },
      replier,
    );
    expect(await due()).not.toContain(ready);
  });

  test("给大模型的只有公开的楼层，不带名字；写好的总结显示在帖子页，回复多一半且至少多 5 条再重写", async () => {
    await turn(true);
    const id = await quietThread(6);
    const source = await api.bot.summaries[":thread"].source.$get(
      { param: { thread: String(id) } },
      bot,
    );
    if (!source.ok) throw new Error(`status ${source.status}`);
    const content = await source.json();
    expect(content.replies).toBe(6);
    expect(content.posts[0]).toEqual({
      floor: 1,
      op: true,
      accepted: false,
      likes: 0,
      text: "主楼的问题",
    });
    expect(JSON.stringify(content)).not.toContain("鼠鼠");

    expect((await push(id, [99], 6)).status).toBe(400);
    expect((await push(id, [2, 3], 6)).status).toBe(204);
    expect(await due()).not.toContain(id);
    expect((await summaryOf(id, replier)).summary).toMatchObject({
      lead: "问的是两所学校怎么选",
      points: [{ text: "多数人建议看导师", floors: [2, 3] }],
      replies: 6,
    });

    await more(id, 4);
    expect(await due()).not.toContain(id);
    await more(id, 1);
    expect(await due()).toContain(id);
  });

  test("引用的楼层被删除时总结撤下、再派活；删了没引用的楼层不影响", async () => {
    await turn(true);
    const id = await quietThread(5);
    await push(id, [3], 5);
    const posts = await api.threads[":id"].posts.$get({ param: { id: String(id) }, query: {} });
    if (!posts.ok) throw new Error(`status ${posts.status}`);
    const items = (await posts.json()).items;
    const remove = (floor: number) =>
      api.posts[":id"].$delete(
        { param: { id: String(items.find((p) => p.floor === floor)?.id) } },
        moderator,
      );

    expect((await remove(2)).status).toBe(204);
    expect((await summaryOf(id)).summary).not.toBeNull();
    expect((await remove(3)).status).toBe(204);
    expect((await summaryOf(id)).summary).toBeNull();
  });

  test("版主关闭后不显示、不派活，推送返回 409；恢复后再派", async () => {
    await turn(true);
    const id = await quietThread(5);
    await push(id, [2], 5);
    const set = (disabled: boolean) =>
      api.threads[":id"].summary.$patch(
        { param: { id: String(id) }, json: { disabled } },
        moderator,
      );

    expect((await set(true)).status).toBe(204);
    expect(await summaryOf(id, moderator)).toEqual({ summary: null, summary_disabled: true });
    expect((await summaryOf(id, replier)).summary_disabled).toBeUndefined();
    expect(await due()).not.toContain(id);
    expect((await push(id, [2], 5)).status).toBe(409);

    expect((await set(false)).status).toBe(204);
    expect(await due()).toContain(id);
  });

  test("帖子里有仅成员可见的人的楼层时，访客看不到总结", async () => {
    await turn(true);
    const id = await quietThread(5);
    await push(id, [2], 5);
    expect((await summaryOf(id)).summary).not.toBeNull();
    const hider = await createUser();
    await db
      .updateTable("users")
      .set({ hide_from_guests: true })
      .where("id", "=", hider.id)
      .execute();
    await api.threads[":id"].posts.$post(
      { param: { id: String(id) }, json: { content: { markdown: "只给成员看" } } },
      as(await login(hider.id)),
    );
    expect((await summaryOf(id)).summary).toBeNull();
    expect((await summaryOf(id, replier)).summary).not.toBeNull();
  });
});
