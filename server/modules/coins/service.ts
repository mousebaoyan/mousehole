import { sql, type RawBuilder, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";

// Coins (design §8.17): earned for coming by, for others' reactions and for accepted answers, and
// spent on questions and moving looks. Other modules call in within their own transactions; this
// one calls none of them.

const CHECK_IN = 2;
const PER_LIKER = 1;
const ACCEPTED = 10;
export const QUESTION_COST = 1;
const PAGE = 50;
const BOARD_SIZE = 50;
const SETTLED = "coins";

const TODAY = sql<Date>`(now() AT TIME ZONE 'Asia/Shanghai')::date`;
// Who earns: members, not bots nor the owner, as u.
const EARNER = sql`u.member_status = 'member' AND u.role NOT IN ('bot', 'owner')`;

// Earnings in `fresh` (user_id, amount) added to the balances; a person may have several.
const CREDIT = sql`INSERT INTO coin_balances (user_id, coins)
  SELECT user_id, sum(amount) FROM fresh GROUP BY user_id
  ON CONFLICT (user_id) DO UPDATE SET coins = coin_balances.coins + excluded.coins`;
const ONCE_A_DAY = sql`ON CONFLICT (user_id, reason, day)
  WHERE reason IN ('check_in', 'liked', 'accepted') DO NOTHING`;

// Coming by on a Beijing day, on the site or in the groups. Only today and yesterday count, so a
// sync bringing up long ago earns nothing.
export async function checkIn(trx: Transaction<DB>, userIds: number[], day: RawBuilder<Date>) {
  await sql`
    WITH fresh AS (
      INSERT INTO coin_ledger (user_id, amount, reason, day)
      SELECT u.id, ${CHECK_IN}, 'check_in', ${day} FROM users u
      WHERE u.id = any(${userIds}::integer[]) AND ${EARNER} AND ${day} >= ${TODAY} - 1
      ${ONCE_A_DAY}
      RETURNING user_id, amount)
    ${CREDIT}`.execute(trx);
}

type Spending =
  | { reason: "question"; thread_id: number }
  | { reason: "look"; look_kind: string; look_key: string };

export async function spendCoins(
  trx: Transaction<DB>,
  userId: number,
  amount: number,
  spending: Spending,
) {
  const paid = await trx
    .updateTable("coin_balances")
    .set((eb) => ({ coins: eb("coins", "-", amount) }))
    .where("user_id", "=", userId)
    .where("coins", ">=", amount)
    .returning("user_id")
    .executeTakeFirst();
  if (!paid) throw new AppError(403, "coins_insufficient", `鼠币不够，要 ${amount} 个`);
  await trx
    .insertInto("coin_ledger")
    .values({ user_id: userId, amount: -amount, day: TODAY, ...spending })
    .execute();
}

// Hourly: settles each Beijing day up to yesterday not settled yet, starting from yesterday the
// first time. job_runs keeps the start of the last day settled.
export async function settleCoins() {
  const { rows } = await sql<{ day: string }>`
    SELECT d::date::text AS day FROM generate_series(
      coalesce((SELECT (ran_at AT TIME ZONE 'Asia/Shanghai')::date + 1 FROM job_runs
        WHERE name = ${SETTLED}), ${TODAY} - 1),
      ${TODAY} - 1, interval '1 day') d`.execute(db);
  for (const { day } of rows) await settleDay(day);
}

// What a day brought: one coin for each person who reacted to someone's floors, and ten if any
// answer of theirs was accepted. Only what is still there counts: reactions taken back, answers
// no longer accepted, floors deleted, hidden or anonymous don't.
async function settleDay(day: string) {
  const start = sql<Date>`(${day}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`;
  const end = sql<Date>`${start} + interval '1 day'`;
  const shown = sql`p.status = 'visible' AND p.deleted_at IS NULL AND NOT p.anonymous
    AND t.status = 'visible' AND t.deleted_at IS NULL`;
  await db.transaction().execute(async (trx) => {
    await sql`
      WITH earned AS (
        SELECT p.author_id AS user_id, 'liked'::text AS reason,
          count(DISTINCT r.user_id)::integer * ${PER_LIKER} AS amount
        FROM reactions r
        JOIN posts p ON p.id = r.post_id JOIN threads t ON t.id = p.thread_id
        JOIN users giver ON giver.id = r.user_id
        WHERE r.created_at >= ${start} AND r.created_at < ${end} AND r.user_id <> p.author_id
          AND giver.role <> 'bot' AND ${shown}
        GROUP BY p.author_id
        UNION ALL
        SELECT DISTINCT p.author_id, 'accepted', ${ACCEPTED}::integer
        FROM posts p JOIN threads t ON t.id = p.thread_id
        WHERE p.accepted_at >= ${start} AND p.accepted_at < ${end} AND ${shown}
      ), fresh AS (
        INSERT INTO coin_ledger (user_id, amount, reason, day)
        SELECT earned.user_id, earned.amount, earned.reason, ${day}::date
        FROM earned JOIN users u ON u.id = earned.user_id WHERE ${EARNER}
        ${ONCE_A_DAY}
        RETURNING user_id, amount)
      ${CREDIT}`.execute(trx);
    await trx
      .insertInto("job_runs")
      .values({ name: SETTLED, ran_at: start })
      .onConflict((oc) => oc.column("name").doUpdateSet({ ran_at: start }))
      .execute();
  });
}

// No row is none yet.
export async function coinBalance(userId: number) {
  const row = await db
    .selectFrom("coin_balances")
    .select("coins")
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.coins ?? 0;
}

export async function listLedger(userId: number, cursor?: number) {
  let query = db
    .selectFrom("coin_ledger")
    .leftJoin("threads", "threads.id", "coin_ledger.thread_id")
    .select([
      "coin_ledger.id",
      "coin_ledger.amount",
      "coin_ledger.reason",
      sql<string>`coin_ledger.day::text`.as("day"),
      "coin_ledger.created_at",
      "coin_ledger.thread_id",
      "threads.title",
      "coin_ledger.look_kind",
      "coin_ledger.look_key",
    ])
    .where("coin_ledger.user_id", "=", userId)
    .orderBy("coin_ledger.id", "desc")
    .limit(PAGE);
  if (cursor !== undefined) query = query.where("coin_ledger.id", "<", cursor);
  const rows = await query.execute();
  const last = rows.at(-1);
  return { rows, next_cursor: rows.length === PAGE && last ? String(last.id) : null };
}

export const PERIODS = ["week", "month", "all"] as const;
type Period = (typeof PERIODS)[number];

// The most earned over this week, this month or all along, Beijing time; spending doesn't count.
export async function leaderboard(period: Period) {
  const since = {
    week: sql`l.day >= date_trunc('week', ${TODAY})::date`,
    month: sql`l.day >= date_trunc('month', ${TODAY})::date`,
    all: sql`true`,
  }[period];
  const { rows } = await sql<{ user_id: number; earned: number }>`
    SELECT l.user_id, sum(l.amount)::integer AS earned
    FROM coin_ledger l JOIN users u ON u.id = l.user_id
    WHERE l.amount > 0 AND ${since} AND ${EARNER}
    GROUP BY l.user_id
    ORDER BY earned DESC, l.user_id
    LIMIT ${BOARD_SIZE}`.execute(db);
  return rows;
}
