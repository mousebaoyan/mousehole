import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who = as("");
let bot: Who = { headers: {} };

beforeAll(async () => {
  const { id } = await createUser("admin");
  admin = as(await login(id));
  await api.boards.$post({ json: { slug: "open", name: "公开" } }, admin);
  await api.boards.$post(
    { json: { slug: "senior", name: "高级", visibility: "members", read_level: 3 } },
    admin,
  );
  const actor = { userId: id, operatorId: null, tokenId: null, ip: null, userAgent: null };
  const { token } = await createBotToken(actor, { name: "插件", botQq: 99999, scopes: ["read"] });
  bot = { headers: { authorization: `Bearer ${token}` } };
});

async function person() {
  const { id } = await createUser();
  return { id, who: as(await login(id)) };
}

async function thread(who: Who, board: string, anonymous = false) {
  const res = await api.threads.$post(
    { json: { board, title: `${board} 的帖子`, content: { markdown: "主楼" }, anonymous } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function reply(who: Who, threadId: number) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(threadId) }, json: { content: { markdown: "回复" } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function like(postId: number, times: number) {
  for (let i = 0; i < times; i++) {
    const liker = await createUser();
    await db
      .insertInto("reactions")
      .values({ post_id: postId, user_id: liker.id, emoji: "heart" })
      .execute();
  }
}

async function stats() {
  const res = await api.bot.stats.weekly.$get({ query: {} }, bot);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("周榜的统计", () => {
  test("帖子和人的榜单只算成员都能看的版块，人的榜单不算匿名的内容，更早的不算", async () => {
    const [writer, helper, hidden] = [await person(), await person(), await person()];
    const open = await thread(writer.who, "open");
    const answer = await reply(helper.who, open);
    await like(answer, 3);
    // Admins read every board; L1 members don't see this one.
    const secret = await thread(admin, "senior");
    await like(await reply(admin, secret), 9);
    const masked = await thread(hidden.who, "open", true);
    const maskedOpening = await db
      .selectFrom("posts")
      .select("id")
      .where("thread_id", "=", masked)
      .where("floor", "=", 1)
      .executeTakeFirstOrThrow();
    await like(maskedOpening.id, 5);
    const old = await reply(helper.who, open);
    await db
      .updateTable("posts")
      .set({ created_at: new Date(Date.now() - 8 * 24 * 3600_000) })
      .where("id", "=", old)
      .execute();

    const week = await stats();
    expect(week.threads.most_liked[0]).toMatchObject({
      thread: { id: masked },
      author: { anonymous: true },
      count: 5,
    });
    expect(week.threads.most_liked.map((t) => t.thread.id)).not.toContain(secret);
    expect(week.threads.most_replied.find((t) => t.thread.id === open)?.count).toBe(1);
    expect(week.people.most_liked[0]).toMatchObject({ user: { id: helper.id }, count: 3 });
    expect(week.people.most_liked.map((p) => p.user.id)).not.toContain(hidden.id);
    expect(week.people.most_replies.find((p) => p.user.id === helper.id)?.count).toBe(1);
    expect(week.overview.threads).toBe(2);
  });

  test("没有 read 范围不能看", async () => {
    const res = await api.bot.stats.weekly.$get({ query: {} });
    expect(res.status).toBe(401);
  });
});
