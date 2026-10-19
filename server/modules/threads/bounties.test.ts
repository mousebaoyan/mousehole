import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, nextQq } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";
import { settleCoins } from "../coins/service.ts";
import { startBounties } from "./bounties.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let admin: Who;
let bot: { headers: Record<string, string>; qq: number };

beforeAll(async () => {
  const { id } = await createUser("admin");
  admin = as(await login(id));
  const botQq = nextQq();
  const { token } = await createBotToken(
    { userId: id, operatorId: null, tokenId: null, ip: null, userAgent: null },
    { name: "插件", botQq, scopes: ["read", "act"] },
  );
  bot = { headers: { authorization: `Bearer ${token}` }, qq: botQq };
  await api.boards.$post(
    { json: { slug: "bq", name: "悬赏问答", default_kind: "question" } },
    admin,
  );
  await api.boards.$post(
    { json: { slug: "bq-l3", name: "高阶问答", default_kind: "question", read_level: 3 } },
    admin,
  );
});

// Logged in, with the coins of today's check-in for a question or two.
async function person() {
  const { id, qq } = await createUser();
  return { id, qq, who: as(await login(id)) };
}

async function ask(
  who: Who,
  json: { board?: string; kind?: "discussion"; positioning?: boolean } = {},
) {
  const res = await api.threads.$post(
    {
      json: {
        board: json.board ?? "bq",
        title: "rank 30% 能冲华五的夏令营吗",
        content: { markdown: "求问" },
        kind: json.positioning ? "poll" : json.kind,
        poll: json.positioning ? { preset: "positioning", rows: ["浙大"] } : undefined,
      },
    },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

async function reply(who: Who, thread: number) {
  const res = await api.threads[":id"].posts.$post(
    { param: { id: String(thread) }, json: { content: { markdown: "可以试试" } } },
    who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

function asked(ids: number[], when: ReturnType<typeof sql<Date>>) {
  return db.updateTable("threads").set({ created_at: when }).where("id", "in", ids).execute();
}

async function bountyUntil(thread: number) {
  const res = await api.threads[":id"].$get({ param: { id: String(thread) } }, admin);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()).bounty_until;
}

async function listed() {
  const since = Math.floor(Date.now() / 1000) - 3600;
  const res = await api.bot.bounties.$get({ query: { since: String(since) } }, bot);
  return res.json();
}

const DAY_AGO = sql<Date>`now() - interval '25 hours'`;
// Noon yesterday, Beijing time.
const YESTERDAY_NOON = sql<Date>`(date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai')
  - interval '12 hours') AT TIME ZONE 'Asia/Shanghai'`;

describe("悬赏", () => {
  test("论坛上发的问答帖和保研定位帖一天没有别人回复就悬赏，只一次；收录的、讨论帖、有人回复的、楼主采纳了自己回复的、回复匿名的、门槛高的版块和太久以前的不悬赏", async () => {
    const [asker, other, l3, masker] = await Promise.all([person(), person(), person(), person()]);
    await db.updateTable("users").set({ level: 3 }).where("id", "=", l3.id).execute();
    const question = await ask(asker.who);
    const positioning = await ask(other.who, { positioning: true });
    const discussion = await ask(asker.who, { kind: "discussion" });
    const answered = await ask(other.who);
    const solved = await ask(asker.who);
    const masked = await ask(masker.who);
    await db
      .updateTable("threads")
      .set({ anonymous_replies: true })
      .where("id", "=", masked)
      .execute();
    const gated = await ask(l3.who, { board: "bq-l3" });
    const old = await ask(l3.who);
    const archived = await api.threads.$post(
      {
        json: {
          board: "bq",
          title: "群里问的问题",
          content: { markdown: "求问" },
          source: { chat_type: "group", chat_id: 1, message_ids: [nextQq()] },
        },
      },
      { headers: { ...bot.headers, "x-act-as": `qq:${asker.qq}` } },
    );
    if (!archived.ok) throw new Error(`status ${archived.status}`);
    const collected = (await archived.json()).id;
    await reply(asker.who, question);
    await reply(asker.who, answered);
    const own = await reply(asker.who, solved);
    const accepted = await api.threads[":id"].answers[":post"].$put(
      { param: { id: String(solved), post: String(own) } },
      asker.who,
    );
    expect(accepted.status).toBe(200);
    await asked(
      [question, positioning, discussion, answered, solved, masked, gated, collected],
      DAY_AGO,
    );
    await asked([old], sql<Date>`now() - interval '4 days'`);
    await reply(other.who, await ask(other.who));

    await startBounties();
    for (const thread of [question, positioning]) expect(await bountyUntil(thread)).not.toBeNull();
    for (const thread of [discussion, answered, solved, masked, gated, old, collected]) {
      expect(await bountyUntil(thread)).toBeNull();
    }
    const { items, reward } = await listed();
    expect(reward).toEqual({ reply: 1, answer: 5 });
    expect(items.map((i) => i.thread.id)).toEqual(expect.arrayContaining([question, positioning]));

    // Answered since, it stays up for the bounty but is no longer told.
    await reply(other.who, question);
    expect((await listed()).items.map((i) => i.thread.id)).not.toContain(question);
    const before = await bountyUntil(question);
    await startBounties();
    expect(await bountyUntil(question)).toBe(before);
  });

  test("悬赏期间的回复每人每天得一次：回复得 1，被采纳得 5；楼主自己的和悬赏开始前的不算", async () => {
    const [asker, again, answerer, early] = await Promise.all([
      person(),
      person(),
      person(),
      person(),
    ]);
    const [first, second] = [await ask(asker.who), await ask(again.who)];
    await asked([first, second], DAY_AGO);
    await startBounties();
    const before = await reply(early.who, first);
    await db
      .updateTable("threads")
      .set({ bounty_at: sql<Date>`${YESTERDAY_NOON} - interval '1 hour'` })
      .where("id", "in", [first, second])
      .execute();
    const replies = [
      await reply(again.who, first),
      await reply(again.who, first),
      await reply(again.who, second),
      await reply(asker.who, first),
    ];
    const accepted = await reply(answerer.who, first);
    await db
      .updateTable("posts")
      .set({ created_at: YESTERDAY_NOON })
      .where("id", "in", [...replies, accepted])
      .execute();
    await db
      .updateTable("posts")
      .set({ created_at: sql<Date>`${YESTERDAY_NOON} - interval '2 hours'` })
      .where("id", "=", before)
      .execute();
    const res = await api.threads[":id"].answers[":post"].$put(
      { param: { id: String(first), post: String(accepted) } },
      asker.who,
    );
    expect(res.status).toBe(200);
    await db
      .updateTable("posts")
      .set({ accepted_at: YESTERDAY_NOON })
      .where("id", "=", accepted)
      .execute();

    // Settled from yesterday again, whatever other tests settled: what is there is not paid twice.
    await db.deleteFrom("job_runs").where("name", "=", "coins").execute();
    await settleCoins();
    const bounties = await db
      .selectFrom("coin_ledger")
      .select(["user_id", "amount"])
      .where("reason", "=", "bounty")
      .where("user_id", "in", [asker.id, again.id, answerer.id, early.id])
      .orderBy("amount")
      .execute();
    expect(bounties).toEqual([
      { user_id: again.id, amount: 1 },
      { user_id: answerer.id, amount: 5 },
    ]);
  });
});
