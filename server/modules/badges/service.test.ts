import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { checkBadges, syncBadges } from "./service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: { id: number; who: Who };

beforeAll(async () => {
  await syncBadges();
  const { id } = await createUser("admin");
  admin = { id, who: as(await login(id)) };
  await api.boards.$post({ json: { slug: "badges", name: "徽章" } }, admin.who);
  await api.boards.$post(
    { json: { slug: "inner", name: "内部", visibility: "members" } },
    admin.who,
  );
});

async function person() {
  const { id, qq } = await createUser();
  return { id, qq, who: as(await login(id)) };
}

async function thread(who: Who, board = "badges", anonymous = false) {
  const res = await api.threads.$post(
    { json: { board, title: "徽章怎么拿", content: { markdown: "主楼" }, anonymous } },
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

// Likes come from many people; only the count matters to the badges.
async function setLikes(postId: number, likes: number) {
  await db.updateTable("posts").set({ like_count: likes }).where("id", "=", postId).execute();
}

async function badgesOf(userId: number) {
  const rows = await db
    .selectFrom("user_badges")
    .innerJoin("badges", "badges.id", "user_badges.badge_id")
    .select(["badges.slug", "user_badges.post_id"])
    .where("user_id", "=", userId)
    .execute();
  return rows;
}

async function slugsOf(userId: number) {
  return (await badgesOf(userId)).map((b) => b.slug);
}

async function badgeNotifications(userId: number) {
  return db
    .selectFrom("notifications")
    .select(sql<string>`data ->> 'name'`.as("name"))
    .where("user_id", "=", userId)
    .where("type", "=", "badge")
    .execute();
}

// The tiers of the badges the plugin heard someone earned.
async function badgeEvents(userId: number) {
  const rows = await db
    .selectFrom("events")
    .select(sql<string>`data -> 'badge' ->> 'tier'`.as("tier"))
    .where("type", "=", "badge.granted")
    .where(sql<number>`(data -> 'user' ->> 'id')::integer`, "=", userId)
    .execute();
  return rows.map((r) => r.tier);
}

describe("徽章", () => {
  test("第一次检查只是补齐，不通知；之后得到的徽章有通知，金徽章交给插件", async () => {
    await db.deleteFrom("job_runs").where("name", "=", "badges").execute();
    const early = await person();
    await thread(early.who);
    await checkBadges();
    expect(await slugsOf(early.id)).toEqual(
      expect.arrayContaining(["first_login", "first_thread"]),
    );
    expect(await badgeNotifications(early.id)).toEqual([]);

    const answer = await reply(early.who, await thread(admin.who));
    await setLikes(answer, 30);
    await checkBadges();
    expect(await slugsOf(early.id)).toEqual(
      expect.arrayContaining(["first_reply", "welcome", "nice_reply", "good_reply", "great_reply"]),
    );
    expect((await badgeNotifications(early.id)).map((n) => n.name)).toEqual(
      expect.arrayContaining(["初次回复", "精彩的回复"]),
    );
    expect(await badgeEvents(early.id)).toContain("gold");

    await checkBadges();
    expect(await badgeNotifications(early.id)).toHaveLength(5);
  });

  test("每层各得一次；匿名的楼层不算", async () => {
    const author = await person();
    const [a, b] = [
      await reply(author.who, await thread(admin.who)),
      await reply(author.who, await thread(admin.who)),
    ];
    await setLikes(a, 5);
    await setLikes(b, 5);
    const hidden = await thread(author.who, "badges", true);
    const opening = await db
      .selectFrom("posts")
      .select("id")
      .where("thread_id", "=", hidden)
      .where("floor", "=", 1)
      .executeTakeFirstOrThrow();
    await setLikes(opening.id, 30);
    await checkBadges();

    const mine = await badgesOf(author.id);
    const floors = mine.filter((m) => m.slug === "nice_reply").map((m) => m.post_id);
    expect(floors).toHaveLength(2);
    expect(floors).toEqual(expect.arrayContaining([a, b]));
    expect(mine.map((m) => m.slug)).not.toContain("great_thread");
    expect(mine.map((m) => m.slug)).not.toContain("first_thread");
  });

  test("连续访问：昨天来过的今天接着算，断了从 1 重新算", async () => {
    const { id } = await createUser();
    await db
      .insertInto("user_days")
      .values({ user_id: id, day: sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date - 1` })
      .execute();
    await db.updateTable("users").set({ visit_streak: 6 }).where("id", "=", id).execute();
    await login(id);
    await checkBadges();
    expect(await slugsOf(id)).toContain("streak_7");

    const { id: away } = await createUser();
    await db.updateTable("users").set({ visit_streak: 6 }).where("id", "=", away).execute();
    await login(away);
    const { visit_streak } = await db
      .selectFrom("users")
      .select("visit_streak")
      .where("id", "=", away)
      .executeTakeFirstOrThrow();
    expect(visit_streak).toBe(1);
  });

  test("活动徽章由管理员授予和撤销；只有自己的金徽章、银徽章能当头衔，撤销时头衔一并去掉", async () => {
    const member = await person();
    const created = await api.admin.badges.$post(
      { json: { name: "征文金奖", description: "第一届征文第一名", tier: "gold" } },
      admin.who,
    );
    if (created.status !== 201) throw new Error(`status ${created.status}`);
    const { id } = await created.json();
    const again = await api.admin.badges.$post(
      { json: { name: "征文金奖", description: "重名", tier: "gold" } },
      admin.who,
    );
    expect(again.status).toBe(409);
    expect(
      (
        await api.admin.badges.$post(
          { json: { name: "x", description: "y", tier: "gold" } },
          member.who,
        )
      ).status,
    ).toBe(403);

    const grant = (who: Who) =>
      api.admin.badges[":id"].grants.$post(
        { param: { id: String(id) }, json: { user: `qq:${member.qq}`, reason: "征文第一名" } },
        who,
      );
    expect((await grant(admin.who)).status).toBe(204);
    expect((await grant(admin.who)).status).toBe(409);
    expect(await badgeEvents(member.id)).toEqual(["gold"]);

    const bronze = await db
      .selectFrom("badges")
      .select("id")
      .where("slug", "=", "first_login")
      .executeTakeFirstOrThrow();
    const wear = (badge: number | null) =>
      api.me.$patch({ json: { title_badge_id: badge } }, member.who);
    expect((await wear(bronze.id)).status).toBe(400);
    expect((await wear(id)).status).toBe(200);
    const card = await (
      await api.users[":user"].$get({ param: { user: String(member.id) } })
    ).json();
    expect(card).toMatchObject({ title: "征文金奖", title_tier: "gold" });

    const revoke = await api.admin.badges[":id"].grants[":user"].$delete(
      { param: { id: String(id), user: String(member.id) }, json: {} },
      admin.who,
    );
    expect(revoke.status).toBe(204);
    const after = await (
      await api.users[":user"].$get({ param: { user: String(member.id) } })
    ).json();
    expect(after).toMatchObject({ title: "", title_tier: null });

    const automatic = await api.admin.badges[":id"].$patch(
      { param: { id: String(bronze.id) }, json: { name: "改名" } },
      admin.who,
    );
    expect(automatic.status).toBe(403);
  });

  test("访客看不到设了不给访客看的人的徽章，也看不到自己进不去的版块里的楼层", async () => {
    const member = await person();
    const inner = await reply(member.who, await thread(admin.who, "inner"));
    const open = await reply(member.who, await thread(admin.who));
    await setLikes(inner, 5);
    await setLikes(open, 5);
    await checkBadges();

    const list = async (who?: Who) => {
      const res = await api.users[":user"].badges.$get({ param: { user: String(member.id) } }, who);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items;
    };
    const nice = (items: Awaited<ReturnType<typeof list>>) =>
      items.find((b) => b.name === "不错的回复");
    expect(nice(await list())).toMatchObject({ count: 2, posts: [{ post_id: open }] });
    expect(
      nice(await list(admin.who))
        ?.posts.map((p) => p.post_id)
        .toSorted((x, y) => x - y),
    ).toEqual([inner, open].toSorted((x, y) => x - y));

    await api.me.$patch({ json: { hide_from_guests: true } }, member.who);
    expect(await list()).toEqual([]);
    const holders = await api.badges[":id"].$get({ param: { id: "1" }, query: {} });
    if (!holders.ok) throw new Error(`status ${holders.status}`);
    expect((await holders.json()).items.map((i) => i.user.id)).not.toContain(member.id);
  });
});
