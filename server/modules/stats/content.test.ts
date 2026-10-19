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
  for (const slug of ["content", "rank-a", "rank-b"]) {
    await api.boards.$post({ json: { slug, name: slug } }, admin);
  }
  for (const name of ["排行一", "排行二"]) {
    await api.tags.$post({ json: { name, kind: "topic" } }, admin);
  }
});

async function stats() {
  const res = await api.admin.stats.$get({ query: { range: "7" } }, admin);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// A member acting through the bot.
function viaBot(qq: number) {
  return { headers: { ...bot.headers, "x-act-as": `qq:${qq}` } };
}

// Archived from a group message said then, in Unix seconds.
function archivedAt(said: number) {
  const source = { chat_type: "group" as const, chat_id: 1, message_ids: [++lastMessage] };
  return { source, created_at: said };
}

async function thread(
  who: Who,
  json: { board?: string; kind?: "question"; tags?: string[]; title?: string } = {},
  archived = {},
) {
  const res = await api.threads.$post(
    {
      json: {
        board: "content",
        title: "数据页的帖子",
        content: { markdown: "正文" },
        ...json,
        ...archived,
      },
    },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  const { id } = await res.json();
  const opening = await db
    .selectFrom("posts")
    .select("id")
    .where("thread_id", "=", id)
    .where("floor", "=", 1)
    .executeTakeFirstOrThrow();
  return { id, opening: opening.id };
}

async function reply(who: Who, threadId: number, archived = {}) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown: "回复" }, ...archived } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return (await res.json()).id;
}

async function react(who: Who, postId: number, archived = {}) {
  const res = await api.posts[":id"].reaction.$put(
    { param: { id: String(postId) }, json: { emoji: "heart", ...archived } },
    who,
  );
  expect(res.status).toBe(204);
}

async function member() {
  const { id, qq } = await createUser();
  return { id, qq, who: as(await login(id)) };
}

describe("内容", () => {
  test("按来源数公开的新帖、回复和表情回应，收录的算在群里发的那天，隐藏和删除的不算", async () => {
    const before = await stats();
    const yesterday = Math.floor(Date.now() / 1000) - 86_400;
    const reader = await member();
    const asker = await member();

    const t = await thread(admin);
    await reply(reader.who, t.id);
    await react(reader.who, t.opening);
    await reply(viaBot(asker.qq), t.id);
    await react(viaBot(asker.qq), t.opening);
    const archived = await thread(viaBot(asker.qq), {}, archivedAt(yesterday));
    await reply(viaBot(reader.qq), archived.id, archivedAt(yesterday));
    await react(viaBot(reader.qq), archived.opening, archivedAt(yesterday));

    // Hidden or deleted, with what is in them.
    const hidden = await thread(admin);
    await reply(reader.who, hidden.id);
    await react(reader.who, hidden.opening);
    await db.updateTable("threads").set({ status: "hidden" }).where("id", "=", hidden.id).execute();
    const deleted = await reply(asker.who, t.id);
    await react(reader.who, deleted);
    await db
      .updateTable("posts")
      .set({ deleted_at: new Date() })
      .where("id", "=", deleted)
      .execute();

    const after = await stats();
    const change = (back: number) => {
      const was = before.days[before.days.length - 1 - back].content;
      const is = after.days[after.days.length - 1 - back].content;
      const kinds = ["threads", "replies", "reactions"] as const;
      return Object.fromEntries(
        kinds.map((kind) => [
          kind,
          {
            web: is[kind].web - was[kind].web,
            bot: is[kind].bot - was[kind].bot,
            qq: is[kind].qq - was[kind].qq,
          },
        ]),
      );
    };
    expect(change(0)).toEqual({
      threads: { web: 1, bot: 0, qq: 0 },
      replies: { web: 1, bot: 1, qq: 0 },
      reactions: { web: 1, bot: 1, qq: 0 },
    });
    expect(change(1)).toEqual({
      threads: { web: 0, bot: 0, qq: 1 },
      replies: { web: 0, bot: 0, qq: 1 },
      reactions: { web: 0, bot: 0, qq: 1 },
    });
    expect(after.totals.now.content.replies.web - before.totals.now.content.replies.web).toBe(1);
  });

  test("问答帖只算论坛上发的：解决率、他人回复过的、首条他人回复等待时间的中位数", async () => {
    const answerer = await member();
    const asker = await member();
    // Asking costs coins.
    await db
      .updateTable("coin_balances")
      .set({ coins: 10 })
      .where("user_id", "=", asker.id)
      .execute();
    const hour = 3_600_000;
    const start = Date.now() - 5 * hour;
    // Asked at `start`; answered by others after these hours, or before it when negative.
    async function asked(answers: number[], { solved = false, archived = false } = {}) {
      const q = archived
        ? await thread(viaBot(asker.qq), { kind: "question" }, archivedAt(Math.floor(start / 1000)))
        : await thread(asker.who, { kind: "question" });
      await db
        .updateTable("threads")
        .set({ created_at: new Date(start), accepted_count: solved ? 1 : 0 })
        .where("id", "=", q.id)
        .execute();
      await reply(asker.who, q.id);
      for (const after of answers) {
        const id = await reply(answerer.who, q.id);
        await db
          .updateTable("posts")
          .set({ created_at: new Date(start + after * hour) })
          .where("id", "=", id)
          .execute();
      }
    }
    await asked([2, 3], { solved: true });
    await asked([0.5]);
    // Floors merged in from an older thread aren't answers to it, nor is the asker's own.
    await asked([-1]);
    await asked([1], { archived: true });

    expect((await stats()).totals.now.questions).toEqual({
      asked: 3,
      solved: 1,
      answered: 2,
      wait: 1.25 * 3600,
    });
  });
});

describe("排行", () => {
  test("按这段时间公开的新回复和表情回应合计排帖子、版块和标签", async () => {
    const people = await Promise.all([member(), member(), member()]);
    const a = await thread(admin, { board: "rank-a", tags: ["排行一"], title: "排行甲的帖子" });
    const b = await thread(admin, {
      board: "rank-b",
      tags: ["排行一", "排行二"],
      title: "排行乙的帖子",
    });
    const hidden = await thread(admin, {
      board: "rank-b",
      tags: ["排行二"],
      title: "隐藏了的帖子",
    });
    for (const p of people) {
      await reply(p.who, a.id);
      await react(p.who, a.opening);
      await react(p.who, b.opening);
      await reply(p.who, hidden.id);
      await reply(p.who, hidden.id);
    }
    // Before the range.
    const old = await reply(people[0].who, b.id);
    await db
      .updateTable("posts")
      .set({ created_at: new Date(Date.now() - 8 * 86_400_000) })
      .where("id", "=", old)
      .execute();
    await db.updateTable("threads").set({ status: "hidden" }).where("id", "=", hidden.id).execute();

    const { top } = await stats();
    const threads = top.threads.filter((t) => t.id === a.id || t.id === b.id);
    expect(threads).toEqual([
      { id: a.id, title: "排行甲的帖子", replies: 3, reactions: 3 },
      { id: b.id, title: "排行乙的帖子", replies: 0, reactions: 3 },
    ]);
    expect(top.threads.some((t) => t.id === hidden.id)).toBe(false);
    expect(top.boards.filter((x) => x.slug.startsWith("rank-"))).toEqual([
      { slug: "rank-a", name: "rank-a", replies: 3, reactions: 3 },
      { slug: "rank-b", name: "rank-b", replies: 0, reactions: 3 },
    ]);
    expect(top.tags).toEqual([
      { name: "排行一", replies: 3, reactions: 6 },
      { name: "排行二", replies: 0, reactions: 3 },
    ]);
  });
});
