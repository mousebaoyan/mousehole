import { rm, stat, utimes } from "node:fs/promises";
import { testClient } from "hono/testing";
import { sql } from "kysely";
import sharp from "sharp";
import { afterAll, describe, expect, test, vi } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { AVATARS_DIR, refreshAvatars } from "./service.ts";

const api = testClient(app).api.v1;

// IDs far from the ones a development database hands out, since the files share a directory.
await sql`ALTER TABLE users ALTER COLUMN id RESTART WITH 900000001`.execute(db);

afterAll(async () => {
  const users = await db.selectFrom("users").select("id").execute();
  await Promise.all(users.map((u) => rm(`${AVATARS_DIR}/${u.id}.webp`, { force: true })));
});

function qqAvatar(color: string) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: color } })
      .png()
      .toBuffer();
    return new Response(new Uint8Array(png));
  });
}

async function aDayLater(path: string) {
  const old = new Date(Date.now() - 86_400_000);
  await utimes(path, old, old);
}

describe("头像", () => {
  test("QQ 头像存成 96px 的 WebP，地址带版本号；隔天再拉，没变不换版本，变了才换", async () => {
    const user = await createUser();
    const me = as(await login(user.id));
    const avatarUrl = async () => {
      const res = await api.me.$get({}, me);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return (await res.json()).avatar_url;
    };
    expect(await avatarUrl()).toBeNull();

    qqAvatar("#e07b53");
    await refreshAvatars();
    expect(await avatarUrl()).toBe(`/avatars/${user.id}.webp?v=1`);
    const res = await app.request(`/avatars/${user.id}.webp?v=1`);
    expect(res.headers.get("cache-control")).toContain("immutable");
    const { format, width, height } = await sharp(await res.arrayBuffer()).metadata();
    expect([format, width, height]).toEqual(["webp", 96, 96]);

    const path = `${AVATARS_DIR}/${user.id}.webp`;
    await aDayLater(path);
    await refreshAvatars();
    expect(await avatarUrl()).toBe(`/avatars/${user.id}.webp?v=1`);
    expect(Date.now() - (await stat(path)).mtimeMs).toBeLessThan(60_000);

    await aDayLater(path);
    qqAvatar("#5a7fa6");
    await refreshAvatars();
    expect(await avatarUrl()).toBe(`/avatars/${user.id}.webp?v=2`);
  });
});
