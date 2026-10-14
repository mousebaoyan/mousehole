import { sql, type Transaction } from "kysely";
import { createTransport } from "nodemailer";
import type { DB } from "../../db/types.ts";
import { db } from "./db.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";
import { getSettings, type SmtpAccount } from "./settings.ts";
import { SITE_NAME } from "./site.ts";

// Sending goes through the mailboxes from the admin settings in order. One that fails rests a
// while and the next takes over: a QQ mailbox that sent too much refuses for minutes up to the
// rest of the day.
const REST_MS = 30 * 60_000;
const resting = new Map<string, number>();

function send(account: SmtpAccount, to: string, subject: string, text: string) {
  const transport = createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.password },
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport.sendMail({
    from: { name: SITE_NAME, address: account.user },
    to,
    subject,
    text,
  });
}

// The server turned the address down, rather than this mailbox failing to send.
function refused(error: unknown) {
  return (
    error instanceof Error &&
    "command" in error &&
    error.command === "RCPT TO" &&
    "responseCode" in error &&
    Number(error.responseCode) >= 500
  );
}

// "refused" when every mailbox tried turned the address down: sending again won't help.
async function deliver(to: string, subject: string, text: string) {
  const { smtp } = await getSettings();
  let tried = 0;
  let refusals = 0;
  for (const account of smtp.accounts) {
    if ((resting.get(account.user) ?? 0) > Date.now()) continue;
    tried += 1;
    try {
      await send(account, to, subject, text);
      return "sent";
    } catch (error) {
      resting.set(account.user, Date.now() + REST_MS);
      log("warn", "Sending mail failed", { account: account.user, error });
      if (refused(error)) refusals += 1;
    }
  }
  return tried > 0 && refusals === tried ? "refused" : "failed";
}

// Sends now, for whoever is waiting on it. Called after transactions commit: a slow mail server
// must not hold database locks.
export async function sendMail(to: string, subject: string, text: string) {
  if ((await getSettings()).smtp.accounts.length === 0) {
    throw new AppError(503, "email_not_configured", "邮件服务还没有配置");
  }
  if ((await deliver(to, subject, text)) !== "sent") {
    throw new AppError(502, "email_failed", "邮件发送失败，请稍后再试");
  }
}

// One test email from each mailbox, resting or not; one that sends is no longer resting.
export async function testMailboxes(to: string) {
  const { smtp } = await getSettings();
  if (smtp.accounts.length === 0) {
    throw new AppError(503, "email_not_configured", "邮件服务还没有配置");
  }
  const results = [];
  for (const account of smtp.accounts) {
    try {
      await send(account, to, `${SITE_NAME}测试邮件`, `${account.user} 可以正常发信。`);
      resting.delete(account.user);
      results.push({ user: account.user, error: null });
    } catch (error) {
      results.push({
        user: account.user,
        error: error instanceof Error ? error.message : "发送失败",
      });
    }
  }
  return results;
}

// ---- Reminder emails (design §8.6): queued in the transaction that causes them, sent after.

export const MAIL_CHANNEL = "mousehole_mail";

// The NOTIFY reaches sendQueued only once the transaction commits.
export async function queueMail(
  trx: Transaction<DB>,
  mails: { address: string; subject: string; body: string }[],
) {
  if (mails.length === 0) return;
  await trx.insertInto("mail_queue").values(mails).execute();
  await sql`SELECT pg_notify(${MAIL_CHANNEL}, '')`.execute(trx);
}

let sending = Promise.resolve();

// After each NOTIFY, and every minute for what couldn't go yet. Runs one at a time.
export function sendQueued() {
  sending = sending
    .then(drain)
    .catch((error: unknown) => log("error", "Sending queued mail failed", { error }));
  return sending;
}

// Oldest first, until no mailbox can send. A reminder a day late is no use any more.
async function drain() {
  const stale = await db
    .deleteFrom("mail_queue")
    .where("created_at", "<", sql<Date>`now() - interval '1 day'`)
    .executeTakeFirst();
  if (stale.numDeletedRows > 0n) {
    log("warn", "Dropped mail unsent for a day", { count: Number(stale.numDeletedRows) });
  }
  if ((await getSettings()).smtp.accounts.length === 0) return;
  for (;;) {
    const mail = await db
      .selectFrom("mail_queue")
      .select(["id", "address", "subject", "body"])
      .orderBy("id")
      .limit(1)
      .executeTakeFirst();
    if (!mail) return;
    const outcome = await deliver(mail.address, mail.subject, mail.body);
    if (outcome === "failed") return;
    if (outcome === "refused") log("warn", "Mail refused", { address: mail.address });
    await db.deleteFrom("mail_queue").where("id", "=", mail.id).execute();
  }
}
