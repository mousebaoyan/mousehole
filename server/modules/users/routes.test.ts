import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

let member = as("");

beforeAll(async () => {
  member = as(await login((await createUser()).id));
});

async function named(display_name: string, change: { role?: string; member_status?: string } = {}) {
  await db
    .insertInto("users")
    .values({ qq: nextQq(), display_name, ...change })
    .execute();
}

async function search(q: string) {
  const res = await api.users.$get({ query: { q } }, member);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items.map((u) => u.display_name);
}

describe("找成员", () => {
  test("名字以它开头的在前；不列 bot 和冻结的账号；% 和 _ 按字面匹配", async () => {
    await named("夜猫子研究所");
    await named("研究所的夜猫");
    await named("夜猫 bot", { role: "bot" });
    await named("夜猫已退群", { member_status: "frozen" });
    await named("100%_夜猫");

    expect(await search("夜猫")).toEqual(["夜猫子研究所", "研究所的夜猫", "100%_夜猫"]);
    expect(await search("%_")).toEqual(["100%_夜猫"]);
  });

  test("5 位以上的数字也按 QQ 号的开头找，正好是这个号的在前", async () => {
    const qq = 2_000_000_000 + nextQq();
    await db.insertInto("users").values({ qq, display_name: "按号找的人" }).execute();
    await named(`名字里有${qq}`);
    expect(await search(String(qq))).toEqual(["按号找的人", `名字里有${qq}`]);
    expect(await search(String(qq).slice(0, 5))).toContain("按号找的人");
    expect(await search(String(qq).slice(0, 4))).not.toContain("按号找的人");
  });

  test("要登录", async () => {
    expect((await api.users.$get({ query: { q: "夜猫" } })).status).toBe(401);
  });
});

async function find(q: string, cursor?: string) {
  const res = await api.users.search.$get({ query: { q, cursor } }, member);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("搜索页找用户", () => {
  test("名字、所在群的群名片和 QQ 昵称都能找到，说明对上的是哪个；退群的排在后面", async () => {
    await db.insertInto("qq_groups").values({ id: 1001, name: "保研二群" }).execute();
    const [carded, nicknamed, left] = await db
      .insertInto("users")
      .values([
        { qq: nextQq(), display_name: "主群的名字" },
        { qq: nextQq(), display_name: "另一个人", qq_nickname: "山茶花开" },
        { qq: nextQq(), display_name: "山茶花已退群", member_status: "frozen" },
      ])
      .returning("id")
      .execute();
    await db
      .insertInto("group_members")
      .values({
        group_id: 1001,
        user_id: carded.id,
        card: "二群的山茶花",
        role: "member",
        observed_at: new Date(),
      })
      .execute();

    const found = await find("山茶花");
    expect(found.items.map((u) => [u.id, u.frozen, u.match])).toEqual([
      [carded.id, false, { field: "card", text: "二群的山茶花", group: "保研二群" }],
      [nicknamed.id, false, { field: "qq_nickname", text: "山茶花开", group: null }],
      [left.id, true, null],
    ]);

    await db
      .updateTable("group_members")
      .set({ left_at: new Date() })
      .where("user_id", "=", carded.id)
      .execute();
    expect((await find("二群的")).items).toEqual([]);
  });

  test("每页 20 个，往后翻接着列", async () => {
    await db
      .insertInto("users")
      .values(Array.from({ length: 25 }, (_, i) => ({ qq: nextQq(), display_name: `翻页鼠${i}` })))
      .execute();
    const first = await find("翻页鼠");
    expect(first.items).toHaveLength(20);
    const second = await find("翻页鼠", first.next_cursor ?? "");
    expect(second.items).toHaveLength(5);
    expect(second.next_cursor).toBeNull();
  });

  test("访客和冻结的账号不能用", async () => {
    expect((await api.users.search.$get({ query: { q: "鼠" } })).status).toBe(401);
    const frozen = await createUser();
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", frozen.id)
      .execute();
    const res = await api.users.search.$get({ query: { q: "鼠" } }, as(await login(frozen.id)));
    expect(res.status).toBe(403);
  });
});
