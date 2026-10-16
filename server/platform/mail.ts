import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { sql, type Transaction } from "kysely";
import { createTransport } from "nodemailer";
import type { DB } from "../../db/types.ts";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { AppError } from "./errors.ts";
import { log } from "./log.ts";
import { mailPage } from "./mail-page.ts";
import { getSettings, type SmtpAccount } from "./settings.ts";
import { SITE_NAME } from "./site.ts";

// Sending goes through the mailboxes from the admin settings in order. One that fails rests a
// while and the next takes over: a QQ mailbox that sent too much refuses for minutes up to the
// rest of the day, and trying again too soon may make that longer. Each failure in a row doubles
// the rest.
const FIRST_REST_MS = 10 * 60_000;
const MAX_REST_MS = 8 * 60 * 60_000;
const resting = new Map<string, { until: number; failures: number }>();

// A mail: plain text, the HTML version mail apps show instead, and for reminders and letters the
// link that stops them.
type Mail = {
  to: string;
  subject: string;
  text: string;
  html: string;
  unsubscribe?: string | null;
};

function send(account: SmtpAccount, { to, subject, text, html, unsubscribe }: Mail) {
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
    html,
    // RFC 8058: mail apps that show their own unsubscribe button post to the link, which the page
    // there takes as pressing its button.
    ...(unsubscribe && {
      list: { unsubscribe },
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
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
// "resting" when no mailbox could try.
async function deliver(mail: Mail) {
  const { smtp } = await getSettings();
  let tried = 0;
  let refusals = 0;
  for (const account of smtp.accounts) {
    const rest = resting.get(account.user);
    if (rest && rest.until > Date.now()) continue;
    tried += 1;
    try {
      await send(account, mail);
      resting.delete(account.user);
      return "sent";
    } catch (error) {
      const failures = (rest?.failures ?? 0) + 1;
      const ms = Math.min(FIRST_REST_MS * 2 ** (failures - 1), MAX_REST_MS);
      resting.set(account.user, { until: Date.now() + ms, failures });
      log("warn", "Sending mail failed", { account: account.user, error });
      if (refused(error)) refusals += 1;
    }
  }
  if (tried === 0) return "resting";
  return refusals === tried ? "refused" : "failed";
}

// Sends now, for whoever is waiting on it. Called after transactions commit: a slow mail server
// must not hold database locks.
export async function sendMail(to: string, subject: string, text: string, html: string) {
  if ((await getSettings()).smtp.accounts.length === 0) {
    throw new AppError(503, "email_not_configured", "尚未配置发信邮箱");
  }
  if ((await deliver({ to, subject, text, html })) !== "sent") {
    throw new AppError(502, "email_failed", "邮件发送失败，请稍后重试");
  }
}

// One test email from each mailbox, resting or not; one that sends is no longer resting.
export async function testMailboxes(to: string) {
  const { smtp } = await getSettings();
  if (smtp.accounts.length === 0) {
    throw new AppError(503, "email_not_configured", "尚未配置发信邮箱");
  }
  const results = [];
  for (const account of smtp.accounts) {
    try {
      const said = `${account.user} 可以正常发信。`;
      await send(account, {
        to,
        subject: `${SITE_NAME}测试邮件`,
        text: said,
        html: await mailPage(said, said),
      });
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
  mails: { address: string; subject: string; body: string; html: string; unsubscribe?: string }[],
) {
  if (mails.length === 0) return;
  await trx.insertInto("mail_queue").values(mails).execute();
  await sql`SELECT pg_notify(${MAIL_CHANNEL}, '')`.execute(trx);
}

// A mail that fails waits 5, 10, 20 and 40 minutes before trying again, then is dropped: one the
// mail servers keep failing on must not keep sending the mailboxes to rest.
const RETRY_MINUTES = 5;
const MAX_ATTEMPTS = 5;

let sending = Promise.resolve();

// After each NOTIFY, and every minute for what couldn't go yet. Runs one at a time.
export function sendQueued() {
  sending = sending
    .then(drain)
    .catch((error: unknown) => log("error", "Sending queued mail failed", { error }));
  return sending;
}

// Oldest due first, until no mailbox can send, a second or two apart so that a batch doesn't leave
// all at once. A reminder a day late is no use any more.
async function drain() {
  const stale = await db
    .deleteFrom("mail_queue")
    .where("created_at", "<", sql<Date>`now() - interval '1 day'`)
    .executeTakeFirst();
  if (stale.numDeletedRows > 0n) {
    log("warn", "Dropped mail unsent for a day", { count: Number(stale.numDeletedRows) });
  }
  if ((await getSettings()).smtp.accounts.length === 0) return;
  for (let first = true; ; first = false) {
    if (!first) await setTimeout(1000 + Math.random() * 1000);
    const mail = await db
      .selectFrom("mail_queue")
      .select(["id", "address", "subject", "body", "html", "unsubscribe", "attempts"])
      .where("next_at", "<=", sql<Date>`now()`)
      .orderBy("id")
      .limit(1)
      .executeTakeFirst();
    if (!mail) return;
    const outcome = await deliver({
      to: mail.address,
      subject: mail.subject,
      text: mail.body,
      html: mail.html,
      unsubscribe: mail.unsubscribe,
    });
    if (outcome === "resting") return;
    const attempts = mail.attempts + 1;
    if (outcome === "failed" && attempts < MAX_ATTEMPTS) {
      const minutes = RETRY_MINUTES * 2 ** (attempts - 1);
      await db
        .updateTable("mail_queue")
        .set({ attempts, next_at: sql<Date>`now() + make_interval(mins => ${minutes})` })
        .where("id", "=", mail.id)
        .execute();
      continue;
    }
    if (outcome === "failed")
      log("warn", "Dropped mail that kept failing", { address: mail.address });
    if (outcome === "refused") log("warn", "Mail refused", { address: mail.address });
    await db.deleteFrom("mail_queue").where("id", "=", mail.id).execute();
  }
}

// ---- Unsubscribe links (design §8.6): signed, so they turn off one kind of mail without logging in.

// What a link turns off: a notification type, or "weekly" for the weekly letters.
function signature(userId: number, kind: string) {
  return createHmac("sha256", env.APP_SECRET).update(`${userId}:${kind}`).digest("base64url");
}

export function unsubscribeUrl(userId: number, kind: string) {
  return `${env.PUBLIC_URL}/unsubscribe?u=${userId}&k=${kind}&s=${signature(userId, kind)}`;
}

export function signedUnsubscribe(userId: number, kind: string, sig: string) {
  const expected = Buffer.from(signature(userId, kind));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
