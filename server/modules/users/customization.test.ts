import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin = as("");

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "looks", name: "个性化" } }, admin);
  await api.boards.$post(
    { json: { slug: "looks-inner", name: "内部", visibility: "members" } },
    admin,
  );
});

async function person() {
  const { id } = await createUser();
  return { id, who: as(await login(id)) };
}

async function thread(who: Who, board = "looks", anonymous = false) {
  const res = await api.threads.$post(
    { json: { board, title: "我的经验贴", content: { markdown: "正文" }, anonymous } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function card(userId: number) {
  const res = await api.users[":user"].$get({ param: { user: String(userId) } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const user = await res.json();
  if (user.members_only) throw new Error("members only");
  return user;
}

async function showcase(userId: number, who?: Who) {
  const res = await api.users[":user"].showcase.$get({ param: { user: String(userId) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("个性化", () => {
  test("状态到点就不再显示，楼层里的作者也一样；表情只能是一个", async () => {
    const member = await person();
    const set = (user_status: { emoji: string; text: string; until: number | null } | null) =>
      api.me.$patch({ json: { user_status } }, member.who);
    expect((await set({ emoji: "🎉", text: "已上岸", until: null })).status).toBe(200);
    expect((await card(member.id)).user_status).toEqual({ emoji: "🎉", text: "已上岸" });

    const threadId = await thread(member.who);
    await db
      .updateTable("users")
      .set({ status_until: new Date(Date.now() - 1000) })
      .where("id", "=", member.id)
      .execute();
    expect((await card(member.id)).user_status).toBeNull();
    const floors = await api.threads[":id"].posts.$get({
      param: { id: String(threadId) },
      query: {},
    });
    if (!floors.ok) throw new Error(`status ${floors.status}`);
    expect((await floors.json()).items[0].author).toMatchObject({ user_status: null });

    expect((await set({ emoji: "🎉🎉", text: "两个", until: null })).status).toBe(400);
    expect((await set({ emoji: "a", text: "不是表情", until: null })).status).toBe(400);
    expect((await set({ emoji: "🎉", text: "字".repeat(31), until: null })).status).toBe(400);
  });

  test("代表作只能选自己公开发布的帖子，按选的顺序；看的人打不开的、后来隐藏的不显示", async () => {
    const member = await person();
    const other = await person();
    const [open, inner, later] = [
      await thread(member.who),
      await thread(member.who, "looks-inner"),
      await thread(member.who),
    ];
    const pin = (pins: number[]) => api.me.$patch({ json: { pins } }, member.who);

    for (const wrong of [
      [await thread(other.who)],
      [await thread(member.who, "looks", true)],
      [open, open],
    ]) {
      expect((await pin(wrong)).status).toBe(400);
    }
    expect((await pin([later, inner, open])).status).toBe(200);
    const ids = async (who?: Who) => (await showcase(member.id, who)).pins.map((t) => t.id);
    expect(await ids(other.who)).toEqual([later, inner, open]);
    expect(await ids()).toEqual([later, open]);

    await db.updateTable("threads").set({ status: "hidden" }).where("id", "=", later).execute();
    expect(await ids(other.who)).toEqual([inner, open]);
  });

  test("展柜里的图片显示成链接；不给访客看的人，访客拿到的展柜是空的", async () => {
    const member = await person();
    const res = await api.me.$patch(
      { json: { showcase: "## 关于我\n\n![照片](https://example.com/me.png)", pins: [] } },
      member.who,
    );
    expect(res.status).toBe(200);
    const { showcase_html } = await showcase(member.id);
    expect(showcase_html).toContain("<h2>关于我</h2>");
    expect(showcase_html).not.toContain("<img");
    expect(showcase_html).toContain('href="https://example.com/me.png"');

    await api.me.$patch({ json: { hide_from_guests: true } }, member.who);
    expect(await showcase(member.id)).toEqual({ showcase_html: null, pins: [] });
    expect((await showcase(member.id, member.who)).showcase_html).not.toBeNull();
  });

  test("头像框按等级和徽章解锁：版主只免等级，种子用户和金徽章要有那枚徽章；楼层里的作者带着框", async () => {
    const member = await person();
    const wear = (frame: "teal" | "flow" | "sprout" | "gilt" | null, who = member.who) =>
      api.me.$patch({ json: { frame } }, who);
    expect((await wear("teal")).status).toBe(200);
    for (const locked of ["flow", "sprout", "gilt"] as const) {
      expect((await wear(locked)).status).toBe(403);
    }
    const give = async (slug: string) => {
      const badge = await db
        .insertInto("badges")
        .values({
          slug,
          name: `测试${slug}`,
          description: "",
          tier: slug === "seed" ? "silver" : "gold",
          grouping: "limited",
          position: 0,
        })
        .onConflict((oc) => oc.column("slug").doUpdateSet({ position: 0 }))
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("user_badges")
        .values({ user_id: member.id, badge_id: badge.id })
        .execute();
    };
    await give("seed");
    expect((await wear("sprout")).status).toBe(200);
    await give("great_reply");
    expect((await wear("gilt")).status).toBe(200);

    const threadId = await thread(member.who);
    const floors = await api.threads[":id"].posts.$get({
      param: { id: String(threadId) },
      query: {},
    });
    if (!floors.ok) throw new Error(`status ${floors.status}`);
    expect((await floors.json()).items[0].author).toMatchObject({
      frame: { key: "gilt", moving: true },
    });

    const moderator = as(await login((await createUser("moderator", 0)).id));
    expect((await wear("flow", moderator)).status).toBe(200);
    expect((await wear("sprout", moderator)).status).toBe(403);
  });

  test("按等级解锁的是静态的，用鼠币兑换动态版：要够得上等级、鼠币够，兑换了戴上就一直动", async () => {
    const { id } = await createUser("user", 3);
    const who = as(await login(id));
    await db.updateTable("coin_balances").set({ coins: 200 }).where("user_id", "=", id).execute();
    const buy = (
      look:
        | { kind: "frame"; key: "flow" | "teal" | "laurel" }
        | { kind: "background"; key: "waves" | "stars" },
    ) => api.me.looks.$post({ json: look }, who);
    const author = async () => {
      const res = await api.threads[":id"].posts.$get({
        param: { id: String(threadId) },
        query: {},
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).items[0].author;
    };

    await api.me.$patch({ json: { frame: "flow" } }, who);
    const threadId = await thread(who);
    expect(await author()).toMatchObject({ frame: { key: "flow", moving: false } });
    expect((await buy({ kind: "frame", key: "flow" })).status).toBe(200);
    expect(await author()).toMatchObject({ frame: { key: "flow", moving: true } });

    const bought = await buy({ kind: "background", key: "waves" });
    if (!bought.ok) throw new Error(`status ${bought.status}`);
    expect(await bought.json()).toMatchObject({
      background: null,
      coins: 40,
      owned: { backgrounds: ["waves"], frames: ["flow"] },
    });
    await api.me.$patch({ json: { background: "waves" } }, who);
    expect((await card(id)).background).toEqual({ preset: "waves", moving: true });

    for (const [look, status, code] of [
      [{ kind: "background", key: "stars" }, 403, "coins_insufficient"],
      [{ kind: "frame", key: "laurel" }, 403, "cosmetic_locked"],
      [{ kind: "frame", key: "teal" }, 400, "invalid_request"],
      [{ kind: "background", key: "waves" }, 409, "look_owned"],
    ] as const) {
      const res = await buy(look);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: { code } });
    }
    expect((await api.me.coins.$get({ query: {} }, who)).ok).toBe(true);
    const spent = await db
      .selectFrom("coin_ledger")
      .select(["amount", "look_kind", "look_key"])
      .where("user_id", "=", id)
      .where("reason", "=", "look")
      .orderBy("id")
      .execute();
    expect(spent).toEqual([
      { amount: -100, look_kind: "frame", look_key: "flow" },
      { amount: -60, look_kind: "background", look_key: "waves" },
    ]);
  });

  test("版主能清除别人的状态和展柜，要写理由；普通成员不能", async () => {
    const member = await person();
    const moderator = as(await login((await createUser("moderator")).id));
    await api.me.$patch(
      {
        json: {
          user_status: { emoji: "😈", text: "不合适的话", until: null },
          showcase: "不合适的介绍",
        },
      },
      member.who,
    );
    const clear = (item: "status" | "showcase", who: Who, reason = "不合适") =>
      api.users[":user"].customization[":item"].$delete(
        { param: { user: String(member.id), item }, json: { reason } },
        who,
      );
    expect((await clear("status", (await person()).who)).status).toBe(403);
    expect((await clear("status", moderator, "")).status).toBe(400);
    expect((await clear("status", moderator)).status).toBe(204);
    expect((await clear("showcase", moderator)).status).toBe(204);
    expect((await card(member.id)).user_status).toBeNull();
    expect((await showcase(member.id)).showcase_html).toBeNull();
    const logged = await db
      .selectFrom("audit_logs")
      .select("data")
      .where("action", "=", "user.clear")
      .where("target_id", "=", member.id)
      .execute();
    expect(logged).toHaveLength(2);
  });
});
