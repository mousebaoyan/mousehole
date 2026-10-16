import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { type Actor, type Viewer } from "../../platform/access.ts";
import { STAFF } from "../../platform/site.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import { notifyLottery } from "../notifications/service.ts";
import { userBriefs } from "../users/service.ts";
import { lotteryDrawn } from "./events.ts";

// The lottery under a lottery thread's opening post; see design §8.13. Written with the thread and
// fixed from then on; the forum draws it at its time, in an order anyone can check.

export type Prize = { name: string; winners: number };

export type LotterySpec = {
  prizes: Prize[];
  entry: "button" | "reply";
  min_level: number;
  // Unix seconds.
  draws_at: number;
};

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

// The seed is secret until the draw; its hash shows from the start, so it can't be swapped then.
export async function createLottery(trx: Transaction<DB>, threadId: number, spec: LotterySpec) {
  const seed = randomBytes(32).toString("hex");
  await trx
    .insertInto("lotteries")
    .values({
      thread_id: threadId,
      // An array would go to PostgreSQL as one of its own.
      prizes: JSON.stringify(spec.prizes),
      entry: spec.entry,
      min_level: spec.min_level,
      draws_at: new Date(spec.draws_at * 1000),
      seed,
      seed_hash: sha256(seed),
    })
    .execute();
}

// Everyone in the order prizes go out: by the SHA-256 of "seed:user ID", smallest first.
export function drawOrder(seed: string, userIds: number[]) {
  return userIds
    .map((id) => ({ id, key: sha256(`${seed}:${id}`) }))
    .toSorted((a, b) => (a.key < b.key ? -1 : 1))
    .map((e) => e.id);
}

function selectLottery(executor: Kysely<DB>) {
  return executor
    .selectFrom("lotteries")
    .innerJoin("threads", "threads.id", "lotteries.thread_id")
    .select([
      "lotteries.thread_id",
      sql<Prize[]>`lotteries.prizes`.as("prizes"),
      "lotteries.entry",
      "lotteries.min_level",
      "lotteries.draws_at",
      "lotteries.seed",
      "lotteries.seed_hash",
      "lotteries.drawn_at",
      "lotteries.cancelled_at",
      "threads.title",
      "threads.author_id",
    ]);
}

type Row = Awaited<ReturnType<ReturnType<typeof selectLottery>["executeTakeFirstOrThrow"]>>;

// Who it may be drawn from: members other than its author and bots, at its level unless staff,
// and not banned.
function eligible(lottery: Pick<Row, "author_id" | "min_level">) {
  return db
    .selectFrom("users")
    .select("users.id")
    .where("users.member_status", "=", "member")
    .where("users.role", "<>", "bot")
    .where("users.id", "<>", lottery.author_id)
    .where((eb) =>
      eb.or([eb("users.level", ">=", lottery.min_level), eb("users.role", "in", STAFF)]),
    ).where(sql<boolean>`users.restriction IS DISTINCT FROM 'ban'
      OR users.restricted_until <= now()`);
}

// Entering by reply: a visible reply before its time, each person once, from when they first did.
function repliers(lottery: Pick<Row, "thread_id" | "draws_at">) {
  return db
    .selectFrom("posts")
    .select(["author_id", sql<Date>`min(created_at)`.as("created_at")])
    .where("thread_id", "=", lottery.thread_id)
    .where("floor", ">", 1)
    .where("status", "=", "visible")
    .where("deleted_at", "is", null)
    .where("created_at", "<=", lottery.draws_at)
    .groupBy("author_id");
}

// Who is in so far: by button, the entries; by reply, the eligible repliers. Once drawn, the
// entries are exactly who it was drawn from.
function entrants(lottery: Row) {
  if (lottery.entry === "button" || lottery.drawn_at !== null) {
    return db
      .selectFrom("lottery_entries")
      .select(["user_id", "created_at", "prize"])
      .where("thread_id", "=", lottery.thread_id);
  }
  return db
    .selectFrom(repliers(lottery).as("r"))
    .select(["author_id as user_id", "created_at", sql<number | null>`NULL::smallint`.as("prize")])
    .where("author_id", "in", eligible(lottery));
}

// What a reader sees of it: the seed and who won once it is drawn.
export async function getLottery(threadId: number, viewerId: number | null) {
  const lottery = await selectLottery(db)
    .where("lotteries.thread_id", "=", threadId)
    .executeTakeFirstOrThrow();
  const drawn = lottery.drawn_at !== null;
  const [count, mine, won] = await Promise.all([
    db
      .selectFrom(entrants(lottery).as("e"))
      .select(sql<number>`count(*)::integer`.as("count"))
      .executeTakeFirstOrThrow(),
    viewerId === null
      ? undefined
      : db
          .selectFrom(entrants(lottery).as("e"))
          .select("user_id")
          .where("user_id", "=", viewerId)
          .executeTakeFirst(),
    drawn
      ? db
          .selectFrom("lottery_entries")
          .select(["user_id", "prize"])
          .where("thread_id", "=", threadId)
          .where("prize", "is not", null)
          .execute()
      : [],
  ]);
  const prizeOf = new Map(won.map((w) => [w.user_id, w.prize]));
  const user = await userBriefs([...prizeOf.keys()]);
  const order = drawOrder(lottery.seed, [...prizeOf.keys()]);
  return {
    prizes: lottery.prizes.map((p, i) => ({
      ...p,
      won_by: drawn ? order.filter((id) => prizeOf.get(id) === i).map(user) : null,
    })),
    entry: lottery.entry,
    min_level: lottery.min_level,
    draws_at: lottery.draws_at,
    drawn_at: lottery.drawn_at,
    cancelled: lottery.cancelled_at !== null,
    seed_hash: lottery.seed_hash,
    seed: drawn ? lottery.seed : null,
    entry_count: count.count,
    entered: viewerId === null ? null : mine !== undefined,
  };
}

export type Lottery = Awaited<ReturnType<typeof getLottery>>;

// The thread as the reader opened it, already checked for whether they may see it.
type Opened = { id: number; author_id: number; status: string; locked: boolean };

function lotteryNotFound() {
  return new AppError(404, "lottery_not_found", "这个帖子没有抽奖");
}

function forbidden(message: string) {
  return new AppError(403, "forbidden", message);
}

// Its row, locked for the change being made, while it is still open.
async function lockOpen(trx: Transaction<DB>, threadId: number) {
  const lottery = await selectLottery(trx)
    .where("lotteries.thread_id", "=", threadId)
    .forUpdate("lotteries")
    .executeTakeFirst();
  if (!lottery) throw lotteryNotFound();
  if (lottery.cancelled_at !== null) throw new AppError(403, "lottery_closed", "抽奖已取消");
  if (lottery.drawn_at !== null || lottery.draws_at <= new Date()) {
    throw new AppError(403, "lottery_closed", "抽奖已开奖");
  }
  return lottery;
}

// Entering by button; again changes nothing.
export async function enter(actor: Actor, viewer: Viewer, thread: Opened) {
  if (thread.status !== "visible") throw forbidden("帖子待审核或已隐藏，暂时不能参与");
  if (thread.locked) throw new AppError(403, "thread_locked", "帖子已锁定");
  if (thread.author_id === viewer.id) throw forbidden("不能参与自己发起的抽奖");
  await db.transaction().execute(async (trx) => {
    const lottery = await lockOpen(trx, thread.id);
    if (lottery.entry === "reply") throw forbidden("此抽奖通过回复帖子参与");
    if (viewer.level < lottery.min_level && !STAFF.includes(viewer.role)) {
      throw new AppError(403, "level_required", `L${lottery.min_level} 起才能参与这个抽奖`);
    }
    const added = await trx
      .insertInto("lottery_entries")
      .values({ thread_id: thread.id, user_id: viewer.id })
      .onConflict((oc) => oc.doNothing())
      .returning("user_id")
      .executeTakeFirst();
    if (!added) return;
    await recordAudit(trx, actor, {
      action: "lottery.enter",
      target_type: "thread",
      target_id: thread.id,
    });
  });
}

export async function leave(actor: Actor, viewer: Viewer, thread: Opened) {
  await db.transaction().execute(async (trx) => {
    const lottery = await lockOpen(trx, thread.id);
    if (lottery.entry === "reply") throw forbidden("此抽奖通过回复帖子参与，删除回复即退出");
    const removed = await trx
      .deleteFrom("lottery_entries")
      .where("thread_id", "=", thread.id)
      .where("user_id", "=", viewer.id)
      .returning("user_id")
      .executeTakeFirst();
    if (!removed) return;
    await recordAudit(trx, actor, {
      action: "lottery.leave",
      target_type: "thread",
      target_id: thread.id,
    });
  });
}

// Before the draw, by the author or a moderator; those who entered are told on the site.
export async function cancelLottery(actor: Actor, moderator: boolean, thread: Opened) {
  if (thread.author_id !== actor.userId && !moderator) {
    throw forbidden("只有楼主和版主能取消抽奖");
  }
  await db.transaction().execute(async (trx) => {
    const lottery = await lockOpen(trx, thread.id);
    await trx
      .updateTable("lotteries")
      .set({ cancelled_at: sql<Date>`now()` })
      .where("thread_id", "=", thread.id)
      .execute();
    const told = await trx.selectFrom(entrants(lottery).as("e")).select("user_id").execute();
    await notifyLottery(
      trx,
      { id: thread.id, title: lottery.title },
      told.map((e) => ({ userId: e.user_id, result: "cancelled" })),
    );
    await recordAudit(trx, actor, {
      action: "lottery.cancel",
      target_type: "thread",
      target_id: thread.id,
    });
  });
}

// Who is in, members only: in order of entering until it is drawn, then in the order drawn, which
// is what checking it takes.
export async function listEntries(lottery: Lottery | null, threadId: number) {
  if (!lottery) throw lotteryNotFound();
  const row = await selectLottery(db)
    .where("lotteries.thread_id", "=", threadId)
    .executeTakeFirstOrThrow();
  const rows = await db
    .selectFrom(entrants(row).as("e"))
    .select(["user_id", "prize"])
    .orderBy("created_at")
    .orderBy("user_id")
    .execute();
  const prize = new Map(rows.map((r) => [r.user_id, r.prize]));
  const ids = rows.map((r) => r.user_id);
  const user = await userBriefs(ids);
  return (lottery.seed === null ? ids : drawOrder(lottery.seed, ids)).map((id) => ({
    user: user(id),
    prize: prize.get(id) ?? null,
  }));
}

// Every minute: the lotteries whose time has come, except in deleted threads.
export async function drawDue() {
  const due = await db
    .selectFrom("lotteries")
    .innerJoin("threads", "threads.id", "lotteries.thread_id")
    .select("lotteries.thread_id")
    .where("lotteries.drawn_at", "is", null)
    .where("lotteries.cancelled_at", "is", null)
    .where("lotteries.draws_at", "<=", sql<Date>`now()`)
    .where("threads.deleted_at", "is", null)
    .execute();
  for (const { thread_id } of due) await draw(thread_id);
}

// Fixes who it is drawn from in the entries, gives out the prizes in the draw order, and tells
// everyone: the entrants how it went, the author that it is drawn, the plugin who won.
async function draw(threadId: number) {
  await db.transaction().execute(async (trx) => {
    const lottery = await selectLottery(trx)
      .where("lotteries.thread_id", "=", threadId)
      .where("lotteries.drawn_at", "is", null)
      .where("lotteries.cancelled_at", "is", null)
      .forUpdate("lotteries")
      .executeTakeFirst();
    if (!lottery) return;
    if (lottery.entry === "reply") {
      await trx
        .insertInto("lottery_entries")
        .columns(["thread_id", "user_id", "created_at"])
        .expression(
          db
            .selectFrom(repliers(lottery).as("r"))
            .select([sql<number>`${threadId}::integer`.as("thread_id"), "author_id", "created_at"]),
        )
        .execute();
    }
    await trx
      .deleteFrom("lottery_entries")
      .where("thread_id", "=", threadId)
      .where("user_id", "not in", eligible(lottery))
      .execute();
    const ids = (
      await trx
        .selectFrom("lottery_entries")
        .select("user_id")
        .where("thread_id", "=", threadId)
        .execute()
    ).map((e) => e.user_id);

    const order = drawOrder(lottery.seed, ids);
    let next = 0;
    const won = lottery.prizes.map((p) => order.slice(next, (next += p.winners)));
    for (const [prize, winners] of won.entries()) {
      if (winners.length === 0) continue;
      await trx
        .updateTable("lottery_entries")
        .set({ prize })
        .where("thread_id", "=", threadId)
        .where("user_id", "in", winners)
        .execute();
    }
    await trx
      .updateTable("lotteries")
      .set({ drawn_at: sql<Date>`now()` })
      .where("thread_id", "=", threadId)
      .execute();

    const prizeOf = new Map(won.flatMap((winners, i) => winners.map((id) => [id, i])));
    const prizes = lottery.prizes.map((p, i) => ({ name: p.name, winners: won[i] }));
    const thread = { id: threadId, title: lottery.title };
    await notifyLottery(trx, thread, [
      ...ids.map((userId) => {
        const prize = prizeOf.get(userId);
        return prize === undefined
          ? { userId, result: "lost" as const }
          : { userId, result: "won" as const, prize: lottery.prizes[prize].name };
      }),
      { userId: lottery.author_id, result: "drawn", prizes },
    ]);

    await lotteryDrawn(trx, {
      thread,
      authorId: lottery.author_id,
      prizes,
      entryCount: ids.length,
    });
  });
}
