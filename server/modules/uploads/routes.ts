import { readFile } from "node:fs/promises";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../../platform/errors.ts";
import { authorize, createRouter, errorResponse } from "../../platform/http.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import { storeUpload, UPLOADS_DIR } from "./service.ts";

export const uploadsRoutes = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/uploads",
    summary: "上传图片：multipart 的 file 字段，最大 20MB；同一张图再传，得到的还是同一个地址",
    request: {
      body: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: "url 是大图的地址，写进正文时用它；页面上显示的是 960px 宽的一档",
        content: {
          "application/json": {
            schema: z.object({
              id: z.number(),
              url: z.string(),
              width: z.number(),
              height: z.number(),
            }),
          },
        },
      },
      400: errorResponse("不是能识别的图片"),
      413: errorResponse("超过 20MB"),
      429: errorResponse("上传太频繁"),
    },
  }),
  async (c) => {
    const viewer = authorize(c, "act");
    rateLimit(`upload:${viewer.id}`, 30, 10 * 60_000);
    const { file } = c.req.valid("form");
    return c.json(await storeUpload(viewer.id, Buffer.from(await file.arrayBuffer())), 201);
  },
);

// The files themselves. Their names come from their content, so they never change and can be
// cached for a year. The route's pattern admits only such names.
export async function serveUpload(c: Context) {
  const path = `${UPLOADS_DIR}/${c.req.param("dir")}/${c.req.param("file")}`;
  const file = await readFile(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AppError(404, "not_found", "图片不存在");
    }
    throw error;
  });
  return c.body(file, 200, {
    "content-type": "image/webp",
    "cache-control": "public, max-age=31536000, immutable",
  });
}
