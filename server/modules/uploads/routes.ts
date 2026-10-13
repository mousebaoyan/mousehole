import { readFile } from "node:fs/promises";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../../platform/errors.ts";
import { authorize, createRouter, errorResponse } from "../../platform/http.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import { fetchUpload, storeUpload, UPLOADS_DIR } from "./service.ts";

const UploadSchema = z
  .object({ id: z.number(), url: z.string(), width: z.number(), height: z.number() })
  .openapi("Upload");

export const uploadsRoutes = createRouter()
  .openapi(
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
          content: { "application/json": { schema: UploadSchema } },
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
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/uploads/fetch",
      summary: "转存 QQ 的图片：论坛去下载，只接受 QQ 的图片域名。消息段里的图片发帖时会自动转存",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ url: z.string().max(2000) }) } },
        },
      },
      responses: {
        201: { description: "同上传", content: { "application/json": { schema: UploadSchema } } },
        400: errorResponse("不是 QQ 的图片地址，或者不是图片"),
        502: errorResponse("下载失败，链接可能已经过期"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      rateLimit(`upload:${viewer.id}`, 30, 10 * 60_000);
      return c.json(await fetchUpload(viewer.id, c.req.valid("json").url), 201);
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
