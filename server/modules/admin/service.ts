import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { JsonObject } from "../../../db/types.ts";
import type { Actor, UserRef } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import {
  getSettings,
  saveSettings,
  type Settings,
  type SmtpAccount,
} from "../../platform/settings.ts";
import { recordAudit } from "../audit/service.ts";
import { findMember, userBriefs } from "../users/service.ts";

export async function databaseBytes() {
  const { bytes } = await db
    .selectNoFrom(sql<number>`pg_database_size(current_database())`.as("bytes"))
    .executeTakeFirstOrThrow();
  return bytes;
}

// The fields that differ, each with its value before and after.
function changes(before: JsonObject, after: JsonObject) {
  return Object.fromEntries(
    Object.entries(after)
      .filter(([key, value]) => !isDeepStrictEqual(before[key], value))
      .map(([key, value]) => [key, { from: before[key] ?? null, to: value ?? null }]),
  );
}

// The payee as the settings page shows them, with the QQ number to fill the field.
export async function payeeOf(id: number) {
  const { qq } = await db
    .selectFrom("users")
    .select("qq")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return { ...(await userBriefs([id]))(id), qq };
}

// The payee confirms sponsorships with the owner in the admin pages (design §8.21), which are for
// admins.
async function payeeId(ref: UserRef) {
  const user = await findMember(ref);
  if (user?.role !== "admin") throw new AppError(400, "invalid_request", "收款人只能是管理员");
  return user.id;
}

// A mailbox as the log shows it: never the password.
function mailbox({ host, port, secure, user }: SmtpAccount) {
  return { host, port, secure, user };
}

// Partial edits merged onto the current settings. The mailboxes are replaced as a whole; one
// sent without a password keeps the one stored for its address. The log gets every field that
// changed, before and after; for mailboxes, only which passwords changed.
export async function updateSettings(
  actor: Actor,
  change: {
    site?: Partial<Settings["site"]>;
    login?: Partial<Settings["login"]>;
    smtp?: { accounts: (Omit<SmtpAccount, "password"> & { password?: string })[] };
    bot?: Partial<Settings["bot"]>;
    notify?: Partial<Settings["notify"]>;
    weekly?: Partial<Settings["weekly"]>;
    sponsor?: Partial<Omit<Settings["sponsor"], "payee"> & { payee: UserRef | null }>;
  },
) {
  const current = await getSettings();
  const stored = new Map(current.smtp.accounts.map((a) => [a.user, a.password]));
  const next = {
    site: change.site && { ...current.site, ...change.site },
    login: change.login && { ...current.login, ...change.login },
    smtp: change.smtp && {
      accounts: change.smtp.accounts.map((a) => ({
        ...a,
        password: a.password ?? stored.get(a.user) ?? "",
      })),
    },
    bot: change.bot && { ...current.bot, ...change.bot },
    notify: change.notify && {
      ...current.notify,
      ...change.notify,
      email: { ...current.notify.email, ...change.notify.email },
    },
    weekly: change.weekly && { ...current.weekly, ...change.weekly },
    sponsor: change.sponsor && {
      ...current.sponsor,
      ...change.sponsor,
      payee:
        change.sponsor.payee === undefined
          ? current.sponsor.payee
          : change.sponsor.payee && (await payeeId(change.sponsor.payee)),
    },
  };
  const passwords = (next.smtp?.accounts ?? [])
    .filter((a) => a.password !== stored.get(a.user))
    .map((a) => a.user);
  const logged = Object.fromEntries(
    Object.entries({
      site: next.site && changes(current.site, next.site),
      login: next.login && changes(current.login, next.login),
      bot: next.bot && changes(current.bot, next.bot),
      notify:
        next.notify &&
        changes(
          { ...current.notify.email, unactivated: current.notify.unactivated },
          { ...next.notify.email, unactivated: next.notify.unactivated },
        ),
      weekly: next.weekly && changes(current.weekly, next.weekly),
      sponsor: next.sponsor && changes(current.sponsor, next.sponsor),
      smtp: next.smtp && {
        ...changes(
          { accounts: current.smtp.accounts.map(mailbox) },
          { accounts: next.smtp.accounts.map(mailbox) },
        ),
        ...(passwords.length > 0 && { passwords_changed: passwords }),
      },
    }).filter(([, fields]) => fields && Object.keys(fields).length > 0),
  );
  if (Object.keys(logged).length === 0) return;
  await db.transaction().execute(async (trx) => {
    await saveSettings(trx, next);
    await recordAudit(trx, actor, { action: "settings.update", data: logged });
  });
}
