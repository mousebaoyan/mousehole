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

  test("要登录", async () => {
    expect((await api.users.$get({ query: { q: "夜猫" } })).status).toBe(401);
  });
});
