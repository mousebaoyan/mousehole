import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Transaction } from "kysely";
import { z } from "zod";
import type { DB } from "../../db/types.ts";
import { db } from "./db.ts";
import { env } from "./env.ts";

// Admin-editable settings, one row per key. Fields default here, so new fields need no
// migration. Cached in the process: there is one process, and every change goes through here.

const LoginSchema = z.object({
  code: z.boolean().default(true),
  link: z.boolean().default(true),
  email: z.boolean().default(true),
  // Shown with the code on the login page; {code} is replaced.
  code_hint: z.string().default("私聊机器人发送：登录 {code}"),
});

const SmtpSchema = z.object({
  host: z.string().default(""),
  port: z.number().int().default(465),
  secure: z.boolean().default(true),
  user: z.string().default(""),
  // Encrypted at rest with APP_SECRET; plain text in memory.
  password: z.string().default(""),
  from: z.string().default(""),
});

const BotSchema = z.object({
  // Bot requests acting as a member must say who asked for them.
  require_operator: z.boolean().default(false),
});

export type Settings = {
  login: z.infer<typeof LoginSchema>;
  smtp: z.infer<typeof SmtpSchema>;
  bot: z.infer<typeof BotSchema>;
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
    login: LoginSchema.parse(stored.get("login") ?? {}),
    smtp: { ...smtp, password: smtp.password && decrypt(smtp.password) },
    bot: BotSchema.parse(stored.get("bot") ?? {}),
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
  if (change.login) rows.push({ key: "login", value: JSON.stringify(change.login) });
  if (change.bot) rows.push({ key: "bot", value: JSON.stringify(change.bot) });
  if (change.smtp) {
    const smtp = {
      ...change.smtp,
      password: change.smtp.password && encrypt(change.smtp.password),
    };
    rows.push({ key: "smtp", value: JSON.stringify(smtp) });
  }
  if (rows.length === 0) return;
  await trx
    .insertInto("settings")
    .values(rows)
    .onConflict((oc) => oc.column("key").doUpdateSet((eb) => ({ value: eb.ref("excluded.value") })))
    .execute();
  cache = null;
}
