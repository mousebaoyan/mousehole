import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";
import { summarizeDays } from "./service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who = as("");
let bot: Who = { headers: {} };

beforeAll(async () => {
  const { id } = await createUser("admin");
  admin = as(await login(id));
  const { token } = await createBotToken(
    { userId: id, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq: nextQq(), scopes: ["read", "act", "sync"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` } };
  await api.boards.$post({ json: { slug: "stats", name: "数据" } }, admin);
});

async function stats(range: "7" | "30" = "7") {
  const res = await api.admin.stats.$get({ query: { range } }, admin);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

// Today, or this many days before it.
async function day(back = 0) {
  const { days } = await stats();
  return days[days.length - 1 - back];
}

// A Beijing day this many days back, as the database counts it.
const dayAgo = (days: number) =>
  sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date - ${days}::integer`;

async function activeOn(userId: number, ...days: number[]) {
  await db
    .insertInto("active_days")
    .values(days.map((d) => ({ user_id: userId, day: dayAgo(d), site: true })))
    .execute();
}

function threadAs(qq: number) {
  return api.threads.$post(
    { json: { board: "stats", title: "群里来的帖子", content: { markdown: "正文" } } },
    { headers: { ...bot.headers, "x-act-as": `qq:${qq}` } },
  );
}

describe("活跃", () => {
  test("登录算论坛，bot 代发算群里，两样都有的人合起来只算一次；站长不算", async () => {
    const before = (await day()).active;
    const visitor = await createUser();
    await login(visitor.id);
    const speaker = await createUser();
    expect((await threadAs(speaker.qq)).status).toBe(201);
    const both = await createUser();
    await login(both.id);
    expect((await threadAs(both.qq)).status).toBe(201);
    await ownerSession();

    const after = (await day()).active;
    expect({
      site: after.site - before.site,
      qq: after.qq - before.qq,
      total: after.total - before.total,
    }).toEqual({ site: 2, qq: 2, total: 3 });
  });

  test("成员同步里最后发言时间往后移的人，算那天在群里活跃", async () => {
    const group = 700001;
    await api.admin.groups.$post({ json: { group_id: group } }, await ownerSession());
    const qq = nextQq();
    const now = Math.floor(Date.now() / 1000);
    const before = (await day(1)).active;
    const res = await api.bot.groups[":group_id"].members.$put(
      {
        param: { group_id: String(group) },
        json: { observed_at: now - 60, members: [{ user_id: qq, last_sent_time: now - 86400 }] },
      },
      bot,
    );
    expect(res.status).toBe(200);
    const after = (await day(1)).active;
    expect({ qq: after.qq - before.qq, site: after.site - before.site }).toEqual({
      qq: 1,
      site: 0,
    });
  });

  test("平均日活只算过完了的天；周活、月活是截至最后一天的 7 天、30 天里来过的人", async () => {
    const before = (await stats()).totals;
    const { id } = await createUser();
    await activeOn(id, 0, 1, 2, 8);

    const after = (await stats()).totals;
    // Days 1 and 2 of the 6 whole days; day 8 of the 7 days before them.
    expect(after.now.dau.site - before.now.dau.site).toBeCloseTo(2 / 6);
    expect(after.before.dau.site - before.before.dau.site).toBeCloseTo(1 / 7);
    expect(after.now.wau.site - before.now.wau.site).toBe(1);
    expect(after.now.mau.site - before.now.mau.site).toBe(1);
    expect(after.before.wau.site - before.before.wau.site).toBe(1);
  });
});

describe("留存", () => {
  test("按激活的那一周分组，数之后几周来过论坛的人；那一周还没过完时为 null", async () => {
    const { id } = await createUser();
    const monday = sql<Date>`(date_trunc('week', now() AT TIME ZONE 'Asia/Shanghai')::date - 21)`;
    await db
      .updateTable("users")
      .set({ activated_at: sql<Date>`(${monday} + time '10:00') AT TIME ZONE 'Asia/Shanghai'` })
      .where("id", "=", id)
      .execute();
    // In its first week after, not its second.
    await db
      .insertInto("active_days")
      .values({ user_id: id, day: sql<Date>`${monday} + 9`, site: true })
      .execute();

    const { week } = await db
      .selectNoFrom(sql<string>`${monday}::text`.as("week"))
      .executeTakeFirstOrThrow();
    expect((await stats()).retention.find((r) => r.week === week)).toEqual({
      week,
      size: 1,
      back: [1, 0, null, null],
    });
  });
});

test("每小时汇总今天的阅读和成员数", async () => {
  await summarizeDays();
  const before = await day();
  const { id } = await createUser();
  await db
    .insertInto("user_days")
    .values({ user_id: id, day: dayAgo(0), read_seconds: 120, posts_read: 3 })
    .execute();

  await summarizeDays();
  const after = await day();
  expect({
    read_seconds: after.read_seconds - before.read_seconds,
    posts_read: after.posts_read - before.posts_read,
    members: Number(after.members) - Number(before.members),
    activated: Number(after.activated) - Number(before.activated),
  }).toEqual({ read_seconds: 120, posts_read: 3, members: 1, activated: 0 });
});

test("按天数三种方式各登录了几次，同一个人登录几次算几次；站长不算", async () => {
  const before = await stats();
  const { id } = await createUser();
  await login(id);
  await login(id);
  await ownerSession();
  await db
    .insertInto("audit_logs")
    .values(
      (["code", "email"] as const).map((method) => ({
        actor_id: id,
        action: "auth.login",
        data: JSON.stringify({ method }),
        created_at: sql<Date>`now() - interval '1 day'`,
      })),
    )
    .execute();

  const after = await stats();
  const change = (back: number) => {
    const was = before.days[before.days.length - 1 - back].logins;
    const is = after.days[after.days.length - 1 - back].logins;
    return { code: is.code - was.code, link: is.link - was.link, email: is.email - was.email };
  };
  expect([change(0), change(1)]).toEqual([
    { code: 0, link: 2, email: 0 },
    { code: 1, link: 0, email: 1 },
  ]);
  expect(after.totals.now.logins.link - before.totals.now.logins.link).toBe(2);
});

test("只有管理员能看", async () => {
  const member = as(await login((await createUser()).id));
  expect((await api.admin.stats.$get({ query: {} }, member)).status).toBe(403);
});
