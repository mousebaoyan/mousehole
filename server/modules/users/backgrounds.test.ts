import { randomBytes } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import sharp from "sharp";
import { afterAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { BACKGROUNDS_DIR } from "./backgrounds.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

// IDs far from the ones a development database hands out, since the files share a directory.
await sql`ALTER TABLE users ALTER COLUMN id RESTART WITH 920000001`.execute(db);

afterAll(async () => {
  const users = await db.selectFrom("users").select("id").execute();
  await Promise.all(
    users.flatMap((u) =>
      ["card", "profile"].map((place) =>
        rm(`${BACKGROUNDS_DIR}/${u.id}-${place}.webp`, { force: true }),
      ),
    ),
  );
});

async function person(level: number, role: "user" | "moderator" = "user") {
  const { id } = await createUser(role, level);
  return { id, who: as(await login(id)) };
}

const picture = sharp({ create: { width: 1600, height: 1000, channels: 3, background: "#3a7bd5" } })
  .jpeg()
  .toBuffer();

function upload(who: Who, file: Buffer, card = "100,100,1200,600", profile = "0,200,1500,500") {
  return api.me.background.$put(
    { form: { file: new File([new Uint8Array(file)], "背景.jpg"), card, profile } },
    who,
  );
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function background(userId: number) {
  const res = await api.users[":user"].$get({ param: { user: String(userId) } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const user = await res.json();
  if (user.members_only) throw new Error("members only");
  return user.background;
}

describe("背景", () => {
  test("预设按等级解锁，版主不受限；降级后留着原来的，换掉就选不回来", async () => {
    const member = await person(1);
    const pick = (key: "mist" | "waves" | "stars" | null, who = member.who) =>
      api.me.$patch({ json: { background: key } }, who);
    expect((await pick("waves")).status).toBe(200);
    const locked = await pick("stars");
    expect(locked.status).toBe(403);
    expect(await locked.json()).toMatchObject({ error: { code: "cosmetic_locked" } });
    expect(await background(member.id)).toEqual({ preset: "waves", moving: false });

    await db.updateTable("users").set({ level: 0 }).where("id", "=", member.id).execute();
    expect((await pick("waves")).status).toBe(200);
    expect((await pick("mist")).status).toBe(200);
    expect((await pick("waves")).status).toBe(403);

    const moderator = await person(0, "moderator");
    expect((await pick("stars", moderator.who)).status).toBe(200);
  });

  test("L3 起上传，资料卡和主页各裁一张；换成预设后文件删掉", async () => {
    expect((await upload((await person(2)).who, await picture)).status).toBe(403);

    const member = await person(3);
    const res = await upload(member.who, await picture);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const urls = await res.json();
    expect(urls).toEqual({
      card_url: `/backgrounds/${member.id}-card.webp?v=1`,
      profile_url: `/backgrounds/${member.id}-profile.webp?v=1`,
    });
    expect(await background(member.id)).toEqual(urls);
    const card = `${BACKGROUNDS_DIR}/${member.id}-card.webp`;
    const profile = `${BACKGROUNDS_DIR}/${member.id}-profile.webp`;
    expect(await sharp(card).metadata()).toMatchObject({ width: 576, height: 288 });
    expect(await sharp(profile).metadata()).toMatchObject({ width: 1200, height: 400 });
    const served = await app.request(urls.card_url);
    expect(served.headers.get("cache-control")).toContain("immutable");
    const elsewhere = await app.request(urls.card_url, {
      headers: { referer: "https://example.com/" },
    });
    expect(elsewhere.status).toBe(403);

    await api.me.$patch({ json: { background: "mist" } }, member.who);
    expect(await exists(card)).toBe(false);
    expect(await exists(profile)).toBe(false);
  });

  test("裁的区域超出图片不收；没兑换动态版的动图只留第一帧，兑换后压缩了还太大的不收", async () => {
    const member = await person(3);
    const outside = await upload(member.who, await picture, "500,500,1200,600");
    expect(outside.status).toBe(400);
    expect(await outside.json()).toMatchObject({ error: { code: "invalid_crop" } });

    // Noise compresses badly: every frame is new. The card's comes to about 780KB.
    const frames = await Promise.all(
      Array.from({ length: 16 }, () =>
        sharp(randomBytes(432 * 216 * 3), { raw: { width: 432, height: 216, channels: 3 } })
          .png()
          .toBuffer(),
      ),
    );
    const noise = await sharp(frames, { join: { animated: true } })
      .gif({ effort: 1, dither: 0 })
      .toBuffer();
    const still = await upload(member.who, noise, "0,0,432,216", "0,0,432,144");
    if (!still.ok) throw new Error(`status ${still.status}`);
    const urls = await still.json();
    const pages = await sharp(`${BACKGROUNDS_DIR}/${member.id}-card.webp`).metadata();
    expect(pages.pages ?? 1).toBe(1);

    await db
      .updateTable("coin_balances")
      .set({ coins: 200 })
      .where("user_id", "=", member.id)
      .execute();
    const bought = await api.me.looks.$post(
      { json: { kind: "background", key: "custom" } },
      member.who,
    );
    expect(bought.status).toBe(200);
    const heavy = await upload(member.who, noise, "0,0,432,216", "0,0,432,144");
    expect(heavy.status).toBe(400);
    expect(await heavy.json()).toMatchObject({ error: { code: "background_too_large" } });
    expect(await background(member.id)).toEqual(urls);
  });

  test("版主清除上传的背景，文件一起删掉", async () => {
    const member = await person(3);
    await upload(member.who, await picture);
    const moderator = await person(1, "moderator");
    const res = await api.users[":user"].customization[":item"].$delete(
      { param: { user: String(member.id), item: "background" }, json: { reason: "不合适" } },
      moderator.who,
    );
    expect(res.status).toBe(204);
    expect(await background(member.id)).toBeNull();
    expect(await exists(`${BACKGROUNDS_DIR}/${member.id}-card.webp`)).toBe(false);
  });
});
