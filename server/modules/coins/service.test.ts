import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";
import { recordSeen } from "../users/service.ts";
import { settleCoins } from "./service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

const GROUP = 700001;
let bot: Who = { headers: {} };
let admin: Who = { headers: {} };

beforeAll(async () => {
  const { id } = await createUser("admin");
  admin = as(await login(id));
  const { token } = await createBotToken(
    { userId: id, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "act", "sync"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  await api.admin.groups.$post({ json: { group_id: GROUP } }, await ownerSession());
  await api.boards.$post({ json: { slug: "talk", name: "闲聊" } }, admin);
  await api.boards.$post({ json: { slug: "qa", name: "问答", default_kind: "question" } }, admin);
});

async function person() {
  const { id, qq } = await createUser();
  return { id, qq, who: as(await login(id)) };
}

async function coins(userId: number) {
  const row = await db
    .selectFrom("coin_balances")
    .select("coins")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.coins ?? 0;
}

function ledger(userId: number) {
  return db
    .selectFrom("coin_ledger")
    .select(["reason", "amount", sql<string>`day::text`.as("day")])
    .where("user_id", "=", userId)
    .orderBy("id")
    .execute();
}

const TODAY = sql<string>`(now() AT TIME ZONE 'Asia/Shanghai')::date::text`;
const YESTERDAY = sql<string>`((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)::text`;
// Noon yesterday, Beijing time.
const YESTERDAY_NOON = sql<Date>`(date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')
  - interval '12 hours') AT TIME ZONE 'Asia/Shanghai'`;

async function day(which: typeof TODAY) {
  return (await sql<{ day: string }>`SELECT ${which} AS day`.execute(db)).rows[0].day;
}

function spoke(qq: number, daysAgo: number) {
  const now = Math.floor(Date.now() / 1000);
  return api.bot.groups[":group_id"].members.$patch(
    {
      param: { group_id: String(GROUP) },
      json: { observed_at: now, members: [{ user_id: qq, last_sent_time: now - daysAgo * 86400 }] },
    },
    bot,
  );
}

async function thread(who: Who, board = "talk", anonymous = false) {
  const res = await api.threads.$post(
    { json: { board, title: "四非保研经验", content: { markdown: "正文" }, anonymous } },
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

async function opening(threadId: number) {
  const res = await api.threads[":id"].posts.$get({ param: { id: String(threadId) }, query: {} });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items[0].id;
}

function react(who: Who, postId: number, emoji: "heart" | "+1" = "heart") {
  return api.posts[":id"].reaction.$put({ param: { id: String(postId) }, json: { emoji } }, who);
}

describe("鼠币", () => {
  test("打开论坛和在群里发言，一天只算一次签到；群里的发言只认今天和昨天，冻结的账号不算", async () => {
    const member = await person();
    await recordSeen(member.id);
    expect((await spoke(member.qq, 0)).status).toBe(200);
    expect(await ledger(member.id)).toEqual([
      { reason: "check_in", amount: 2, day: await day(TODAY) },
    ]);

    const quiet = nextQq();
    await spoke(quiet, 1);
    const { id } = await db
      .selectFrom("users")
      .select("id")
      .where("qq", "=", quiet)
      .executeTakeFirstOrThrow();
    expect(await ledger(id)).toEqual([
      { reason: "check_in", amount: 2, day: await day(YESTERDAY) },
    ]);

    const long = nextQq();
    await spoke(long, 3);
    const gone = await createUser();
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", gone.id)
      .execute();
    await recordSeen(gone.id);
    const rows = await db
      .selectFrom("coin_ledger")
      .innerJoin("users", "users.id", "coin_ledger.user_id")
      .select("users.id")
      .where((eb) => eb.or([eb("users.qq", "=", long), eb("users.id", "=", gone.id)]))
      .execute();
    expect(rows).toEqual([]);
  });

  test("获赞一个人一天只算一次，采纳一天最多一次；撤回的、删掉的、匿名的不算，结算过的不再改", async () => {
    const author = await person();
    const asker = await person();
    const [fan, friend, other] = [await person(), await person(), await person()];

    const own = await thread(author.who);
    const first = await opening(own);
    const second = await reply(author.who, own);
    await react(fan.who, first);
    await react(fan.who, second, "+1");
    await react(friend.who, first);
    await react(other.who, second);
    await api.posts[":id"].reaction.$delete({ param: { id: String(second) } }, other.who);
    await react(other.who, await opening(await thread(author.who, "talk", true)));
    const removed = await reply(author.who, own);
    await react(other.who, removed);
    await api.posts[":id"].$delete({ param: { id: String(removed) } }, author.who);

    const question = await thread(asker.who, "qa");
    for (const answer of [await reply(author.who, question), await reply(author.who, question)]) {
      const accepted = await api.threads[":id"].answers[":post"].$put(
        { param: { id: String(question), post: String(answer) } },
        asker.who,
      );
      expect(accepted.status).toBe(200);
    }

    await db.updateTable("reactions").set({ created_at: YESTERDAY_NOON }).execute();
    await db
      .updateTable("posts")
      .set({ accepted_at: YESTERDAY_NOON })
      .where("accepted_at", "is not", null)
      .execute();
    await settleCoins();
    const yesterday = await day(YESTERDAY);
    expect(await ledger(author.id)).toEqual([
      { reason: "check_in", amount: 2, day: await day(TODAY) },
      { reason: "liked", amount: 2, day: yesterday },
      { reason: "accepted", amount: 10, day: yesterday },
    ]);
    expect(await coins(author.id)).toBe(14);

    await react(other.who, first);
    await db.updateTable("reactions").set({ created_at: YESTERDAY_NOON }).execute();
    await settleCoins();
    expect(await coins(author.id)).toBe(14);
  });

  test("发问答帖消耗 1 鼠币，不够就只能发讨论帖；从群里收录来的不扣", async () => {
    const member = await person();
    await thread(member.who, "qa");
    await thread(member.who, "qa");
    expect(await coins(member.id)).toBe(0);
    const res = await api.threads.$post(
      { json: { board: "qa", title: "rank 30% 能冲吗", content: { markdown: "求问" } } },
      member.who,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "coins_insufficient" } });
    expect(
      (
        await api.threads.$post(
          {
            json: {
              board: "qa",
              title: "rank 30% 能冲吗",
              content: { markdown: "求问" },
              kind: "discussion",
            },
          },
          member.who,
        )
      ).status,
    ).toBe(201);

    const collected = await api.threads.$post(
      {
        json: {
          board: "qa",
          title: "群里问的问题",
          content: { markdown: "rank 30% 能冲吗" },
          source: { chat_type: "group", chat_id: GROUP, message_ids: [1] },
        },
      },
      { headers: { ...bot.headers, "x-act-as": `qq:${member.qq}` } },
    );
    expect(collected.status).toBe(201);
    const page = await api.me.coins.$get({ query: {} }, member.who);
    if (!page.ok) throw new Error(`status ${page.status}`);
    const { coins: left, items } = await page.json();
    expect(left).toBe(0);
    expect(items.map((i) => [i.reason, i.amount])).toEqual([
      ["question", -1],
      ["question", -1],
      ["check_in", 2],
    ]);
    expect(items[0].thread).toMatchObject({ title: "四非保研经验" });
  });

  test("排行榜按挣到的鼠币排，花掉的不扣，冻结的账号不进；只给成员看", async () => {
    const [rich, spender, gone] = [await person(), await person(), await person()];
    await db
      .insertInto("coin_ledger")
      .values(
        [rich, spender, gone].map((p, i) => ({
          user_id: p.id,
          amount: [500, 400, 900][i],
          reason: "liked",
          day: sql<Date>`now()::date`,
        })),
      )
      .execute();
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", gone.id)
      .execute();
    await db
      .insertInto("coin_ledger")
      .values({
        user_id: rich.id,
        amount: -300,
        reason: "question",
        day: sql<Date>`now()::date`,
        thread_id: await thread(rich.who),
      })
      .execute();

    const res = await api.coins.leaderboard.$get({ query: { period: "all" } }, rich.who);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const top = (await res.json()).items.slice(0, 2);
    expect(top.map((i) => [i.user.id, i.earned])).toEqual([
      [rich.id, 502],
      [spender.id, 402],
    ]);
    expect((await api.coins.leaderboard.$get({ query: {} })).status).toBe(401);
  });
});
