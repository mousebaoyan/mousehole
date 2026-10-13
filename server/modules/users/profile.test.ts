import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let author: { id: number; qq: number; who: Who } = { id: 0, qq: 0, who: as("") };
let reader: Who = as("");
const guest: Who = { headers: {} };

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "open", name: "公开" } }, admin);
  await api.boards.$post({ json: { slug: "inner", name: "仅成员", visibility: "members" } }, admin);
  const user = await createUser();
  author = { ...user, who: as(await login(user.id)) };
  reader = as(await login((await createUser()).id));
});

async function thread(board: string, title: string) {
  const res = await api.threads.$post(
    { json: { board, title, content: { markdown: "主楼" } } },
    author.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function reply(threadId: number, markdown: string) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown } } },
    author.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

describe("资料卡和个人主页", () => {
  test("资料卡带统计；QQ 号只给成员看；也能按 QQ 号找", async () => {
    await reply(await thread("open", "统计用的主题"), "统计用的回复");

    const byGuest = await api.users[":user"].$get({ param: { user: String(author.id) } }, guest);
    const card = await byGuest.json();
    expect(card).toMatchObject({ id: author.id, stats: { threads: 1, posts: 1, likes: 0 } });
    expect(card).not.toHaveProperty("qq");

    const byQq = await api.users[":user"].$get({ param: { user: `qq:${author.qq}` } }, reader);
    expect(await byQq.json()).toMatchObject({ id: author.id, qq: author.qq, activated: true });
    expect((await api.users[":user"].$get({ param: { user: "999999" } })).status).toBe(404);
  });

  test("回复列表：最新的在前，正文是纯文本摘要；删掉的不列，访客看不到仅成员版块里的", async () => {
    const open = await thread("open", "公开版块的主题");
    const inner = await thread("inner", "仅成员版块的主题");
    await reply(open, "**第一条**回复");
    const removed = await reply(open, "删掉的回复");
    await api.posts[":id"].$delete({ param: { id: String(removed) } }, author.who);
    await reply(inner, "成员才能看的回复");

    const list = async (who: Who) => {
      const res = await api.users[":user"].posts.$get(
        { param: { user: String(author.id) }, query: {} },
        who,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items.map((p) => `${p.thread.title}：${p.excerpt}`);
    };
    expect((await list(reader)).slice(0, 2)).toEqual([
      "仅成员版块的主题：成员才能看的回复",
      "公开版块的主题：第一条回复",
    ]);
    expect((await list(guest))[0]).toBe("公开版块的主题：第一条回复");

    const threads = await api.users[":user"].threads.$get(
      { param: { user: String(author.id) }, query: {} },
      guest,
    );
    if (!threads.ok) throw new Error(`status ${threads.status}`);
    expect((await threads.json()).items.map((t) => t.title).slice(0, 2)).toEqual([
      "公开版块的主题",
      "统计用的主题",
    ]);
  });
});

async function relation(who: Who) {
  const res = await api.users[":user"].$get({ param: { user: String(author.id) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { stats, followed, endorsed } = await res.json();
  return { followers: stats.followers, endorsements: stats.endorsements, followed, endorsed };
}

describe("关注和认可", () => {
  test("关注和认可各算一次，再来一次不变，可以撤回；不能对自己；访客没有自己的状态", async () => {
    const param = { user: String(author.id) };
    expect((await api.users[":user"].follow.$put({ param }, reader)).status).toBe(204);
    await api.users[":user"].follow.$put({ param }, reader);
    await api.users[":user"].endorsement.$put({ param }, reader);
    expect(await relation(reader)).toEqual({
      followers: 1,
      endorsements: 1,
      followed: true,
      endorsed: true,
    });
    expect(await relation(guest)).toEqual({
      followers: 1,
      endorsements: 1,
      followed: undefined,
      endorsed: undefined,
    });

    await api.users[":user"].endorsement.$delete({ param }, reader);
    expect(await relation(reader)).toMatchObject({
      endorsements: 0,
      endorsed: false,
      followed: true,
    });
    expect((await api.users[":user"].follow.$put({ param }, author.who)).status).toBe(400);
  });
});
