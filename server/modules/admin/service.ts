import type { Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { getSettings, saveSettings, type Settings } from "../../platform/settings.ts";
import { recordAudit } from "../audit/service.ts";

// Partial edits merged onto the current settings. A missing SMTP password keeps the stored one.
export async function updateSettings(
  actor: Actor,
  change: { login?: Partial<Settings["login"]>; smtp?: Partial<Settings["smtp"]> },
) {
  const current = await getSettings();
  await db.transaction().execute(async (trx) => {
    await saveSettings(trx, {
      login: change.login && { ...current.login, ...change.login },
      smtp: change.smtp && { ...current.smtp, ...change.smtp },
    });
    // Which sections changed, never their values: the SMTP password must not reach the log.
    const sections = Object.keys(change);
    await recordAudit(trx, actor, { action: "settings.update", data: { sections } });
  });
}
