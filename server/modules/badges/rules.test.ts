import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { checkBadges, syncBadges } from "./service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who;

beforeAll(async () => {
  await syncBadges();
  const { id } = await createUser("admin");
  admin = as(await login(id));
  await api.boards.$post({ json: { slug: "rules", name: "规则" } }, admin);
  // Every rule has run once, so what is earned from here on is announced.
  await checkBadges();
});

async function person() {
  const { id } = await createUser();
  return { id, who: as(await login(id)) };
}

async function thread(who: Who, anonymous = false) {
  const res = await api.threads.$post(
    { json: { board: "rules", title: "徽章规则", content: { markdown: "主楼" }, anonymous } },
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
  const post = await db
    .selectFrom("posts")
    .select("id")
    .where("thread_id", "=", threadId)
    .where("floor", "=", 1)
    .executeTakeFirstOrThrow();
  return post.id;
}

// Floors written straight into the table, with the counts they would have moved.
async function addFloors(threadId: number, authorId: number, count: number) {
  const { floor_count } = await db
    .updateTable("threads")
    .set((eb) => ({
      floor_count: eb("floor_count", "+", count),
      reply_count: eb("reply_count", "+", count),
    }))
    .where("id", "=", threadId)
    .returning(sql<number>`floor_count - ${count}`.as("floor_count"))
    .executeTakeFirstOrThrow();
  await sql`INSERT INTO posts (thread_id, floor, author_id, body, html)
    SELECT ${threadId}, f, ${authorId}, 'x', 'x'
    FROM generate_series(${floor_count + 1}::integer, ${floor_count + count}::integer) f`.execute(
    db,
  );
}

async function badgesOf(userId: number) {
  await checkBadges();
  return db
    .selectFrom("user_badges")
    .innerJoin("badges", "badges.id", "user_badges.badge_id")
    .select(["badges.slug", "user_badges.post_id"])
    .where("user_id", "=", userId)
    .execute();
}

async function slugsOf(userId: number) {
  return (await badgesOf(userId)).flatMap((b) => (b.slug === null ? [] : [b.slug]));
}

async function announced(userId: number) {
  const rows = await db
    .selectFrom("notifications")
    .select(sql<string>`data ->> 'name'`.as("name"))
    .where("user_id", "=", userId)
    .where("type", "=", "badge")
    .execute();
  return rows.map((r) => r.name);
}

async function users(count: number) {
  const made: { id: number }[] = [];
  for (let i = 0; i < count; i++) made.push(await createUser());
  return made;
}

// Whoever wrote a thread has a row for it from posting.
function bookmark(threadId: number, userId: number) {
  return db
    .insertInto("thread_users")
    .values({ thread_id: threadId, user_id: userId, bookmarked_at: new Date() })
    .onConflict((oc) =>
      oc.columns(["thread_id", "user_id"]).doUpdateSet({ bookmarked_at: new Date() }),
    )
    .execute();
}

const DAY = 86_400_000;

function member(userId: number, groupId: number, days: number, gone = false) {
  return db
    .insertInto("group_members")
    .values({
      group_id: groupId,
      user_id: userId,
      joined_at: new Date(Date.now() - days * DAY),
      left_at: gone ? new Date() : null,
      observed_at: new Date(),
    })
    .execute();
}

async function report(userId: number, threadId: number, status: "resolved" | "dismissed") {
  return db
    .insertInto("reports")
    .values({ post_id: await opening(threadId), reporter_id: userId, reason: "x", status })
    .execute();
}

function suggest(threadId: number, userId: number, status: "accepted" | "rejected") {
  return db
    .insertInto("thread_suggestions")
    .values({ thread_id: threadId, user_id: userId, title: "新标题", status })
    .execute();
}

function lottery(threadId: number, drawn: boolean) {
  return db
    .insertInto("lotteries")
    .values({
      thread_id: threadId,
      prizes: JSON.stringify([{ name: "奖", winners: 1 }]),
      entry: "button",
      draws_at: new Date(),
      seed: "seed",
      seed_hash: "hash",
      drawn_at: drawn ? new Date() : null,
    })
    .execute();
}

function poll(threadId: number, preset: string | null) {
  return db.insertInto("polls").values({ thread_id: threadId, preset }).execute();
}

function ledger(
  userId: number,
  amount: number,
  reason: "check_in" | "accepted" | "look",
  daysAgo: number,
  key = "teal",
) {
  return db
    .insertInto("coin_ledger")
    .values({
      user_id: userId,
      amount,
      reason,
      day: new Date(Date.now() - daysAgo * DAY),
      look_kind: reason === "look" ? "frame" : null,
      look_key: reason === "look" ? key : null,
    })
    .execute();
}

describe("更多徽章的规则", () => {
  test("后来新加的徽章第一次检查只补齐，不通知；之后得到的照常通知", async () => {
    const endorser = await person();
    const [first, second] = [await createUser(), await createUser()];
    await db
      .insertInto("endorsements")
      .values({ user_id: first.id, endorser_id: endorser.id })
      .execute();
    await db
      .updateTable("badges")
      .set({ caught_up_at: null })
      .where("slug", "=", "first_endorse")
      .execute();
    await thread(endorser.who);
    await checkBadges();
    expect(await slugsOf(endorser.id)).toContain("first_endorse");
    expect(await announced(endorser.id)).toContain("初次发帖");
    expect(await announced(endorser.id)).not.toContain("慧眼识鼠");

    const later = await person();
    await db
      .insertInto("endorsements")
      .values({ user_id: second.id, endorser_id: later.id })
      .execute();
    await checkBadges();
    expect(await announced(later.id)).toContain("慧眼识鼠");
  });

  test("收藏不算楼主自己的，层数不算楼主自己的；精华每个帖子各得一次", async () => {
    const author = await person();
    const fans = await users(5);

    const marked = await thread(author.who);
    await bookmark(marked, author.id);
    for (const fan of fans.slice(0, 4)) await bookmark(marked, fan.id);
    expect(await slugsOf(author.id)).not.toContain("bookmarked_5");
    await bookmark(marked, fans[4].id);
    expect(await badgesOf(author.id)).toContainEqual({
      slug: "bookmarked_5",
      post_id: await opening(marked),
    });

    const talked = await thread(author.who);
    await addFloors(talked, author.id, 30);
    expect(await slugsOf(author.id)).not.toContain("floors_30");
    const crowded = await thread(author.who);
    await addFloors(crowded, fans[0].id, 30);
    expect(await badgesOf(author.id)).toContainEqual({
      slug: "floors_30",
      post_id: await opening(crowded),
    });

    await db
      .updateTable("threads")
      .set({ featured: true })
      .where("id", "in", [marked, talked])
      .execute();
    const featured = (await badgesOf(author.id)).filter((b) => b.slug === "featured");
    expect(featured.map((b) => b.post_id)).toEqual(
      expect.arrayContaining([await opening(marked), await opening(talked)]),
    );
    expect(featured).toHaveLength(2);
  });

  test("揭榜挂帅：悬赏期间别人在论坛上的回复才算", async () => {
    const asker = await person();
    const [answerer, late, grouped] = [await person(), await person(), await person()];
    const bounty = await thread(asker.who);
    const lapsed = await thread(asker.who);
    await db
      .updateTable("threads")
      .set({ bounty_at: new Date(Date.now() - DAY / 24) })
      .where("id", "=", bounty)
      .execute();
    await db
      .updateTable("threads")
      .set({ bounty_at: new Date(Date.now() - 5 * DAY) })
      .where("id", "=", lapsed)
      .execute();
    await reply(answerer.who, bounty);
    await reply(asker.who, bounty);
    await reply(late.who, lapsed);
    const fromGroup = await reply(grouped.who, bounty);
    await db.updateTable("posts").set({ via: "qq" }).where("id", "=", fromGroup).execute();

    expect(await slugsOf(answerer.id)).toContain("bounty_reply");
    expect(await slugsOf(asker.id)).not.toContain("bounty_reply");
    expect(await slugsOf(late.id)).not.toContain("bounty_reply");
    expect(await slugsOf(grouped.id)).not.toContain("bounty_reply");
  });

  test("累计阅读、访问天数和回复数到了门槛才有，匿名的不算", async () => {
    const [near, enough] = [await createUser(), await createUser()];
    await db
      .updateTable("users")
      .set({ read_seconds: 10 * 3600 - 1, days_visited: 59 })
      .where("id", "=", near.id)
      .execute();
    await db
      .updateTable("users")
      .set({ read_seconds: 10 * 3600, days_visited: 60 })
      .where("id", "=", enough.id)
      .execute();
    const home = await thread(admin);
    await addFloors(home, near.id, 50);
    await addFloors(home, enough.id, 50);
    await db
      .updateTable("posts")
      .set({ anonymous: true })
      .where("id", "=", sql<number>`(SELECT max(id) FROM posts WHERE author_id = ${near.id})`)
      .execute();

    const short = await slugsOf(near.id);
    for (const slug of ["hours_10", "visits_60", "replies_50"]) expect(short).not.toContain(slug);
    const got = await slugsOf(enough.id);
    expect(got).toEqual(expect.arrayContaining(["hours_10", "visits_60", "replies_50"]));
    for (const slug of ["hours_40", "visits_200", "replies_200"]) expect(got).not.toContain(slug);
  });

  test("给别人的楼层留过表情：自己的、已删除的不算", async () => {
    const fan = await createUser();
    const writer = await createUser();
    const home = await thread(admin);
    await addFloors(home, writer.id, 100);
    await addFloors(home, fan.id, 1);
    await db
      .updateTable("posts")
      .set({ deleted_at: new Date() })
      .where("thread_id", "=", home)
      .where("floor", "=", 2)
      .execute();
    const react = (where: ReturnType<typeof sql>) =>
      sql`INSERT INTO reactions (post_id, user_id, emoji)
        SELECT id, ${fan.id}, '+1' FROM posts
        WHERE thread_id = ${home} AND (${where})`.execute(db);
    await react(sql`floor BETWEEN 2 AND 100 OR author_id = ${fan.id}`);
    expect(await slugsOf(fan.id)).not.toContain("given_100");
    await react(sql`floor = 101`);
    expect(await slugsOf(fan.id)).not.toContain("given_100");
    await db
      .updateTable("posts")
      .set({ deleted_at: null })
      .where("thread_id", "=", home)
      .where("floor", "=", 2)
      .execute();
    expect(await slugsOf(fan.id)).toContain("given_100");
  });

  test("在群里待满：还在启用的群里才算，离开的和停用的群不算", async () => {
    const [veteran, steady, left, retired, recent] = [
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const [active, stopped] = [920_001, 920_002];
    await db
      .insertInto("qq_groups")
      .values([
        { id: active, name: "在用的群", enabled: true },
        { id: stopped, name: "停用的群", enabled: false },
      ])
      .execute();
    await member(veteran.id, active, 800);
    await member(steady.id, active, 400);
    await member(left.id, active, 800, true);
    await member(retired.id, stopped, 800);
    await member(recent.id, active, 100);

    expect(await slugsOf(veteran.id)).toEqual(expect.arrayContaining(["group_1y", "group_2y"]));
    const mid = await slugsOf(steady.id);
    expect(mid).toContain("group_1y");
    expect(mid).not.toContain("group_2y");
    for (const none of [left, retired, recent]) {
      expect(await slugsOf(none.id)).not.toContain("group_1y");
    }
  });

  test("粉丝和认可到了门槛才有", async () => {
    const [popular, almost] = [await createUser(), await createUser()];
    const crowd = await users(10);
    await db
      .insertInto("user_follows")
      .values(crowd.map((c) => ({ followee_id: popular.id, follower_id: c.id })))
      .execute();
    await db
      .insertInto("user_follows")
      .values(crowd.slice(1).map((c) => ({ followee_id: almost.id, follower_id: c.id })))
      .execute();
    await db
      .insertInto("endorsements")
      .values(crowd.map((c) => ({ user_id: popular.id, endorser_id: c.id })))
      .execute();
    await db
      .insertInto("endorsements")
      .values(crowd.slice(1).map((c) => ({ user_id: almost.id, endorser_id: c.id })))
      .execute();

    expect(await slugsOf(popular.id)).toEqual(
      expect.arrayContaining(["followers_10", "endorsed_10"]),
    );
    const got = await slugsOf(almost.id);
    expect(got).not.toContain("followers_10");
    expect(got).not.toContain("endorsed_10");
  });

  test("共建：采纳的举报和修改建议、开过奖的抽奖、不是保研定位的投票帖", async () => {
    const [reporter, dismissed, suggester, rejected] = [
      await createUser(),
      await createUser(),
      await createUser(),
      await createUser(),
    ];
    const target = await person();
    const [first, second] = [await thread(target.who), await thread(target.who)];
    await report(reporter.id, first, "resolved");
    await report(reporter.id, second, "dismissed");
    await report(dismissed.id, first, "dismissed");
    await suggest(first, suggester.id, "accepted");
    await suggest(first, rejected.id, "rejected");

    expect(await slugsOf(reporter.id)).toContain("reports_1");
    expect(await slugsOf(reporter.id)).not.toContain("reports_10");
    expect(await slugsOf(dismissed.id)).not.toContain("reports_1");
    expect(await slugsOf(suggester.id)).toContain("proofreader");
    expect(await slugsOf(rejected.id)).not.toContain("proofreader");

    const [host, waiting, voter, positioner, secret] = [
      await person(),
      await person(),
      await person(),
      await person(),
      await person(),
    ];
    await lottery(await thread(host.who), true);
    await lottery(await thread(waiting.who), false);
    await poll(await thread(voter.who), null);
    await poll(await thread(positioner.who), "positioning");
    await poll(await thread(secret.who, true), null);

    expect(await slugsOf(host.id)).toContain("lottery_host");
    expect(await slugsOf(waiting.id)).not.toContain("lottery_host");
    expect(await slugsOf(voter.id)).toContain("poll_host");
    expect(await slugsOf(positioner.id)).not.toContain("poll_host");
    expect(await slugsOf(secret.id)).not.toContain("poll_host");
  });

  test("投喂鼠：确认过、不匿名的赞助才算", async () => {
    const [shown, hidden, waiting] = [await createUser(), await createUser(), await createUser()];
    const paid = { amount: 700, method: "wechat" } as const;
    await db
      .insertInto("sponsorships")
      .values([
        { ...paid, user_id: shown.id, status: "confirmed" },
        { ...paid, user_id: hidden.id, status: "confirmed", anonymous: true },
        { ...paid, user_id: waiting.id },
      ])
      .execute();

    expect(await slugsOf(shown.id)).toContain("sponsor");
    expect(await slugsOf(hidden.id)).not.toContain("sponsor");
    expect(await slugsOf(waiting.id)).not.toContain("sponsor");
  });

  test("鼠币按挣到的算，花掉的不扣；兑换的装扮按款数", async () => {
    const [saver, spender, poor] = [await createUser(), await createUser(), await createUser()];
    await ledger(saver.id, 60, "check_in", 2);
    await ledger(saver.id, 60, "check_in", 1);
    await ledger(saver.id, -50, "look", 0);
    await ledger(spender.id, 400, "accepted", 0);
    for (const key of ["a", "b", "c", "d"]) await ledger(spender.id, -10, "look", 0, key);
    await ledger(poor.id, 99, "check_in", 0);

    const got = await slugsOf(saver.id);
    expect(got).toEqual(expect.arrayContaining(["coins_100", "looks_1"]));
    expect(got).not.toContain("coins_400");
    expect(got).not.toContain("looks_4");
    expect(await slugsOf(spender.id)).toEqual(
      expect.arrayContaining(["coins_100", "coins_400", "looks_1", "looks_4"]),
    );
    expect(await slugsOf(spender.id)).not.toContain("coins_1200");
    expect(await slugsOf(poor.id)).not.toContain("coins_100");
  });

  test("精装鼠洞要背景、头像框、主题色和展柜都有", async () => {
    const [done, partly] = [await createUser(), await createUser()];
    const set = { background: "mist", frame: "teal", theme: "teal", showcase: "我的展柜" };
    await db.updateTable("users").set(set).where("id", "=", done.id).execute();
    await db
      .updateTable("users")
      .set({ ...set, showcase: null })
      .where("id", "=", partly.id)
      .execute();

    expect(await slugsOf(done.id)).toContain("decorated");
    expect(await slugsOf(partly.id)).not.toContain("decorated");
  });

  test("夜行鼠、早起的鼠儿、守岁鼠按北京时间的发布时间算，是隐藏徽章", async () => {
    const home = await thread(admin);
    const postedAt = async (time: string) => {
      const { id, who } = await person();
      const post = await reply(who, home);
      await db
        .updateTable("posts")
        .set({ created_at: new Date(time) })
        .where("id", "=", post)
        .execute();
      return id;
    };
    const night = await postedAt("2026-11-03T03:00:00+08:00");
    const dawn = await postedAt("2026-11-03T04:59:59+08:00");
    const early = await postedAt("2026-11-03T05:00:00+08:00");
    const morning = await postedAt("2026-11-03T06:59:59+08:00");
    const noon = await postedAt("2026-11-03T07:00:00+08:00");
    const small = await postedAt("2026-11-03T02:59:59+08:00");
    const eve = await postedAt("2027-02-05T18:00:00+08:00");
    const before = await postedAt("2027-02-05T17:59:59+08:00");
    const nextDay = await postedAt("2027-02-06T19:00:00+08:00");

    const got = new Map<number, string[]>();
    for (const id of [night, dawn, early, morning, noon, small, eve, before, nextDay]) {
      got.set(id, await slugsOf(id));
    }
    const fun = (id: number) =>
      got.get(id)?.filter((s) => ["night_owl", "early_bird", "new_year_eve"].includes(s));
    expect(fun(night)).toEqual(["night_owl"]);
    expect(fun(dawn)).toEqual(["night_owl"]);
    expect(fun(early)).toEqual(["early_bird"]);
    expect(fun(morning)).toEqual(["early_bird"]);
    expect(fun(noon)).toEqual([]);
    expect(fun(small)).toEqual([]);
    expect(fun(eve)).toEqual(["new_year_eve"]);
    expect(fun(before)).toEqual([]);
    expect(fun(nextDay)).toEqual([]);

    const hidden = await db
      .selectFrom("badges")
      .select("slug")
      .where("hidden", "=", true)
      .execute();
    expect(new Set(hidden.map((b) => b.slug))).toEqual(
      new Set(["early_bird", "new_year_eve", "night_owl"]),
    );
  });

  test("集邮鼠按得到的种数算，手动授予的也算", async () => {
    const collector = await createUser();
    const kinds = await db
      .selectFrom("badges")
      .select("id")
      .where("slug", "not in", ["badges_15", "badges_30"])
      .orderBy("id")
      .limit(15)
      .execute();
    const give = (ids: { id: number }[]) =>
      db
        .insertInto("user_badges")
        .values(ids.map((b) => ({ user_id: collector.id, badge_id: b.id })))
        .execute();
    await give(kinds.slice(0, 14));
    expect(await slugsOf(collector.id)).not.toContain("badges_15");
    await give(kinds.slice(14));
    expect(await slugsOf(collector.id)).toContain("badges_15");
    expect(await slugsOf(collector.id)).not.toContain("badges_30");
  });
});

async function named(name: string, who?: Who) {
  const res = await api.badges.$get({}, who);
  const badge = (await res.json()).items.find((b) => b.name === name);
  if (!badge) throw new Error(`no badge ${name}`);
  return badge;
}

describe("徽章的读取", () => {
  test("隐藏徽章没得到的人只看到一句提示，得到的人看得到怎么得到", async () => {
    const owner = await person();
    const other = await person();
    const home = await thread(admin);
    const post = await reply(owner.who, home);
    await db
      .updateTable("posts")
      .set({ created_at: new Date("2026-11-03T03:30:00+08:00") })
      .where("id", "=", post)
      .execute();
    await checkBadges();

    const hint = "获得后揭晓条件";
    const secret = await named("夜行鼠");
    expect(secret).toMatchObject({ hidden: true, description: hint, granted: 0 });
    expect(await named("夜行鼠", other.who)).toMatchObject({ description: hint });
    expect(await named("夜行鼠", owner.who)).toMatchObject({
      description: "北京时间凌晨 3 点到 5 点发过内容",
      granted: 1,
    });
    expect(await named("钻书堆")).toMatchObject({ hidden: false, description: "累计阅读 10 小时" });

    const ofOwner = async (who?: Who) => {
      const res = await api.users[":user"].badges.$get({ param: { user: String(owner.id) } }, who);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items.find((b) => b.name === "夜行鼠")?.description;
    };
    expect(await ofOwner()).toBe(hint);
    expect(await ofOwner(other.who)).toBe(hint);
    expect(await ofOwner(owner.who)).toBe("北京时间凌晨 3 点到 5 点发过内容");

    const detail = await api.badges[":id"].$get({ param: { id: String(secret.id) }, query: {} });
    if (!detail.ok) throw new Error(`status ${detail.status}`);
    expect((await detail.json()).badge.description).toBe(hint);
  });

  test("还没得到的一串徽章显示进度，得到了的和不成串的没有；访客没有", async () => {
    const climber = await person();
    await db.updateTable("users").set({ days_visited: 61 }).where("id", "=", climber.id).execute();
    const home = await thread(admin);
    const answer = await reply(climber.who, home);
    await db.updateTable("posts").set({ like_count: 7 }).where("id", "=", answer).execute();
    await checkBadges();

    const progress = async (name: string, who?: Who) => (await named(name, who)).progress;
    expect(await progress("鼠洞户口", climber.who)).toBeNull();
    expect(await progress("钉子户", climber.who)).toEqual({ have: 61, need: 200 });
    expect(await progress("不错的回复", climber.who)).toBeNull();
    expect(await progress("很棒的回复", climber.who)).toEqual({ have: 7, need: 15 });
    expect(await progress("初次发帖", climber.who)).toBeNull();
    expect(await progress("钉子户")).toBeNull();

    const gold = await named("钉子户");
    const detail = await api.badges[":id"].$get(
      { param: { id: String(gold.id) }, query: {} },
      climber.who,
    );
    if (!detail.ok) throw new Error(`status ${detail.status}`);
    expect((await detail.json()).badge.progress).toEqual({ have: 61, need: 200 });
  });

  test("得到的人占成员的比例", async () => {
    const { members } = await db
      .selectFrom("users")
      .select(sql<number>`count(*)::integer`.as("members"))
      .where("role", "not in", ["bot", "owner"])
      .executeTakeFirstOrThrow();
    const first = await named("初来乍到");
    expect(first.granted_count).toBeGreaterThan(0);
    expect(first.granted_rate).toBeCloseTo(first.granted_count / members, 3);
    expect((await named("博物馆馆长")).granted_rate).toBe(0);
  });
});
