import { createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { sql, type RawBuilder, type Transaction } from "kysely";
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

// Mails sent without the queue, into the log as sent or dropped.
async function logSent(kind: "login" | "test", sent: boolean[]) {
  const now = new Date();
  await db
    .insertInto("mail_log")
    .values(sent.map((s) => (s ? { kind, sent_at: now } : { kind, dropped_at: now })))
    .execute();
}

// Login codes, sent now for whoever is waiting on them. Called after transactions commit: a slow
// mail server must not hold database locks.
export async function sendMail(to: string, subject: string, text: string, html: string) {
  if ((await getSettings()).smtp.accounts.length === 0) {
    throw new AppError(503, "email_not_configured", "尚未配置发信邮箱");
  }
  const sent = (await deliver({ to, subject, text, html })) === "sent";
  await logSent("login", [sent]);
  if (!sent) throw new AppError(502, "email_failed", "邮件发送失败，请稍后重试");
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
  await logSent(
    "test",
    results.map((r) => r.error === null),
  );
  return results;
}

// ---- Reminder emails (design §8.6): queued in the transaction that causes them, sent after.

export const MAIL_CHANNEL = "mousehole_mail";

// `kind` is the notification type, or "weekly" for the weekly letters. The NOTIFY reaches
// sendQueued only once the transaction commits.
export async function queueMail(
  trx: Transaction<DB>,
  mails: {
    kind: string;
    address: string;
    subject: string;
    body: string;
    html: string;
    unsubscribe?: string;
  }[],
) {
  if (mails.length === 0) return;
  // Postgres returns the rows of an insert in the order given.
  const logged = await trx
    .insertInto("mail_log")
    .values(mails.map((m) => ({ kind: m.kind })))
    .returning("id")
    .execute();
  await trx
    .insertInto("mail_queue")
    .values(
      mails.map(({ address, subject, body, html, unsubscribe }, i) => ({
        address,
        subject,
        body,
        html: tracked(html, logged[i].id),
        unsubscribe,
        mail_id: logged[i].id,
      })),
    )
    .execute();
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
  const stale = await settle(sql`created_at < now() - interval '1 day'`, "dropped_at");
  if (stale > 0) log("warn", "Dropped mail unsent for a day", { count: stale });
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
    await settle(sql`id = ${mail.id}`, outcome === "sent" ? "sent_at" : "dropped_at");
  }
}

// Takes mails off the queue, noting in the log that they were sent or dropped; how many.
async function settle(which: RawBuilder<unknown>, done: "sent_at" | "dropped_at") {
  const result = await sql`
    WITH settled AS (DELETE FROM mail_queue WHERE ${which} RETURNING mail_id)
    UPDATE mail_log SET ${sql.ref(done)} = now() FROM settled
    WHERE mail_log.id = settled.mail_id`.execute(db);
  return Number(result.numAffectedRows);
}

export async function clearOldMail() {
  await db
    .deleteFrom("mail_log")
    .where("created_at", "<", sql<Date>`now() - interval '400 days'`)
    .execute();
}

// ---- Signed links (design §8.6): APP_SECRET's HMAC of what they are about.

function sign(message: string) {
  return createHmac("sha256", env.APP_SECRET).update(message).digest("base64url");
}

function signed(message: string, sig: string) {
  const expected = Buffer.from(sign(message));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Unsubscribe links turn off one kind of mail without logging in: a notification type, or
// "weekly" for the weekly letters.
export function unsubscribeUrl(userId: number, kind: string) {
  return `${env.PUBLIC_URL}/unsubscribe?u=${userId}&k=${kind}&s=${sign(`${userId}:${kind}`)}`;
}

export function signedUnsubscribe(userId: number, kind: string, sig: string) {
  return signed(`${userId}:${kind}`, sig);
}

// Opens and clicks of reminders and letters, signed so that nobody counts them for other mails.
// The image at the end of the HTML loads when the mail is opened, and the links to the site carry
// the mail, all but the one that unsubscribes.
function tracked(html: string, id: number) {
  const sig = sign(`mail:${id}`);
  const site = `${env.PUBLIC_URL}/`;
  return html
    .replace(/href="([^"]+)"/g, (link, href: string) => {
      if (!href.startsWith(site) || href.startsWith(`${site}unsubscribe`)) return link;
      const url = new URL(href.replaceAll("&amp;", "&"));
      url.searchParams.set("m", `${id}.${sig}`);
      return `href="${url.href.replaceAll("&", "&amp;")}"`;
    })
    .replace(
      "</body>",
      `<img src="${site}mail/${id}.gif?s=${sig}" width="1" height="1" alt="" style="display:block;border:0;"></body>`,
    );
}

export async function recordOpen(id: string, sig: string) {
  if (!signed(`mail:${id}`, sig)) return;
  await db
    .updateTable("mail_log")
    .set({ opened_at: sql<Date>`now()` })
    .where("id", "=", Number(id))
    .where("opened_at", "is", null)
    .execute();
}

// From a link in the mail, which opened it too; `mark` is what the link carries.
export async function recordClick(mark: string) {
  const [id, sig = ""] = mark.split(".");
  if (!signed(`mail:${id}`, sig)) return;
  await db
    .updateTable("mail_log")
    .set({ clicked_at: sql<Date>`now()`, opened_at: sql<Date>`coalesce(opened_at, now())` })
    .where("id", "=", Number(id))
    .where("clicked_at", "is", null)
    .execute();
}
