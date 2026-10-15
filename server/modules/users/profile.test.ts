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
  test("资料卡带统计；QQ 号和群里的资料只给成员看；也能按 QQ 号找", async () => {
    await reply(await thread("open", "统计用的帖子"), "统计用的回复");

    const byGuest = await api.users[":user"].$get({ param: { user: String(author.id) } }, guest);
    const card = await byGuest.json();
    expect(card).toMatchObject({ id: author.id, stats: { threads: 1, posts: 1, likes: 0 } });
    for (const key of ["qq", "card", "joined_at", "last_sent_at"]) {
      expect(card).not.toHaveProperty(key);
    }

    const byQq = await api.users[":user"].$get({ param: { user: `qq:${author.qq}` } }, reader);
    const shown = await byQq.json();
    expect(shown).toMatchObject({ id: author.id, qq: author.qq, activated: true });
    expect(Object.keys(shown)).toEqual(
      expect.arrayContaining(["card", "joined_at", "last_sent_at"]),
    );
    expect((await api.users[":user"].$get({ param: { user: "999999" } })).status).toBe(404);
  });

  test("回复列表：最新的在前，正文是纯文本摘要；删掉的不列，访客看不到仅成员版块里的", async () => {
    const open = await thread("open", "公开版块的帖子");
    const inner = await thread("inner", "仅成员版块的帖子");
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
      "仅成员版块的帖子：成员才能看的回复",
      "公开版块的帖子：第一条回复",
    ]);
    expect((await list(guest))[0]).toBe("公开版块的帖子：第一条回复");

    const threads = await api.users[":user"].threads.$get(
      { param: { user: String(author.id) }, query: {} },
      guest,
    );
    if (!threads.ok) throw new Error(`status ${threads.status}`);
    expect((await threads.json()).items.map((t) => t.title).slice(0, 2)).toEqual([
      "公开版块的帖子",
      "统计用的帖子",
    ]);
  });
});

async function relation(who: Who) {
  const res = await api.users[":user"].$get({ param: { user: String(author.id) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const user = await res.json();
  if (user.members_only) throw new Error("members only");
  const { stats, followed, endorsed } = user;
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

async function person() {
  const { id } = await createUser();
  return { id, who: as(await login(id)) };
}

async function opening(threadId: number) {
  const res = await api.threads[":id"].posts.$get({ param: { id: String(threadId) }, query: {} });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items[0].id;
}

function like(postId: number, who: Who) {
  return api.posts[":id"].reaction.$put(
    { param: { id: String(postId) }, json: { emoji: "heart" } },
    who,
  );
}

async function summary(userId: number, who: Who) {
  const res = await api.users[":user"].summary.$get({ param: { user: String(userId) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("赞过、概要和关系", () => {
  test("赞过和概要不算匿名楼层；关掉公开后别人看不到，也不出现在别人的名单里", async () => {
    const [writer, fan] = await Promise.all([person(), person()]);
    const created = await api.threads.$post(
      { json: { board: "open", title: "求赞的帖子", content: { markdown: "正文" } } },
      writer.who,
    );
    if (!created.ok) throw new Error(`status ${created.status}`);
    const liked = await opening((await created.json()).id);
    const hidden = await api.threads.$post(
      {
        json: {
          board: "open",
          title: "匿名求赞的帖子",
          content: { markdown: "匿名" },
          anonymous: true,
        },
      },
      writer.who,
    );
    if (!hidden.ok) throw new Error(`status ${hidden.status}`);
    await like(liked, fan.who);
    await like(await opening((await hidden.json()).id), fan.who);

    const likes = async (who: Who) =>
      api.users[":user"].likes.$get({ param: { user: String(fan.id) }, query: {} }, who);
    const seen = await likes(reader);
    if (!seen.ok) throw new Error(`status ${seen.status}`);
    expect((await seen.json()).items.map((p) => [p.thread.title, p.emoji])).toEqual([
      ["匿名求赞的帖子", "heart"],
      ["求赞的帖子", "heart"],
    ]);
    expect((await likes(guest)).status).toBe(401);

    expect(await summary(writer.id, reader)).toMatchObject({
      top_posts: [{ id: liked, like_count: 1 }],
      likers: [{ user: { id: fan.id }, count: 1 }],
    });
    expect(await summary(writer.id, guest)).toMatchObject({ likers: null, liked: null });

    await api.me.$patch({ json: { relations_public: false } }, fan.who);
    expect(await (await likes(reader)).json()).toMatchObject({
      error: { code: "relations_hidden" },
    });
    expect((await likes(fan.who)).status).toBe(200);
    expect(await summary(writer.id, reader)).toMatchObject({ likers: [] });
    expect(await summary(fan.id, reader)).toMatchObject({ likers: null, liked: null });
  });

  test("关注、粉丝、认可的名单；被采纳的回答", async () => {
    const [asker, helper] = await Promise.all([person(), person()]);
    await api.users[":user"].follow.$put({ param: { user: String(asker.id) } }, helper.who);
    await api.users[":user"].endorsement.$put({ param: { user: String(helper.id) } }, asker.who);
    const people = async (user: number, list: "followers" | "endorsing" | "endorsers") => {
      const res = await api.users[":user"].relations.$get(
        { param: { user: String(user) }, query: { list } },
        reader,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items.map((p) => p.user.id);
    };
    expect(await people(asker.id, "followers")).toEqual([helper.id]);
    expect(await people(asker.id, "endorsing")).toEqual([helper.id]);
    expect(await people(helper.id, "endorsers")).toEqual([asker.id]);

    const asked = await api.threads.$post(
      {
        json: {
          board: "open",
          title: "求助一个问题",
          kind: "question",
          content: { markdown: "怎么办" },
        },
      },
      asker.who,
    );
    if (!asked.ok) throw new Error(`status ${asked.status}`);
    const param = { id: String((await asked.json()).id) };
    const answer = async (markdown: string) => {
      const res = await api.threads[":id"].posts.$post(
        { param, json: { content: { markdown } } },
        helper.who,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).id;
    };
    const accepted = await answer("这样办");
    await answer("补充一句");
    await api.threads[":id"].answers[":post"].$put(
      { param: { ...param, post: String(accepted) } },
      asker.who,
    );
    const solved = await api.users[":user"].posts.$get(
      { param: { user: String(helper.id) }, query: { solved: "true" } },
      guest,
    );
    if (!solved.ok) throw new Error(`status ${solved.status}`);
    expect((await solved.json()).items.map((p) => p.id)).toEqual([accepted]);
  });
});
