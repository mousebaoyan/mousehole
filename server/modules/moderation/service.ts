import { restrictionOf, type Actor, type UserRef } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { recordAudit } from "../audit/service.ts";
import { endAllSessions } from "../auth/service.ts";
import { findMember, saveRestriction } from "../users/service.ts";

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
  if (!current) throw new AppError(404, "not_restricted", "没有被禁言或封禁");
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
