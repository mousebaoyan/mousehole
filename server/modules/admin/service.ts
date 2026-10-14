import { sql } from "kysely";
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

// Partial edits merged onto the current settings. The mailboxes are replaced as a whole; one
// sent without a password keeps the one stored for its address.
export async function updateSettings(
  actor: Actor,
  change: {
    site?: Partial<Settings["site"]>;
    login?: Partial<Settings["login"]>;
    smtp?: { accounts: (Omit<SmtpAccount, "password"> & { password?: string })[] };
    bot?: Partial<Settings["bot"]>;
  },
) {
  const current = await getSettings();
  const stored = new Map(current.smtp.accounts.map((a) => [a.user, a.password]));
  await db.transaction().execute(async (trx) => {
    await saveSettings(trx, {
      site: change.site && { ...current.site, ...change.site },
      login: change.login && { ...current.login, ...change.login },
      smtp: change.smtp && {
        accounts: change.smtp.accounts.map((a) => ({
          ...a,
          password: a.password ?? stored.get(a.user) ?? "",
        })),
      },
      bot: change.bot && { ...current.bot, ...change.bot },
    });
    // Which sections changed, never their values: the SMTP password must not reach the log.
    const sections = Object.keys(change);
    await recordAudit(trx, actor, { action: "settings.update", data: { sections } });
  });
}
