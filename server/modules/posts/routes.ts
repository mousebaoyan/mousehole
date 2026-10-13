import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, errorResponse } from "../../platform/http.ts";
import { renderMarkdown } from "../../platform/markdown.ts";
import { rateLimit } from "../../platform/rate-limit.ts";

// Longest Markdown a post may have.
export const MAX_BODY = 30_000;

export const postsRoutes = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/preview",
    summary: "预览：把 Markdown 渲染成发布后的 HTML，编辑器边写边看",
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: z.object({ markdown: z.string().max(MAX_BODY) }) },
        },
      },
    },
    responses: {
      200: {
        description: "渲染结果",
        content: { "application/json": { schema: z.object({ html: z.string() }) } },
      },
      403: errorResponse("不是成员"),
      429: errorResponse("预览太频繁"),
    },
  }),
  async (c) => {
    const viewer = authorize(c, "act");
    rateLimit(`preview:${viewer.id}`, 120, 60_000);
    const { html } = await renderMarkdown(c.req.valid("json").markdown);
    return c.json({ html }, 200);
  },
);
