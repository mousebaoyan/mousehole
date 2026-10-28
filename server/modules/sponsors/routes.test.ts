import { testClient } from "hono/testing";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { codeImagePath } from "./rules.ts";

const api = testClient(app).api.v1;

type Who = ReturnType<typeof as>;

// Codes made up for the tests: what a WeChat and an Alipay code hold looks like this.
const CODES = { wechat: "wxp://f2f0TestOnlyCode", alipay: "https://qr.alipay.com/fkxtestonly" };

let owner = as("");
let payee = { id: 0, qq: 0, who: as("") };

async function member(role: "user" | "admin" = "user") {
  const user = await createUser(role);
  return { ...user, who: as(await login(user.id)) };
}

async function configure(sponsor: { payee?: string | null; wechat?: string; alipay?: string }) {
  return api.admin.settings.$patch({ json: { sponsor } }, owner);
}

async function register(who: Who, amount = 700, anonymous = false) {
  const res = await api.sponsorships.$post(
    { json: { method: "wechat", amount, message: "  加油  ", anonymous } },
    who,
  );
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  return (await res.json()).id;
}

function review(id: number, json: { status?: "confirmed" | "rejected"; amount?: number }) {
  return api.admin.sponsorships[":id"].$patch({ param: { id: String(id) }, json }, payee.who);
}

async function wall(who?: Who) {
  const res = await api.sponsorships.$get({ query: {} }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).items;
}

async function told(userId: number) {
  return db
    .selectFrom("notifications")
    .select(["actor_id", "data"])
    .where("user_id", "=", userId)
    .where("type", "=", "sponsor")
    .orderBy("id", "desc")
    .execute();
}

beforeAll(async () => {
  owner = await ownerSession();
  payee = await member("admin");
});

beforeEach(async () => {
  await configure({ payee: `qq:${payee.qq}`, ...CODES });
});

describe("设置", () => {
  test("收款人只能是管理员，收款码要是对应的格式", async () => {
    const user = await createUser();
    expect((await configure({ payee: `qq:${user.qq}` })).status).toBe(400);
    expect((await configure({ wechat: CODES.alipay })).status).toBe(400);
    expect((await configure({ alipay: "https://example.com/pay" })).status).toBe(400);
    expect((await configure({ wechat: `wxp://${"a".repeat(200)}` })).status).toBe(400);
  });

  test("没设收款人时不能登记；没设的方式不显示，也不能用它登记", async () => {
    const someone = await member();
    await configure({ payee: null });
    expect(await (await api.sponsor.$get({}, someone.who)).json()).toMatchObject({ payee: null });
    const closed = await api.sponsorships.$post(
      { json: { method: "wechat", amount: 700, message: null, anonymous: false } },
      someone.who,
    );
    expect(closed.status).toBe(403);

    await configure({ payee: `qq:${payee.qq}`, alipay: "" });
    expect(await (await api.sponsor.$get({}, someone.who)).json()).toMatchObject({
      payee: { id: payee.id },
      codes: { wechat: CODES.wechat, alipay: null },
    });
    const alipay = await api.sponsorships.$post(
      { json: { method: "alipay", amount: 700, message: null, anonymous: false } },
      someone.who,
    );
    expect(alipay.status).toBe(403);
    expect((await app.request("/sponsor/alipay.png", someone.who)).status).toBe(404);
  });

  test("收款码只给成员：访客拿不到内容，也拿不到图片", async () => {
    const someone = await member();
    expect(await (await api.sponsor.$get()).json()).toMatchObject({ codes: null });
    expect((await app.request(codeImagePath("wechat", CODES.wechat))).status).toBe(403);

    const res = await app.request(codeImagePath("wechat", CODES.wechat), someone.who);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("private");
  });

  test("图片地址带着码的内容：换码后旧地址拿不到新码", async () => {
    const someone = await member();
    const old = await app.request(codeImagePath("wechat", "wxp://f2f0OldTestCode"), someone.who);
    expect(old.status).toBe(404);
  });
});

describe("登记和确认", () => {
  test("登记后通知收款人；确认前不能再登记，撤回后可以", async () => {
    const someone = await member();
    const id = await register(someone.who);
    expect(await told(payee.id)).toContainEqual({
      actor_id: someone.id,
      data: { action: "pending", amount: "700" },
    });

    expect(
      (
        await api.sponsorships.$post(
          { json: { method: "wechat", amount: 1400, message: null, anonymous: false } },
          someone.who,
        )
      ).status,
    ).toBe(409);

    const withdraw = await api.sponsorships[":id"].$delete(
      { param: { id: String(id) } },
      someone.who,
    );
    expect(withdraw.status).toBe(204);
    await register(someone.who);
  });

  test("按实收金额确认：本人收到通知，感谢墙显示档位不显示金额，匿名的不带名字", async () => {
    const [named, hidden] = [await member(), await member()];
    const before = (await (await api.sponsor.$get()).json()).year;
    const first = await register(named.who, 1400);
    const second = await register(hidden.who, 700, true);

    expect((await review(first, { status: "confirmed", amount: 2400 })).status).toBe(204);
    expect((await review(second, { status: "confirmed" })).status).toBe(204);

    expect(await told(named.id)).toEqual([
      { actor_id: null, data: { action: "confirmed", amount: "2400" } },
    ]);
    const shown = await wall();
    expect(shown.find((t) => t.id === first)).toMatchObject({
      user: { id: named.id },
      days: 7,
      message: "加油",
    });
    expect(shown.find((t) => t.id === second)).toMatchObject({ user: null, days: 2 });
    expect(JSON.stringify(shown)).not.toContain("amount");
    expect((await (await api.sponsor.$get()).json()).year).toEqual({
      amount: before.amount + 3100,
      count: before.count + 2,
    });

    const late = await api.sponsorships[":id"].$delete({ param: { id: String(first) } }, named.who);
    expect(late.status).toBe(409);
  });

  test("没收到的附理由通知本人，不上墙", async () => {
    const someone = await member();
    const id = await register(someone.who);
    const res = await api.admin.sponsorships[":id"].$patch(
      { param: { id: String(id) }, json: { status: "rejected", reason: "没有查到这笔" } },
      owner,
    );
    expect(res.status).toBe(204);
    expect(await told(someone.id)).toEqual([
      { actor_id: null, data: { action: "rejected", amount: "700", reason: "没有查到这笔" } },
    ]);
    expect((await wall()).map((t) => t.id)).not.toContain(id);
  });

  test("只有收款人和站长能看记录、确认：别的管理员不行", async () => {
    const [someone, other] = [await member(), await member("admin")];
    const id = await register(someone.who);
    expect((await api.admin.sponsorships.count.$get({}, other.who)).status).toBe(403);
    const res = await api.admin.sponsorships[":id"].$patch(
      { param: { id: String(id) }, json: { status: "confirmed" } },
      other.who,
    );
    expect(res.status).toBe(403);
    const list = await api.admin.sponsorships.$get({ query: {} }, owner);
    if (!list.ok) throw new Error(`status ${list.status}`);
    const item = (await list.json()).items.find((r) => r.id === id);
    expect(item?.user.qq).toBe(someone.qq);
  });

  test("收款人不再是管理员或被冻结后，不能再确认", async () => {
    const [someone, former] = [await member(), await member("admin")];
    await configure({ payee: `qq:${former.qq}` });
    const id = await register(someone.who);
    const confirm = () =>
      api.admin.sponsorships[":id"].$patch(
        { param: { id: String(id) }, json: { status: "confirmed" } },
        former.who,
      );
    const users = db.updateTable("users").where("id", "=", former.id);
    await users.set({ role: "user" }).execute();
    expect((await confirm()).status).toBe(403);
    await users.set({ role: "admin", member_status: "frozen" }).execute();
    expect((await confirm()).status).toBe(403);
  });

  test("补录的直接确认，默认匿名；本人可以改成显示名字", async () => {
    const someone = await member();
    const add = (paid_at: number) =>
      api.admin.sponsorships.$post(
        {
          json: {
            user: `qq:${someone.qq}`,
            method: "alipay",
            amount: 1000,
            paid_at,
            message: null,
          },
        },
        payee.who,
      );
    expect((await add(Math.floor(Date.now() / 1000) + 86_400)).status).toBe(400);
    const res = await add(1_767_225_600);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { id } = await res.json();
    expect((await wall()).find((t) => t.id === id)).toMatchObject({ user: null, days: 2 });
    expect(await told(someone.id)).toEqual([
      { actor_id: null, data: { action: "confirmed", amount: "1000" } },
    ]);

    const edit = (json: { anonymous?: boolean }) =>
      api.sponsorships[":id"].$patch({ param: { id: String(id) }, json }, someone.who);
    expect((await edit({})).status).toBe(400);
    await edit({ anonymous: false });
    expect((await wall()).find((t) => t.id === id)).toMatchObject({ user: { id: someone.id } });
  });

  test("设了不给访客看的人，访客看不到 TA 的那条", async () => {
    const shy = await member();
    const id = await register(shy.who);
    await review(id, { status: "confirmed" });
    await api.me.$patch({ json: { hide_from_guests: true } }, shy.who);
    expect((await wall()).map((t) => t.id)).not.toContain(id);
    expect((await wall(shy.who)).map((t) => t.id)).toContain(id);
  });
});
