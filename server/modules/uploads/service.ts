import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { sql, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { readCapped } from "../../platform/body.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { processImage } from "../../platform/images.ts";
import type { ShownImage } from "../../platform/markdown.ts";

// Files live under data/uploads/{first two hex digits}/{SHA-256 of the original}.webp, with a
// -960.webp beside it for still images. The name never changes, so they can be cached for good.
export const UPLOADS_DIR = "data/uploads";

const DISPLAY_WIDTH = 960;

const NAME = /^\/uploads\/[0-9a-f]{2}\/([0-9a-f]{64})\.webp$/;

type Size = "large" | "display";

function fileName(hex: string, size: Size) {
  return `${hex.slice(0, 2)}/${hex}${size === "display" ? "-960" : ""}.webp`;
}

export function uploadUrl(hex: string, size: Size = "large") {
  return `/uploads/${fileName(hex, size)}`;
}

// The uploaded image an address in a post points at, if it is one.
export function uploadName(src: string) {
  return NAME.exec(src)?.[1] ?? null;
}

// Written beside and then renamed, so a file is either missing or complete.
async function save(path: string, data: Buffer) {
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}

// The same picture uploaded again is the same file: it is found by the hash of what was sent.
export async function storeUpload(userId: number, file: Buffer) {
  const sha256 = createHash("sha256").update(file).digest();
  const hex = sha256.toString("hex");
  const existing = await db
    .selectFrom("uploads")
    .select(["id", "width", "height"])
    .where("sha256", "=", sha256)
    .executeTakeFirst();
  if (existing) return { ...existing, url: uploadUrl(hex) };

  const image = await processImage(file);
  await mkdir(`${UPLOADS_DIR}/${hex.slice(0, 2)}`, { recursive: true });
  await save(`${UPLOADS_DIR}/${fileName(hex, "large")}`, image.large);
  if (image.display) await save(`${UPLOADS_DIR}/${fileName(hex, "display")}`, image.display);
  // Two people uploading the same picture at once both get the one row.
  await db
    .insertInto("uploads")
    .values({
      sha256,
      user_id: userId,
      mime: "image/webp",
      width: image.width,
      height: image.height,
      animated: image.animated,
      bytes: image.large.length + (image.display?.length ?? 0),
    })
    .onConflict((oc) => oc.column("sha256").doNothing())
    .execute();
  const row = await db
    .selectFrom("uploads")
    .select(["id", "width", "height"])
    .where("sha256", "=", sha256)
    .executeTakeFirstOrThrow();
  return { ...row, url: uploadUrl(hex) };
}

export const MAX_UPLOAD = 20 * 1024 * 1024;

// Where pictures sent in QQ chats and stickers are served from. Their links expire within hours,
// which is why they are copied here as soon as a bot passes them on.
const QQ_IMAGE_HOSTS = new Set(["multimedia.nt.qq.com.cn", "gchat.qpic.cn", "gxh.vip.qq.com"]);

function fetchFailed(cause?: unknown) {
  return new AppError(502, "fetch_failed", "图片下载失败，链接可能已过期", { cause });
}

// Only QQ's image hosts, no redirects elsewhere, a time limit and a size limit: the address comes
// from outside, and must not make this server fetch anything else.
export async function fetchUpload(userId: number, url: string) {
  const target = URL.parse(url);
  if (
    !target ||
    (target.protocol !== "https:" && target.protocol !== "http:") ||
    !QQ_IMAGE_HOSTS.has(target.hostname)
  ) {
    throw new AppError(400, "invalid_request", "url：只能转存 QQ 的图片");
  }
  const res = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(15_000) }).catch(
    (error: unknown) => {
      throw fetchFailed(error);
    },
  );
  if (!res.ok || !res.body) throw fetchFailed();
  const data = await readCapped(res.body, MAX_UPLOAD, () => {
    throw new AppError(413, "payload_too_large", "图片超过 20MB");
  });
  return storeUpload(userId, data);
}

// How the uploaded images among these addresses appear in a post: still images load their 960px
// copy and open the large one; animated ones only have the large one. Other addresses are left
// out.
export async function showImages(srcs: string[]) {
  const named = srcs.flatMap((src) => {
    const hex = uploadName(src);
    return hex === null ? [] : [{ src, hex }];
  });
  const rows =
    named.length === 0
      ? []
      : await db
          .selectFrom("uploads")
          .select([sql<string>`encode(sha256, 'hex')`.as("hex"), "width", "height", "animated"])
          .where(
            "sha256",
            "in",
            named.map((n) => Buffer.from(n.hex, "hex")),
          )
          .execute();
  const shown = new Map<string, ShownImage>();
  for (const { src, hex } of named) {
    const size = rows.find((r) => r.hex === hex);
    if (!size) continue;
    const scale = size.animated ? 1 : Math.min(1, DISPLAY_WIDTH / size.width);
    shown.set(src, {
      src: uploadUrl(hex, size.animated ? "large" : "display"),
      href: uploadUrl(hex),
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
    });
  }
  return shown;
}

// Which uploads a post shows, by their addresses, so the unused ones can be cleared away.
export async function linkUploads(trx: Transaction<DB>, postId: number, srcs: string[]) {
  await trx.deleteFrom("post_uploads").where("post_id", "=", postId).execute();
  const hexes = srcs.flatMap((src) => uploadName(src) ?? []);
  if (hexes.length === 0) return;
  await sql`
    INSERT INTO post_uploads (post_id, upload_id)
    SELECT ${postId}, id FROM uploads WHERE sha256 = ANY(${hexes.map((h) => Buffer.from(h, "hex"))})
    ON CONFLICT DO NOTHING`.execute(trx);
}

// Uploads no post has used within a day of being uploaded go, files and all.
// Both sizes of every stored image, for the admin overview.
export async function uploadBytes() {
  const { bytes } = await db
    .selectFrom("uploads")
    .select(sql<number>`coalesce(sum(bytes), 0)::bigint`.as("bytes"))
    .executeTakeFirstOrThrow();
  return bytes;
}

export async function clearUnusedUploads() {
  const gone = await db
    .deleteFrom("uploads")
    .where("created_at", "<", sql<Date>`now() - interval '1 day'`)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("post_uploads").whereRef("post_uploads.upload_id", "=", "uploads.id"),
        ),
      ),
    )
    .returning(sql<string>`encode(sha256, 'hex')`.as("hex"))
    .execute();
  for (const { hex } of gone) {
    for (const size of ["large", "display"] as const) {
      await rm(`${UPLOADS_DIR}/${fileName(hex, size)}`, { force: true });
    }
  }
}
