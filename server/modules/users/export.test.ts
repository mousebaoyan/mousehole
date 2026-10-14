import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

let me = { id: 0, qq: 0, who: as("") };
let other = as("");

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "x", name: "导出" } }, admin);
  const user = await createUser();
  me = { ...user, who: as(await login(user.id)) };
  other = as(await login((await createUser()).id));
});

async function thread(who: { headers: Record<string, string> }, title: string) {
  const res = await api.threads.$post(
    { json: { board: "x", title, content: { markdown: `${title}的正文` } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function reply(threadId: number, markdown: string) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown } } },
    me.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

describe("导出自己的内容", () => {
  test("自己发的主楼和回复、短评、收藏都在，删掉的和别人的不在；作为附件下载", async () => {
    const mine = await thread(me.who, "我的帖子");
    const theirs = await thread(other, "别人的帖子");
    await reply(theirs, "**回复**原文");
    const gone = await reply(theirs, "删掉的回复");
    await api.posts[":id"].$delete({ param: { id: String(gone) } }, me.who);
    const posts = await api.threads[":id"].posts.$get({ param: { id: String(theirs) }, query: {} });
    if (!posts.ok) throw new Error(`status ${posts.status}`);
    const opening = (await posts.json()).items[0].id;
    await api.posts[":id"].boost.$put(
      { param: { id: String(opening) }, json: { body: "学到了" } },
      me.who,
    );
    await api.threads[":id"].bookmark.$put({ param: { id: String(theirs) } }, me.who);

    const res = await api.me.export.$get({}, me.who);
    if (!res.ok) throw new Error(`status ${res.status}`);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="mousehole-${me.id}.json"`,
    );
    const data = await res.json();
    expect(data.user).toMatchObject({ id: me.id, qq: me.qq });
    expect(data.posts.map((p) => [p.thread_id, p.floor, p.body])).toEqual([
      [mine, 1, "我的帖子的正文"],
      [theirs, 2, "**回复**原文"],
    ]);
    expect(data.boosts).toMatchObject([{ thread_id: theirs, floor: 1, body: "学到了" }]);
    expect(data.bookmarks).toMatchObject([{ thread_id: theirs, title: "别人的帖子" }]);
  });

  test("要登录，bot 不能代为导出", async () => {
    expect((await api.me.export.$get({})).status).toBe(401);
    const { token } = await createBotToken(
      { userId: (await createUser("admin")).id, operatorId: null, tokenId: null, ip: null },
      { name: "插件", botQq: nextQq(), scopes: ["read", "act"] },
    );
    const asBot = { headers: { authorization: `Bearer ${token}`, "x-act-as": `qq:${me.qq}` } };
    expect((await api.me.export.$get({}, asBot)).status).toBe(403);
  });
});
