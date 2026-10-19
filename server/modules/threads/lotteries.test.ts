import { createHash } from "node:crypto";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { drawDue } from "./lotteries.ts";

const api = testClient(app).api.v1;

type Who = { headers?: Record<string, string> };

let admin: Who;
let moderator: Who;
let author: Who;
const guest = {};

async function person(level = 1) {
  const { id } = await createUser("user", level);
  return { id, who: as(await login(id)) };
}

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  moderator = as(await login((await createUser("moderator")).id));
  author = (await person(2)).who;
  await api.boards.$post({ json: { slug: "lottery", name: "福利" } }, admin);
});

const soon = () => Math.floor(Date.now() / 1000) + 3600;

type LotteryInput = {
  prizes: { name: string; winners: number }[];
  entry?: "button" | "reply";
  min_level?: number;
  draws_at?: number;
};

function postLottery(lottery: LotteryInput, who: Who = author, anonymous = false) {
  return api.threads.$post(
    {
      json: {
        board: "lottery",
        title: "送几本保研经验书",
        content: { markdown: "规则见正文" },
        kind: "lottery",
        lottery: { draws_at: soon(), ...lottery },
        anonymous,
      },
    },
    who,
  );
}

async function newLottery(lottery: LotteryInput) {
  const res = await postLottery(lottery);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const thread = await res.json();
  if (!thread.lottery) throw new Error("no lottery");
  return { id: thread.id, param: { id: String(thread.id) }, lottery: thread.lottery };
}

async function lotteryOf(id: number, who: Who) {
  const res = await api.threads[":id"].$get({ param: { id: String(id) } }, who);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const { lottery } = await res.json();
  if (!lottery) throw new Error("no lottery");
  return lottery;
}

function enter(id: number, who: Who) {
  return api.threads[":id"].lottery.entry.$put({ param: { id: String(id) } }, who);
}

async function reply(id: number, who: Who) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(id) }, json: { content: { markdown: "参与一下" } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

// The time comes, and the minute's job draws it.
async function drawNow(id: number) {
  await db
    .updateTable("lotteries")
    .set({ draws_at: sql<Date>`now()` })
    .where("thread_id", "=", id)
    .execute();
  await drawDue();
}

// As design §8.13 tells anyone to check it.
function checkOrder(seed: string, ids: number[]) {
  const key = (id: number) => createHash("sha256").update(`${seed}:${id}`).digest("hex");
  return ids.toSorted((a, b) => (key(a) < key(b) ? -1 : 1));
}

describe("抽奖", () => {
  test("L2 起才能发；要带抽奖，不能匿名；开奖时间在 10 分钟以后", async () => {
    const prizes = [{ name: "一本书", winners: 1 }];
    expect((await postLottery({ prizes }, (await person(1)).who)).status).toBe(403);
    expect((await postLottery({ prizes }, author, true)).status).toBe(400);
    expect((await postLottery({ prizes, draws_at: soon() - 3500 })).status).toBe(400);
    expect((await postLottery({ prizes: [] })).status).toBe(400);
    const res = await api.threads.$post(
      {
        json: {
          board: "lottery",
          title: "送几本书给大家",
          content: { markdown: "正文" },
          kind: "lottery",
        },
      },
      author,
    );
    expect(res.status).toBe(400);

    const { lottery } = await newLottery({ prizes });
    expect(lottery).toMatchObject({
      entry: "button",
      min_level: 0,
      seed: null,
      entry_count: 0,
      entered: false,
      prizes: [{ name: "一本书", winners: 1, won_by: null }],
    });
    expect(lottery.seed_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("点按钮参与：楼主不能参与，等级不够不能参与，可以退出；开奖后不能再参与", async () => {
    const { id, param } = await newLottery({ prizes: [{ name: "书", winners: 1 }], min_level: 2 });
    expect((await enter(id, author)).status).toBe(403);
    const low = await person(1);
    const res = await enter(id, low.who);
    expect(res.status).toBe(403);
    if (res.ok) throw new Error("entered");
    expect((await res.json()).error.code).toBe("level_required");

    const fan = await person(2);
    expect((await enter(id, fan.who)).status).toBe(200);
    const again = await enter(id, fan.who);
    if (!again.ok) throw new Error(`status ${again.status}`);
    expect(await again.json()).toMatchObject({ entry_count: 1, entered: true });
    const left = await api.threads[":id"].lottery.entry.$delete({ param }, fan.who);
    if (!left.ok) throw new Error(`status ${left.status}`);
    expect(await left.json()).toMatchObject({ entry_count: 0, entered: false });

    expect((await enter(id, moderator)).status).toBe(200);
    await drawNow(id);
    const late = await enter(id, fan.who);
    if (late.ok) throw new Error("entered");
    expect((await late.json()).error.code).toBe("lottery_closed");
  });

  test("开奖：按公开的种子排出先后，依次抽满各个奖项；开奖时被封禁、退群的不算", async () => {
    const { id, param, lottery } = await newLottery({
      prizes: [
        { name: "一等奖：键盘", winners: 1 },
        { name: "二等奖：书", winners: 2 },
        { name: "三等奖：贴纸", winners: 10 },
      ],
    });
    const people = await Promise.all(Array.from({ length: 6 }, () => person()));
    for (const p of people) expect((await enter(id, p.who)).status).toBe(200);
    const [banned, frozen, ...rest] = people;
    await db
      .updateTable("users")
      .set({ restriction: "ban", restricted_until: null })
      .where("id", "=", banned.id)
      .execute();
    await db
      .updateTable("users")
      .set({ member_status: "frozen" })
      .where("id", "=", frozen.id)
      .execute();
    await drawNow(id);
    await drawDue();

    const drawn = await lotteryOf(id, guest);
    if (drawn.seed === null) throw new Error("no seed");
    expect(createHash("sha256").update(drawn.seed).digest("hex")).toBe(lottery.seed_hash);
    const order = checkOrder(
      drawn.seed,
      rest.map((p) => p.id),
    );
    expect(drawn.entry_count).toBe(4);
    expect(drawn.prizes.map((p) => p.won_by?.map((u) => u.id))).toEqual([
      order.slice(0, 1),
      order.slice(1, 3),
      order.slice(3),
    ]);

    const entries = await api.threads[":id"].lottery.entries.$get({ param }, rest[0].who);
    if (!entries.ok) throw new Error(`status ${entries.status}`);
    expect((await entries.json()).items.map((e) => [e.user.id, e.prize])).toEqual([
      [order[0], 0],
      [order[1], 1],
      [order[2], 1],
      [order[3], 2],
    ]);
    expect((await api.threads[":id"].lottery.entries.$get({ param }, guest)).status).toBe(401);

    const told = await db
      .selectFrom("notifications")
      .select(["user_id", sql<Record<string, string>>`data`.as("data")])
      .where("type", "=", "lottery")
      .where("thread_id", "=", id)
      .execute();
    expect(told).toHaveLength(5);
    expect(told.find((n) => n.user_id === order[0])?.data).toEqual({
      result: "won",
      prize: "一等奖：键盘",
    });
    const event = await db
      .selectFrom("events")
      .select("data")
      .where("type", "=", "lottery.drawn")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(event.data).toMatchObject({ thread: { id }, entry_count: 4 });
  });

  test("回复参与：回复几次都只算一次，删掉的回复、楼主和等级不够的不算", async () => {
    const { id } = await newLottery({
      prizes: [{ name: "书", winners: 5 }],
      entry: "reply",
      min_level: 2,
    });
    const [keen, quiet, low] = await Promise.all([person(2), person(2), person(1)]);
    await reply(id, keen.who);
    await reply(id, keen.who);
    const deleted = await reply(id, quiet.who);
    await api.posts[":id"].$delete({ param: { id: String(deleted) } }, quiet.who);
    await reply(id, low.who);
    await reply(id, author);
    expect((await enter(id, keen.who)).status).toBe(403);
    expect(await lotteryOf(id, keen.who)).toMatchObject({ entry_count: 1, entered: true });

    await drawNow(id);
    const drawn = await lotteryOf(id, keen.who);
    expect(drawn).toMatchObject({ entry_count: 1, entered: true });
    expect(drawn.prizes[0].won_by?.map((u) => u.id)).toEqual([keen.id]);
  });

  test("帖子待审核或已隐藏时到点也不开奖，恢复公开后补开", async () => {
    const { id, param } = await newLottery({ prizes: [{ name: "书", winners: 1 }] });
    await enter(id, (await person()).who);
    const review = (status: "visible" | "hidden") =>
      api.threads[":id"].$patch({ param, json: { status, reason: "核实奖品" } }, moderator);
    expect((await review("hidden")).status).toBe(200);
    await drawNow(id);
    expect(await lotteryOf(id, moderator)).toMatchObject({ drawn_at: null });

    expect((await review("visible")).status).toBe(200);
    await drawDue();
    expect((await lotteryOf(id, moderator)).drawn_at).not.toBeNull();
  });

  test("开奖前楼主和版主能取消，取消后不开奖，参与的人收到通知", async () => {
    const { id, param } = await newLottery({ prizes: [{ name: "书", winners: 1 }] });
    const fan = await person();
    await enter(id, fan.who);
    const cancel = (who: Who) => api.threads[":id"].lottery.cancel.$post({ param }, who);
    expect((await cancel(fan.who)).status).toBe(403);
    const res = await cancel(moderator);
    if (!res.ok) throw new Error(`status ${res.status}`);
    expect(await res.json()).toMatchObject({ cancelled: true });
    expect((await cancel(author)).status).toBe(403);

    await drawNow(id);
    expect(await lotteryOf(id, fan.who)).toMatchObject({ drawn_at: null, seed: null });
    const told = await db
      .selectFrom("notifications")
      .select(sql<Record<string, string>>`data`.as("data"))
      .where("user_id", "=", fan.id)
      .where("thread_id", "=", id)
      .execute();
    expect(told.map((n) => n.data)).toEqual([{ result: "cancelled" }]);
  });
});
