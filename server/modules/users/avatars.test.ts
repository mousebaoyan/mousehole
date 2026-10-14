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

  test("上传的头像不再被 QQ 头像刷新覆盖；改回 QQ 头像时立刻拉一次", async () => {
    const user = await createUser();
    const me = as(await login(user.id));
    const png = await sharp({
      create: { width: 300, height: 200, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();

    const uploaded = await api.me.avatar.$put({ form: { file: new File([png], "我.png") } }, me);
    if (!uploaded.ok) throw new Error(`status ${uploaded.status}`);
    expect(await uploaded.json()).toEqual({ avatar_url: `/avatars/${user.id}.webp?v=1` });
    const file = await app.request(`/avatars/${user.id}.webp?v=1`);
    const { width, height } = await sharp(await file.arrayBuffer()).metadata();
    expect([width, height]).toEqual([96, 96]);

    await aDayLater(`${AVATARS_DIR}/${user.id}.webp`);
    qqAvatar("#e07b53");
    await refreshAvatars();
    const settings = await api.me.settings.$get({}, me);
    if (!settings.ok) throw new Error(`status ${settings.status}`);
    expect(await settings.json()).toMatchObject({ avatar_custom: true });
    const me1 = await api.me.$get({}, me);
    if (!me1.ok) throw new Error(`status ${me1.status}`);
    expect((await me1.json()).avatar_url).toBe(`/avatars/${user.id}.webp?v=1`);

    const restored = await api.me.avatar.$delete({}, me);
    if (!restored.ok) throw new Error(`status ${restored.status}`);
    expect(await restored.json()).toEqual({ avatar_url: `/avatars/${user.id}.webp?v=2` });
  });

  test("不是图片的文件上传不了", async () => {
    const me = as(await login((await createUser()).id));
    const res = await api.me.avatar.$put({ form: { file: new File(["不是图"], "a.png") } }, me);
    expect(res.status).toBe(400);
  });
});
