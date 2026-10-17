import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Transaction } from "kysely";
import { z } from "zod";
import type { DB } from "../../db/types.ts";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { BOT_NAME } from "./site.ts";

// Admin-editable settings, one row per key. Fields default here, so new fields need no
// migration. Cached in the process: there is one process, and every change goes through here.

const LoginSchema = z.object({
  code: z.boolean().default(true),
  link: z.boolean().default(true),
  email: z.boolean().default(true),
  // Shown with the code on the login page; {code} is replaced.
  code_hint: z.string().default(`私聊${BOT_NAME}，发送下方的 6 位口令`),
});

const SmtpAccountSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  secure: z.boolean(),
  user: z.string(),
  // Encrypted at rest with APP_SECRET; plain text in memory.
  password: z.string(),
});
export type SmtpAccount = z.infer<typeof SmtpAccountSchema>;

// Mailboxes to send from, tried in order (platform/mail.ts).
const SmtpSchema = z.object({ accounts: z.array(SmtpAccountSchema).default([]) });

const SiteSchema = z.object({
  // One line across the top of every forum page; empty shows none.
  banner: z.string().default(""),
  // QQ numbers show to members and bots; this shows them to guests as well.
  qq_public: z.boolean().default(false),
});

const BotSchema = z.object({
  // Bot requests acting as a member must say who asked for them.
  require_operator: z.boolean().default(false),
});

// Per notification type, whether it may go by email and whether it does for people who never
// set it: on and off are that default, never takes the choice away. Types not here keep the
// notifications module's own default. Unactivated says whether people who never logged in get
// emails too, the weekly letter among them.
const EMAIL_POLICIES = ["on", "off", "never"] as const;
export type EmailPolicy = (typeof EMAIL_POLICIES)[number];
const NotifySchema = z.object({
  email: z.partialRecord(z.string(), z.enum(EMAIL_POLICIES)).default({}),
  unactivated: z.boolean().default(false),
});

// The weekly mail on what people's floors did for others (design §8.15): who gets one, and from
// what likes a floor of theirs is shown in it.
const WeeklySchema = z.object({
  enabled: z.boolean().default(true),
  min_reads: z.number().int().default(20),
  min_likes: z.number().int().default(3),
  top_likes: z.number().int().default(5),
});

export type Settings = {
  site: z.infer<typeof SiteSchema>;
  login: z.infer<typeof LoginSchema>;
  smtp: z.infer<typeof SmtpSchema>;
  bot: z.infer<typeof BotSchema>;
  notify: z.infer<typeof NotifySchema>;
  weekly: z.infer<typeof WeeklySchema>;
};

let cache: Promise<Settings> | null = null;

// AES-256-GCM, stored as base64 of IV, auth tag and ciphertext.
function encrypt(text: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", env.APP_SECRET, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function decrypt(stored: string) {
  const raw = Buffer.from(stored, "base64");
  const decipher = createDecipheriv("aes-256-gcm", env.APP_SECRET, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

async function load(): Promise<Settings> {
  const rows = await db.selectFrom("settings").select(["key", "value"]).execute();
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const smtp = SmtpSchema.parse(stored.get("smtp") ?? {});
  return {
    site: SiteSchema.parse(stored.get("site") ?? {}),
    login: LoginSchema.parse(stored.get("login") ?? {}),
    smtp: { accounts: smtp.accounts.map((a) => ({ ...a, password: decrypt(a.password) })) },
    bot: BotSchema.parse(stored.get("bot") ?? {}),
    notify: NotifySchema.parse(stored.get("notify") ?? {}),
    weekly: WeeklySchema.parse(stored.get("weekly") ?? {}),
  };
}

export function getSettings() {
  cache ??= load().catch((error: unknown) => {
    cache = null;
    throw error;
  });
  return cache;
}

// Replaces the given sections. Callers merge partial edits with getSettings() first.
export async function saveSettings(trx: Transaction<DB>, change: Partial<Settings>) {
  const rows = [];
  if (change.site) rows.push({ key: "site", value: JSON.stringify(change.site) });
  if (change.login) rows.push({ key: "login", value: JSON.stringify(change.login) });
  if (change.bot) rows.push({ key: "bot", value: JSON.stringify(change.bot) });
  if (change.notify) rows.push({ key: "notify", value: JSON.stringify(change.notify) });
  if (change.weekly) rows.push({ key: "weekly", value: JSON.stringify(change.weekly) });
  if (change.smtp) {
    const accounts = change.smtp.accounts.map((a) => ({ ...a, password: encrypt(a.password) }));
    rows.push({ key: "smtp", value: JSON.stringify({ accounts }) });
  }
  if (rows.length === 0) return;
  await trx
    .insertInto("settings")
    .values(rows)
    .onConflict((oc) => oc.column("key").doUpdateSet((eb) => ({ value: eb.ref("excluded.value") })))
    .execute();
  cache = null;
}
