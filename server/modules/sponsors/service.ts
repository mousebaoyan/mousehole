import { sql, type Kysely, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import type { Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { getSettings } from "../../platform/settings.ts";
import { recordAudit } from "../audit/service.ts";
import { notifySponsorship } from "../notifications/service.ts";
import { shownToGuests } from "../users/service.ts";
import type { Method, Status } from "./rules.ts";

// Sponsorships (design §8.21): paid into the payee's own codes, registered here by whoever paid,
// confirmed by the payee or the owner.

const WALL_PAGE = 50;
const REVIEW_PAGE = 30;
const MINE = 50;

const COLUMNS = [
  "id",
  "user_id",
  "amount",
  "method",
  "status",
  "message",
  "anonymous",
  "show_amount",
  "paid_at",
  "reviewer_id",
  "reviewed_at",
  "reason",
  "created_at",
] as const;

function sponsorships(executor: Kysely<DB> = db) {
  return executor
    .selectFrom("sponsorships")
    .select(COLUMNS)
    .$narrowType<{ method: Method; status: Status }>();
}

type Sponsorship = Awaited<ReturnType<ReturnType<typeof sponsorships>["executeTakeFirstOrThrow"]>>;

function notFound(): never {
  throw new AppError(404, "not_found", "赞助记录不存在");
}

// The page's head: who is paid, what the codes hold, and this Beijing year's confirmed total.
export async function sponsorStatus() {
  const { sponsor } = await getSettings();
  const year = await db
    .selectFrom("sponsorships")
    .select([
      sql<number>`coalesce(sum(amount), 0)::integer`.as("amount"),
      sql<number>`count(*)::integer`.as("count"),
    ])
    .where("status", "=", "confirmed")
    .where(
      "paid_at",
      ">=",
      sql<Date>`date_trunc('year', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'`,
    )
    .executeTakeFirstOrThrow();
  return {
    payee: sponsor.payee,
    codes: { wechat: sponsor.wechat || null, alipay: sponsor.alipay || null },
    year,
  };
}

// The thanks wall: confirmed ones, the latest registered first. Guests miss those who keep their
// content from guests.
export async function listThanks(guest: boolean, cursor: number | undefined) {
  let query = sponsorships()
    .where("status", "=", "confirmed")
    .orderBy("id", "desc")
    .limit(WALL_PAGE);
  if (guest) query = query.where(shownToGuests("sponsorships.user_id"));
  if (cursor !== undefined) query = query.where("id", "<", cursor);
  const rows = await query.execute();
  const last = rows.at(-1);
  return { rows, next_cursor: rows.length === WALL_PAGE && last ? String(last.id) : null };
}

export async function listMine(userId: number) {
  return sponsorships().where("user_id", "=", userId).orderBy("id", "desc").limit(MINE).execute();
}

// For the payee and the owner: pending ones in the order they came, the rest the latest first.
export async function listForReview(status: Status, cursor: number | undefined) {
  const pending = status === "pending";
  let query = db
    .selectFrom("sponsorships")
    .innerJoin("users", "users.id", "sponsorships.user_id")
    .select([...COLUMNS.map((c) => `sponsorships.${c}` as const), "users.qq"])
    .$narrowType<{ method: Method; status: Status }>()
    .where("sponsorships.status", "=", status)
    .orderBy("sponsorships.id", pending ? "asc" : "desc")
    .limit(REVIEW_PAGE);
  if (cursor !== undefined) query = query.where("sponsorships.id", pending ? ">" : "<", cursor);
  const rows = await query.execute();
  const last = rows.at(-1);
  return { rows, next_cursor: rows.length === REVIEW_PAGE && last ? String(last.id) : null };
}

export async function countPending() {
  const { count } = await db
    .selectFrom("sponsorships")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("status", "=", "pending")
    .executeTakeFirstOrThrow();
  return count;
}

// One at a time each: until the payee sees to it, nobody piles up more.
export async function registerSponsorship(
  actor: Actor,
  entry: {
    method: Method;
    amount: number;
    message: string | null;
    anonymous: boolean;
    show_amount: boolean;
  },
) {
  const { sponsor } = await getSettings();
  const payee = sponsor.payee;
  if (payee === null || sponsor[entry.method] === "") {
    throw new AppError(403, "sponsor_closed", "暂未开放这种付款方式");
  }
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("sponsorships")
      .values({ ...entry, user_id: actor.userId })
      .onConflict((oc) => oc.column("user_id").where("status", "=", "pending").doNothing())
      .returning(COLUMNS)
      .$narrowType<{ method: Method; status: Status }>()
      .executeTakeFirst();
    if (!row) {
      throw new AppError(409, "sponsorship_pending", "你有一笔赞助待确认，确认后才能再次登记");
    }
    await notifySponsorship(trx, payee, actor.userId, { action: "pending", sponsorship: row });
    await recordAudit(trx, actor, {
      action: "sponsorship.create",
      target_type: "sponsorship",
      target_id: row.id,
      data: entry,
    });
    return row;
  });
}

async function lockOne(trx: Transaction<DB>, id: number) {
  return (
    (await sponsorships(trx).where("id", "=", id).forUpdate().executeTakeFirst()) ?? notFound()
  );
}

// Whoever paid may go anonymous or not and show the amount or not at any time, and take the message
// down, but not reword it: every message on the wall is one the payee has read, so corrections go
// through the payee.
export async function editOwnSponsorship(
  actor: Actor,
  id: number,
  change: { anonymous?: boolean; show_amount?: boolean; message?: null },
) {
  await db.transaction().execute(async (trx) => {
    const row = await lockOne(trx, id);
    if (row.user_id !== actor.userId) notFound();
    await trx.updateTable("sponsorships").set(change).where("id", "=", id).execute();
    await recordAudit(trx, actor, {
      action: "sponsorship.edit",
      target_type: "sponsorship",
      target_id: id,
      data: change,
    });
  });
}

export async function withdrawSponsorship(actor: Actor, id: number) {
  await db.transaction().execute(async (trx) => {
    const row = await lockOne(trx, id);
    if (row.user_id !== actor.userId) notFound();
    if (row.status !== "pending") {
      throw new AppError(409, "sponsorship_reviewed", "收款人已处理这笔赞助，无法撤回");
    }
    await trx.deleteFrom("sponsorships").where("id", "=", id).execute();
    await recordAudit(trx, actor, {
      action: "sponsorship.withdraw",
      target_type: "sponsorship",
      target_id: id,
      data: { amount: row.amount, method: row.method },
    });
  });
}

// Paid without registering, or before the forum: confirmed at once, and anonymous with the amount
// hidden until whoever paid chooses otherwise.
export async function addSponsorship(
  actor: Actor,
  entry: { user_id: number; method: Method; amount: number; paid_at: Date; message: string | null },
) {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto("sponsorships")
      .values({
        ...entry,
        status: "confirmed",
        anonymous: true,
        show_amount: false,
        reviewer_id: actor.userId,
        reviewed_at: sql<Date>`now()`,
      })
      .returning(COLUMNS)
      .$narrowType<{ method: Method; status: Status }>()
      .executeTakeFirstOrThrow();
    await notifySponsorship(trx, row.user_id, actor.userId, {
      action: "confirmed",
      sponsorship: row,
    });
    await recordAudit(trx, actor, {
      action: "sponsorship.add",
      target_type: "sponsorship",
      target_id: row.id,
      data: { ...entry, paid_at: entry.paid_at.toISOString() },
    });
    return row;
  });
}

// Confirmed with what really came, turned down with why, a confirmation taken back, the message
// corrected or taken down, or anonymity and the amount's showing set right. Whoever paid hears when its status changes.
export async function reviewSponsorship(
  actor: Actor,
  id: number,
  change: {
    status?: "confirmed" | "rejected";
    reason?: string | null;
    amount?: number;
    anonymous?: boolean;
    show_amount?: boolean;
    message?: string | null;
  },
) {
  await db.transaction().execute(async (trx) => {
    const before = await lockOne(trx, id);
    const { status, reason, ...rest } = change;
    const reviewed = status !== undefined && status !== before.status;
    const after: Sponsorship = {
      ...before,
      ...rest,
      ...(reviewed && {
        status,
        reason: reason ?? null,
        reviewer_id: actor.userId,
        reviewed_at: new Date(),
      }),
    };
    await trx
      .updateTable("sponsorships")
      .set({
        amount: after.amount,
        anonymous: after.anonymous,
        show_amount: after.show_amount,
        message: after.message,
        status: after.status,
        reason: after.reason,
        reviewer_id: after.reviewer_id,
        reviewed_at: after.reviewed_at,
      })
      .where("id", "=", id)
      .execute();
    if (reviewed) {
      await notifySponsorship(trx, after.user_id, actor.userId, {
        action: status,
        sponsorship: after,
      });
    }
    await recordAudit(trx, actor, {
      action: reviewed
        ? `sponsorship.${status === "confirmed" ? "confirm" : "reject"}`
        : "sponsorship.update",
      target_type: "sponsorship",
      target_id: id,
      data: {
        amount: after.amount,
        ...(rest.amount !== undefined &&
          rest.amount !== before.amount && { amount_was: before.amount }),
        ...(rest.anonymous !== undefined &&
          rest.anonymous !== before.anonymous && { anonymous: after.anonymous }),
        ...(rest.show_amount !== undefined &&
          rest.show_amount !== before.show_amount && { show_amount: after.show_amount }),
        ...(rest.message !== undefined &&
          rest.message !== before.message && {
            message: after.message,
            message_was: before.message,
          }),
        ...(reviewed && { status_was: before.status, reason: after.reason }),
      },
    });
  });
}

export async function deleteSponsorship(actor: Actor, id: number) {
  await db.transaction().execute(async (trx) => {
    const row = await lockOne(trx, id);
    await trx.deleteFrom("sponsorships").where("id", "=", id).execute();
    await recordAudit(trx, actor, {
      action: "sponsorship.delete",
      target_type: "sponsorship",
      target_id: id,
      data: {
        user_id: row.user_id,
        amount: row.amount,
        method: row.method,
        status: row.status,
        paid_at: row.paid_at.toISOString(),
      },
    });
  });
}
