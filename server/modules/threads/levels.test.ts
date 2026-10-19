import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
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
  test("L0 每层最多 2 个站外链接，发出后改也一样，每天最多 3 个帖子；群里同步来的不算", async () => {
    const newcomer = await person(0);
    const links = "[一](https://a.example) [二](https://b.example) https://c.example";
    expect((await newThread(newcomer.who, { markdown: links })).status).toBe(403);
    for (let i = 0; i < 3; i++) expect((await newThread(newcomer.who)).status).toBe(201);
    const { id } = await db
      .selectFrom("posts")
      .select("id")
      .where("author_id", "=", newcomer.id)
      .executeTakeFirstOrThrow();
    const edited = await api.posts[":id"].$patch(
      { param: { id: String(id) }, json: { content: { markdown: links } } },
      newcomer.who,
    );
    expect(edited.status).toBe(403);
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
          source: { chat_type: "group", chat_id: 1, message_ids: [1] },
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

  test("L4 能改等级比自己低的人的帖子的标题和版块，只能移到自己能发帖的版块；L3 不能直接改", async () => {
    const [low, peer, l3, l4, moderator] = await Promise.all([
      person(1),
      person(4),
      person(3),
      person(4),
      person(0, "moderator"),
    ]);
    const theirs = await threadBy(low.who);
    expect((await patch(theirs.id, l3.who, { title: "改个更清楚的标题" })).status).toBe(403);
    expect((await patch(theirs.id, l4.who, { title: "改个更清楚的标题" })).status).toBe(200);
    expect((await patch(theirs.id, l4.who, { board: "staff" })).status).toBe(403);
    expect((await patch(theirs.id, l4.who, { locked: true })).status).toBe(403);

    // Not over equals, moderators, or anyone anonymous.
    for (const author of [peer, moderator]) {
      const thread = await threadBy(author.who);
      expect((await patch(thread.id, l4.who, { title: "改个更清楚的标题" })).status).toBe(403);
    }
    const hidden = await threadBy(low.who, true);
    expect((await patch(hidden.id, l4.who, { title: "改个更清楚的标题" })).status).toBe(403);
  });

  test("L5 能锁定等级比自己低的人的帖子，编辑他们的楼层；锁定后 L4 不能再改", async () => {
    const [low, l4, l5] = await Promise.all([person(1), person(4), person(5)]);
    const theirs = await threadBy(low.who);
    expect((await patch(theirs.id, l5.who, { locked: true })).status).toBe(200);
    expect((await patch(theirs.id, l4.who, { title: "改个更清楚的标题" })).status).toBe(403);

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
    expect((await edit(l4.who)).status).toBe(403);
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

  test("版块的阅读门槛：没达到的成员列表和搜索里没有，打开时告诉要几级；版主和访客各照规则", async () => {
    const created = await api.boards.$post(
      { json: { slug: "l3only", name: "高阶", read_level: 3 } },
      admin,
    );
    if (!created.ok) throw new Error(`status ${created.status}`);
    expect(await created.json()).toMatchObject({ visibility: "members", read_level: 3 });
    const [l1, l3, moderator] = await Promise.all([person(1), person(3), person(0, "moderator")]);
    const posted = await api.threads.$post(
      { json: { board: "l3only", title: "高阶版块的独门秘籍", content: { markdown: "正文" } } },
      l3.who,
    );
    if (!posted.ok) throw new Error(`status ${posted.status}`);
    const { id } = await posted.json();
    const param = { id: String(id) };

    const opened = await api.threads[":id"].$get({ param }, l1.who);
    expect(opened.status).toBe(403);
    if (opened.ok) throw new Error("opened");
    expect((await opened.json()).error).toMatchObject({ code: "level_required" });
    expect((await api.threads.$get({ query: { board: "l3only" } }, l1.who)).status).toBe(403);
    const listed = async (who: Who) => {
      const res = await api.threads.$get({ query: {} }, who);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items.map((t) => t.id);
    };
    expect(await listed(l1.who)).not.toContain(id);
    const found = await api.search.$get({ query: { q: "独门秘籍" } }, l1.who);
    if (!found.ok) throw new Error(`status ${found.status}`);
    expect((await found.json()).items).toEqual([]);

    expect(await listed(l3.who)).toContain(id);
    expect((await api.threads[":id"].$get({ param }, moderator.who)).status).toBe(200);
    expect((await api.threads[":id"].$get({ param })).status).toBe(404);
  });

  test("版块的发帖门槛", async () => {
    await api.boards.$post({ json: { slug: "l2post", name: "进阶", post_level: 2 } }, admin);
    const post = (who: Who) =>
      api.threads.$post(
        { json: { board: "l2post", title: "进阶版块的帖子", content: { markdown: "正文" } } },
        who,
      );
    expect((await post((await person(1)).who)).status).toBe(403);
    expect((await post((await person(2)).who)).status).toBe(201);
  });
});
