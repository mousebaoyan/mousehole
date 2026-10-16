import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import type { Actor } from "../../platform/access.ts";
import { db } from "../../platform/db.ts";
import { AppError } from "../../platform/errors.ts";
import { cropImage, type Region } from "../../platform/images.ts";
import { recordAudit } from "../audit/service.ts";
import { BACKGROUND_CROPS, BACKGROUNDS, reaches, UPLOAD_LEVEL } from "./customization.ts";

// Uploaded backgrounds (design §8.16): two files per person, which the next upload overwrites.
// The version in their addresses changes with each, so they can be cached for good.
export const BACKGROUNDS_DIR = "data/backgrounds";
const PLACES = ["card", "profile"] as const;

function file(userId: number, place: (typeof PLACES)[number]) {
  return `${BACKGROUNDS_DIR}/${userId}-${place}.webp`;
}

export function backgroundUrls(userId: number, version: number) {
  return {
    card_url: `/backgrounds/${userId}-card.webp?v=${version}`,
    profile_url: `/backgrounds/${userId}-profile.webp?v=${version}`,
  };
}

// What their card and page show behind them: a preset, moving once bought, their own picture, or
// nothing.
export function backgroundOf(
  userId: number,
  background: string | null,
  version: number,
  bought: boolean,
) {
  if (background === "custom") return backgroundUrls(userId, version);
  const preset = BACKGROUNDS.find((key) => key === background);
  return preset === undefined ? null : { preset, moving: bought };
}

export async function uploadBackground(
  actor: Actor,
  picture: Buffer,
  regions: Record<(typeof PLACES)[number], Region>,
) {
  const user = await db
    .selectFrom("users")
    .select([
      "level",
      "role",
      sql<boolean>`EXISTS (SELECT 1 FROM user_looks l WHERE l.user_id = users.id
        AND l.kind = 'background' AND l.key = 'custom')`.as("moving"),
    ])
    .where("id", "=", actor.userId)
    .executeTakeFirstOrThrow();
  if (!reaches(user, UPLOAD_LEVEL)) {
    throw new AppError(403, "cosmetic_locked", `L${UPLOAD_LEVEL} 起才能上传自己的背景`);
  }
  const { animated, files } = await cropImage(
    picture,
    PLACES.map((place) => ({
      region: regions[place],
      still: BACKGROUND_CROPS[place].still,
      moving: BACKGROUND_CROPS[place].moving,
    })),
    user.moving,
  );
  if (animated && PLACES.some((place, i) => files[i].length > BACKGROUND_CROPS[place].movingMax)) {
    throw new AppError(
      400,
      "background_too_large",
      "动图压缩后太大：资料卡的不能超过 500KB，主页的不能超过 1MB，请换一张小一点或短一点的",
    );
  }
  await mkdir(BACKGROUNDS_DIR, { recursive: true });
  // Written beside and renamed, so a file is either the old one or the new one, whole.
  for (const [i, place] of PLACES.entries()) {
    await writeFile(`${file(actor.userId, place)}.tmp`, files[i]);
    await rename(`${file(actor.userId, place)}.tmp`, file(actor.userId, place));
  }
  const version = await db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("users")
      .set((eb) => ({ background: "custom", background_version: eb("background_version", "+", 1) }))
      .where("id", "=", actor.userId)
      .returning("background_version")
      .executeTakeFirstOrThrow();
    await recordAudit(trx, actor, { action: "user.background", data: { animated } });
    return row.background_version;
  });
  return backgroundUrls(actor.userId, version);
}

// Once they no longer use their own picture.
export async function removeBackground(userId: number) {
  await Promise.all(PLACES.map((place) => rm(file(userId, place), { force: true })));
}
