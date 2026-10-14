import { existsSync } from "node:fs";
import { testClient } from "hono/testing";
import sharp from "sharp";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { clearUnusedUploads, UPLOADS_DIR } from "./service.ts";

const api = testClient(app).api.v1;

let member = as("");

beforeAll(async () => {
  member = as(await login((await createUser()).id));
});

function picture(width: number, height: number, background: string) {
  return sharp({ create: { width, height, channels: 4, background } });
}

// Frames stacked in raw pixels, each a different color so the encoder keeps them all.
function animation(width: number, height: number, frames: number) {
  const pixels = Buffer.alloc(width * height * frames * 4);
  for (let i = 0; i < width * height * frames; i++) {
    pixels.set([Math.floor(i / (width * height)) * 80, 120, 200, 255], i * 4);
  }
  return sharp(pixels, {
    raw: { width, height: height * frames, channels: 4, pageHeight: height },
  });
}

async function upload(data: Buffer, name = "图.png") {
  const res = await api.uploads.$post(
    { form: { file: new File([new Uint8Array(data)], name) } },
    member,
  );
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return res.json();
}

function file(url: string) {
  return `${UPLOADS_DIR}/${url.slice("/uploads/".length)}`;
}

describe("上传图片", () => {
  test("转成 WebP：大图长边不超过 2048，另有 960 宽的一档；同一张图再传还是同一个", async () => {
    const png = await picture(3000, 1500, "#e07b53").png().toBuffer();
    const first = await upload(png);
    expect(first).toMatchObject({ width: 2048, height: 1024 });
    expect(first.url).toMatch(/^\/uploads\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/);

    const large = await sharp(file(first.url)).metadata();
    const display = await sharp(file(first.url.replace(".webp", "-960.webp"))).metadata();
    expect([large.format, large.width, display.width, display.height]).toEqual([
      "webp",
      2048,
      960,
      480,
    ]);
    expect((await upload(png)).id).toBe(first.id);
  });

  test("别的网站的页面不能引用图片；本站页面和直接打开都可以", async () => {
    const { url } = await upload(await picture(200, 100, "#3f8f7a").png().toBuffer());
    const from = (referer?: string) =>
      app.request(url, { headers: referer === undefined ? {} : { referer } });
    expect((await from()).status).toBe(200);
    expect((await from(`${env.PUBLIC_URL}/t/1`)).status).toBe(200);
    expect((await from("https://example.com/page")).status).toBe(403);
  });

  test("动图保留每一帧，只存大图", async () => {
    const gif = await animation(120, 80, 3).gif().toBuffer();
    const { url, width, height } = await upload(gif, "动图.gif");
    expect([width, height]).toEqual([120, 80]);
    expect((await sharp(file(url)).metadata()).pages).toBe(3);
    expect(existsSync(file(url.replace(".webp", "-960.webp")))).toBe(false);
  });

  test("不是图片的文件被拒绝", async () => {
    const res = await api.uploads.$post(
      { form: { file: new File(["<svg></svg>"], "图.svg") } },
      member,
    );
    expect(await res.json()).toMatchObject({ error: { code: "invalid_image" } });
  });

  test("帖子里显示上传的图片并写明大小；一天内没被用上的图片被清理掉", async () => {
    const used = await upload(await picture(1200, 600, "#5a7fa6").jpeg().toBuffer());
    const unused = await upload(await picture(400, 400, "#ad7a9f").jpeg().toBuffer());
    const admin = as(await login((await createUser("admin")).id));
    await api.boards.$post({ json: { slug: "pics", name: "图片" } }, admin);
    const thread = await api.threads.$post(
      { json: { board: "pics", title: "带图的帖子", content: { markdown: `![图](${used.url})` } } },
      member,
    );
    if (!thread.ok) throw new Error(`status ${thread.status}`);
    const posts = await api.threads[":id"].posts.$get({
      param: { id: String((await thread.json()).id) },
      query: {},
    });
    if (!posts.ok) throw new Error(`status ${posts.status}`);
    expect((await posts.json()).items[0].html).toContain(
      `<img src="${used.url.replace(".webp", "-960.webp")}" alt="图" width="960" height="480"`,
    );

    await db
      .updateTable("uploads")
      .set({ created_at: new Date(Date.now() - 2 * 86_400_000) })
      .where("id", "in", [used.id, unused.id])
      .execute();
    await clearUnusedUploads();
    const left = await db
      .selectFrom("uploads")
      .select("id")
      .where("id", "in", [used.id, unused.id])
      .execute();
    expect(left).toEqual([{ id: used.id }]);
    expect(existsSync(file(unused.url))).toBe(false);
    expect(existsSync(file(used.url))).toBe(true);
  });
});
