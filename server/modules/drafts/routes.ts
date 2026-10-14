import { createRoute, z } from "@hono/zod-openapi";
import { createRouter, errorResponse, requireWeb, unix } from "../../platform/http.ts";
import { MAX_BODY } from "../threads/service.ts";
import { deleteDraft, getDraft, listDrafts, saveDraft } from "./service.ts";

// `new` for the new thread, or the ID of the thread a reply is for.
const KeyParam = z.object({
  key: z
    .string()
    .regex(/^(new|\d+)$/, "应为 new 或帖子 ID")
    .transform((k) => (k === "new" ? null : Number(k))),
});

const DraftPollSchema = z
  .object({
    options: z.array(z.string().max(50)).max(20),
    multiple: z.boolean(),
    max_choices: z.number().int().nullable(),
    anonymous: z.boolean(),
    results: z.enum(["voted", "always"]),
    days: z.number().int().min(1).max(30).nullable().openapi({ description: "选的是几天后截止" }),
    closes_at: z.number().int().nullable().openapi({ description: "自定义的截止时间" }),
  })
  .openapi("DraftPoll", {
    description:
      "写了一半的投票，选项可以是空的；截止时间是 days 或 closes_at，其余字段同发帖的 poll",
  });

const DraftSchema = z
  .object({
    thread_id: z.number().nullable().openapi({ description: "回复哪个帖子；null 是发帖" }),
    title: z.string(),
    board: z.string().nullable(),
    kind: z.string().nullable(),
    poll: DraftPollSchema.nullable(),
    tags: z.array(z.string()),
    author_anonymous: z.boolean(),
    anonymous_replies: z.boolean(),
    body: z.string().openapi({ description: "Markdown" }),
    reply_to: z
      .object({ id: z.number(), floor: z.number(), name: z.string() })
      .nullable()
      .openapi({ description: "回复的是哪一层" }),
    updated_at: z.number(),
  })
  .openapi("Draft");

const notFound = errorResponse("没有这份草稿");
const signedOut = errorResponse("没有登录；bot 返回 403");

export const draftsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/me/drafts",
      summary: "自己的草稿，最近改过的在前；只能在网页上",
      responses: {
        200: {
          description: "草稿",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    thread: z.object({ id: z.number(), title: z.string() }).nullable(),
                    title: z.string(),
                    excerpt: z.string().openapi({ description: "正文的前 100 个字" }),
                    updated_at: z.number(),
                  }),
                ),
              }),
            },
          },
        },
        401: signedOut,
      },
    }),
    async (c) => {
      const items = await listDrafts(requireWeb(c).id);
      return c.json({ items: items.map((d) => ({ ...d, updated_at: unix(d.updated_at) })) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me/drafts/{key}",
      summary: "一份草稿：key 为 new 是发帖的，为帖子 ID 是回复这个帖子的",
      request: { params: KeyParam },
      responses: {
        200: { description: "草稿", content: { "application/json": { schema: DraftSchema } } },
        401: signedOut,
        404: notFound,
      },
    }),
    async (c) => {
      const draft = await getDraft(requireWeb(c).id, c.req.valid("param").key);
      return c.json({ ...draft, updated_at: unix(draft.updated_at) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/me/drafts/{key}",
      summary:
        "保存草稿，整份替换。编辑器停止输入 2 秒后调用，离开页面时用 keepalive 补发；发出去后由论坛删除",
      request: {
        params: KeyParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                body: z.string().max(MAX_BODY),
                title: z.string().max(80).optional(),
                board: z.string().nullable().optional(),
                kind: z.enum(["discussion", "question", "poll"]).nullable().optional(),
                poll: DraftPollSchema.nullable().optional(),
                tags: z.array(z.string().max(20)).max(5).optional(),
                author_anonymous: z.boolean().optional(),
                anonymous_replies: z.boolean().optional(),
                reply_to_id: z.number().int().nullable().optional(),
              }),
            },
          },
        },
      },
      responses: {
        204: { description: "已保存" },
        401: signedOut,
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      await saveDraft(requireWeb(c).id, c.req.valid("param").key, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/me/drafts/{key}",
      summary: "放弃草稿",
      request: { params: KeyParam },
      responses: { 204: { description: "已删除" }, 401: signedOut, 404: notFound },
    }),
    async (c) => {
      await deleteDraft(requireWeb(c).id, c.req.valid("param").key);
      return c.body(null, 204);
    },
  );
