import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import type { JsonObject } from "../../../db/types.ts";
import type { Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import {
  getSettings,
  saveSettings,
  type Settings,
  type SmtpAccount,
} from "../../platform/settings.ts";
import { recordAudit } from "../audit/service.ts";

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
    notify?: Settings["notify"];
    weekly?: Partial<Settings["weekly"]>;
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
    notify: change.notify && { email: { ...current.notify.email, ...change.notify.email } },
    weekly: change.weekly && { ...current.weekly, ...change.weekly },
  };
  const passwords = (next.smtp?.accounts ?? [])
    .filter((a) => a.password !== stored.get(a.user))
    .map((a) => a.user);
  const logged = Object.fromEntries(
    Object.entries({
      site: next.site && changes(current.site, next.site),
      login: next.login && changes(current.login, next.login),
      bot: next.bot && changes(current.bot, next.bot),
      notify: next.notify && changes(current.notify.email, next.notify.email),
      weekly: next.weekly && changes(current.weekly, next.weekly),
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
