import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { restrictionOf, type Actor, type UserRef, type Viewer } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { AppError } from "../../platform/errors.ts";
import { excerpt } from "../../platform/markdown.ts";
import { recordAudit } from "../audit/service.ts";
import { endAllSessions } from "../auth/service.ts";
import { recordEvent } from "../events/service.ts";
import { getPost, holdReported, releaseReported, reportHolds } from "../threads/service.ts";
import {
  anonymousBrief,
  findMember,
  saveRestriction,
  userBriefs,
  writer,
} from "../users/service.ts";

// ---- Mutes and bans; see design §6.4. Moderators mute, admins also ban; only ordinary members
// can be either, so staff are demoted first.

async function ordinaryMember(ref: UserRef) {
  const user = await findMember(ref);
  if (!user) throw new AppError(404, "user_not_found", "用户不存在");
  if (user.role !== "user") throw new AppError(403, "forbidden", "只能禁言或封禁普通成员");
  return user;
}

// Replaces any restriction already there. A ban also logs them out everywhere.
export async function restrict(
  actor: Actor,
  ref: UserRef,
  change: { type: "mute" | "ban"; until: Date | null; reason: string },
) {
  const user = await ordinaryMember(ref);
  await db.transaction().execute(async (trx) => {
    await saveRestriction(trx, user.id, { type: change.type, until: change.until });
    if (change.type === "ban") await endAllSessions(trx, user.id);
    await recordAudit(trx, actor, {
      action: "user.restrict",
      target_type: "user",
      target_id: user.id,
      data: {
        type: change.type,
        until: change.until?.toISOString() ?? null,
        reason: change.reason,
      },
    });
  });
}

// Lifting a ban is for admins, as setting one is.
export async function lift(actor: Actor, admin: boolean, ref: UserRef, reason: string | undefined) {
  const user = await ordinaryMember(ref);
  const current = restrictionOf(user.restriction, user.restricted_until);
  if (!current) throw new AppError(404, "not_restricted", "该成员未被禁言或封禁");
  if (current.type === "ban" && !admin) {
    throw new AppError(403, "forbidden", "只有管理员能解除封禁");
  }
  await db.transaction().execute(async (trx) => {
    await saveRestriction(trx, user.id, null);
    await recordAudit(trx, actor, {
      action: "user.unrestrict",
      target_type: "user",
      target_id: user.id,
      data: { type: current.type, reason: reason ?? null },
    });
  });
}

// ---- Reports: members flag floors and boosts for moderators; see design §8.4.

const PAGE = 30;
const REPORT_EXCERPT = 120;

function alreadyReported() {
  return new AppError(409, "already_reported", "你已举报过，版主会尽快处理");
}

async function person(trx: Transaction<DB>, id: number) {
  return trx
    .selectFrom("users")
    .select(["id", "display_name", "qq"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

// With the writer's number in the thread when it was left anonymously.
async function boostOf(id: number) {
  const boost = await db
    .selectFrom("boosts")
    .innerJoin("posts", "posts.id", "boosts.post_id")
    .leftJoin("thread_aliases as alias", (join) =>
      join
        .onRef("alias.thread_id", "=", "posts.thread_id")
        .onRef("alias.user_id", "=", "boosts.user_id")
        .on("boosts.anonymous", "=", true),
    )
    .select([
      "boosts.id",
      "boosts.post_id",
      "boosts.user_id",
      "boosts.body",
      "alias.number as alias",
    ])
    .where("boosts.id", "=", id)
    .executeTakeFirst();
  if (!boost) throw new AppError(404, "boost_not_found", "短评不存在");
  return boost;
}

export async function reportPost(
  actor: Actor,
  viewer: Viewer,
  reach: number,
  postId: number,
  reason: string,
) {
  const post = await getPost(postId, { reach, id: viewer.id, staff: false });
  await fileReport(actor, viewer, post, null, reason);
}

export async function reportBoost(
  actor: Actor,
  viewer: Viewer,
  reach: number,
  boostId: number,
  reason: string,
) {
  const boost = await boostOf(boostId);
  const post = await getPost(boost.post_id, { reach, id: viewer.id, staff: false });
  await fileReport(actor, viewer, post, boost, reason);
}

// Each person once for each floor or boost. The bot plugin hears of it.
async function fileReport(
  actor: Actor,
  viewer: Viewer,
  post: Awaited<ReturnType<typeof getPost>>,
  boost: Awaited<ReturnType<typeof boostOf>> | null,
  reason: string,
) {
  if (post.deleted_at !== null) throw new AppError(404, "post_not_found", "回复不存在");
  const held = boost === null && (await reportHolds(viewer, post));
  await db.transaction().execute(async (trx) => {
    const created = await trx
      .insertInto("reports")
      .values({
        post_id: post.id,
        boost_id: boost?.id ?? null,
        reporter_id: viewer.id,
        reason,
        held,
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!created) throw alreadyReported();
    if (held) await holdReported(trx, post.id, viewer.id);
    await recordAudit(trx, actor, {
      action: "report.create",
      target_type: boost ? "boost" : "post",
      target_id: boost?.id ?? post.id,
      data: { reason, held },
    });
    await recordEvent(trx, "report.created", {
      report: { id: created.id, reason, held },
      post: { id: post.id, floor: post.floor, thread_id: post.thread_id },
      boost: boost && {
        id: boost.id,
        body: boost.body,
        author:
          boost.alias === null ? await person(trx, boost.user_id) : anonymousBrief(boost.alias),
      },
      reporter: await person(trx, viewer.id),
      url: `${env.PUBLIC_URL}/t/${post.thread_id}?floor=${post.floor}`,
    });
  });
}

export type ReportStatus = "open" | "resolved" | "dismissed";

// For moderators: newest first, a page at a time; the cursor is the last one's ID.
export async function listReports(status: ReportStatus, cursor: number | undefined) {
  let query = db
    .selectFrom("reports")
    .innerJoin("posts", "posts.id", "reports.post_id")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .leftJoin("boosts", "boosts.id", "reports.boost_id")
    .leftJoin("thread_aliases as alias", (join) =>
      join
        .onRef("alias.thread_id", "=", "posts.thread_id")
        .onRef("alias.user_id", "=", "posts.author_id")
        .on("posts.anonymous", "=", true),
    )
    .leftJoin("thread_aliases as boost_alias", (join) =>
      join
        .onRef("boost_alias.thread_id", "=", "posts.thread_id")
        .onRef("boost_alias.user_id", "=", "boosts.user_id")
        .on("boosts.anonymous", "=", true),
    )
    .select([
      "reports.id",
      "reports.reason",
      "reports.status",
      "reports.held",
      "reports.reporter_id",
      "reports.handler_id",
      "reports.handled_at",
      "reports.created_at",
      "posts.id as post_id",
      "posts.floor",
      "posts.html",
      "posts.author_id",
      "posts.deleted_at",
      "threads.id as thread_id",
      "threads.title",
      "boosts.id as boost_id",
      "boosts.body as boost_body",
      "boosts.user_id as boost_user_id",
      "alias.number as alias",
      "boost_alias.number as boost_alias",
    ])
    .where("reports.status", "=", status)
    .orderBy("reports.id", "desc")
    .limit(PAGE);
  if (cursor !== undefined) query = query.where("reports.id", "<", cursor);
  const rows = await query.execute();
  const user = await userBriefs(
    rows
      .flatMap((r) => [r.reporter_id, r.author_id, r.handler_id, r.boost_user_id])
      .filter((id) => id !== null),
  );
  const last = rows.at(-1);
  return {
    items: rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      status: r.status,
      held: r.held,
      reporter: user(r.reporter_id),
      post: {
        id: r.post_id,
        floor: r.floor,
        thread: { id: r.thread_id, title: r.title },
        author: writer(user, r.author_id, r.alias),
        excerpt: excerpt(r.html, REPORT_EXCERPT),
        deleted: r.deleted_at !== null,
      },
      boost:
        r.boost_id === null || r.boost_body === null || r.boost_user_id === null
          ? null
          : {
              id: r.boost_id,
              body: r.boost_body,
              user: writer(user, r.boost_user_id, r.boost_alias),
            },
      handler: r.handler_id === null ? null : user(r.handler_id),
      handled_at: r.handled_at,
      created_at: r.created_at,
    })),
    next_cursor: rows.length === PAGE && last ? String(last.id) : null,
  };
}

// Dealt with (whatever was done about the content), or not a problem after all.
export async function countOpenReports() {
  const { count } = await db
    .selectFrom("reports")
    .select(sql<number>`count(*)::integer`.as("count"))
    .where("status", "=", "open")
    .executeTakeFirstOrThrow();
  return count;
}

export async function handleReport(actor: Actor, id: number, status: "resolved" | "dismissed") {
  await db.transaction().execute(async (trx) => {
    const handled = await trx
      .updateTable("reports")
      .set({ status, handler_id: actor.userId, handled_at: sql<Date>`now()` })
      .where("id", "=", id)
      .returning(["post_id", "held"])
      .executeTakeFirst();
    if (!handled) throw new AppError(404, "report_not_found", "举报不存在");
    if (status === "dismissed" && handled.held) await releaseReported(trx, handled.post_id);
    await recordAudit(trx, actor, {
      action: status === "resolved" ? "report.resolve" : "report.dismiss",
      target_type: "report",
      target_id: id,
    });
  });
}
