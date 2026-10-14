import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

async function person(level: number, role: "user" | "moderator" | "admin" = "user") {
  const { id, qq } = await createUser(role, level);
  return { id, qq, who: as(await login(id)) };
}

let admin: Who;
let bot: Who;

beforeAll(async () => {
  const owner = await person(0, "admin");
  admin = owner.who;
  const { token } = await createBotToken(
    { userId: owner.id, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "act"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  await api.boards.$post({ json: { slug: "lv", name: "等级" } }, admin);
  await api.boards.$post({ json: { slug: "staff", name: "公告", post_role: "moderator" } }, admin);
});

function newThread(who: Who, json: { markdown?: string; anonymous?: boolean } = {}) {
  return api.threads.$post(
    {
      json: {
        board: "lv",
        title: "等级权限的帖子",
        content: { markdown: json.markdown ?? "正文" },
        anonymous: json.anonymous,
      },
    },
    who,
  );
}

async function threadBy(who: Who, anonymous = false) {
  const res = await newThread(who, { anonymous });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function patch(id: number, who: Who, json: { title?: string; board?: string; locked?: boolean }) {
  return api.threads[":id"].$patch({ param: { id: String(id) }, json }, who);
}

function poll(who: Who) {
  return api.threads.$post(
    {
      json: {
        board: "lv",
        title: "投个票吧大家",
        content: { markdown: "正文" },
        kind: "poll",
        poll: { options: ["甲", "乙"] },
      },
    },
    who,
  );
}

describe("等级的权限", () => {
  test("L0 每层最多 2 个站外链接，每天最多 3 个帖子；群里同步来的不算", async () => {
    const newcomer = await person(0);
    const links = "[一](https://a.example) [二](https://b.example) https://c.example";
    expect((await newThread(newcomer.who, { markdown: links })).status).toBe(403);
    for (let i = 0; i < 3; i++) expect((await newThread(newcomer.who)).status).toBe(201);
    const fourth = await newThread(newcomer.who);
    expect(fourth.status).toBe(403);
    if (fourth.ok) throw new Error("posted");
    expect((await fourth.json()).error.code).toBe("level_required");

    const synced = await api.threads.$post(
      {
        json: {
          board: "lv",
          title: "群里转来的问题",
          content: { markdown: links },
          source: { chat_type: "group", chat_id: 1, message_id: 1 },
        },
      },
      { headers: { ...bot.headers, "x-act-as": `qq:${newcomer.qq}` } },
    );
    expect(synced.status).toBe(201);
    expect((await newThread((await person(1)).who, { markdown: links })).status).toBe(201);
  });

  test("L2 起才能发投票帖", async () => {
    expect((await poll((await person(1)).who)).status).toBe(403);
    expect((await poll((await person(2)).who)).status).toBe(201);
  });

  test("L3 能改等级比自己低的人的帖子的标题和版块，只能移到自己能发帖的版块", async () => {
    const [low, peer, l3, moderator] = await Promise.all([
      person(1),
      person(3),
      person(3),
      person(0, "moderator"),
    ]);
    const theirs = await threadBy(low.who);
    expect((await patch(theirs.id, l3.who, { title: "改个更清楚的标题" })).status).toBe(200);
    expect((await patch(theirs.id, l3.who, { board: "staff" })).status).toBe(403);
    expect((await patch(theirs.id, l3.who, { locked: true })).status).toBe(403);

    // Not over equals, moderators, or anyone anonymous.
    for (const author of [peer, moderator]) {
      const thread = await threadBy(author.who);
      expect((await patch(thread.id, l3.who, { title: "改个更清楚的标题" })).status).toBe(403);
    }
    const hidden = await threadBy(low.who, true);
    expect((await patch(hidden.id, l3.who, { title: "改个更清楚的标题" })).status).toBe(403);
  });

  test("L5 能锁定等级比自己低的人的帖子，编辑他们的楼层；锁定后 L3 不能再改", async () => {
    const [low, l3, l5] = await Promise.all([person(1), person(3), person(5)]);
    const theirs = await threadBy(low.who);
    expect((await patch(theirs.id, l5.who, { locked: true })).status).toBe(200);
    expect((await patch(theirs.id, l3.who, { title: "改个更清楚的标题" })).status).toBe(403);

    const posts = await api.threads[":id"].posts.$get({
      param: { id: String(theirs.id) },
      query: {},
    });
    if (!posts.ok) throw new Error(`status ${posts.status}`);
    const opening = (await posts.json()).items[0];
    const edit = (who: Who) =>
      api.posts[":id"].$patch(
        { param: { id: String(opening.id) }, json: { content: { markdown: "改过的正文" } } },
        who,
      );
    expect((await edit(l3.who)).status).toBe(403);
    expect((await edit(l5.who)).status).toBe(200);
  });

  test("L4 举报等级比自己低的人的回复，这一层先隐藏，驳回后恢复；举报同级的不隐藏", async () => {
    const [low, peer, l4, reader, moderator] = await Promise.all([
      person(1),
      person(4),
      person(4),
      person(1),
      person(0, "moderator"),
    ]);
    const thread = await threadBy(reader.who);
    const replyBy = async (who: Who) => {
      const res = await api.threads[":id"].posts.$post(
        { param: { id: String(thread.id) }, json: { content: { markdown: "有问题的回复" } } },
        who,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).id;
    };
    const [lows, peers] = [await replyBy(low.who), await replyBy(peer.who)];
    for (const id of [lows, peers]) {
      await api.posts[":id"].report.$post(
        { param: { id: String(id) }, json: { reason: "广告" } },
        l4.who,
      );
    }
    const shown = async () => {
      const res = await api.threads[":id"].posts.$get(
        { param: { id: String(thread.id) }, query: {} },
        reader.who,
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items.map((p) => p.id);
    };
    expect(await shown()).not.toContain(lows);
    expect(await shown()).toContain(peers);

    const reports = await api.admin.reports.$get({ query: {} }, moderator.who);
    if (!reports.ok) throw new Error(`status ${reports.status}`);
    const held = (await reports.json()).items.find((r) => r.post.id === lows);
    expect(held).toMatchObject({ held: true });
    await api.admin.reports[":id"].$patch(
      { param: { id: String(held?.id) }, json: { status: "dismissed" } },
      moderator.who,
    );
    expect(await shown()).toContain(lows);
  });
});
