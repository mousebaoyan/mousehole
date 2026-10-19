import { createRoute, z } from "@hono/zod-openapi";
import { reachOf } from "../../platform/access.ts";
import {
  actorOf,
  authorize,
  authorizePosting,
  createRouter,
  errorResponse,
  IdParam,
  IntParam,
  readerOf,
} from "../../platform/http.ts";
import { BoardBriefSchema, SuggestionSchema, suggestionJson } from "./schemas.ts";
import { decideSuggestion, listSuggestions, suggestChange } from "./suggestions.ts";

export const suggestionRoutes = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/suggestions",
      summary: "建议修改等级比自己低的人的帖子的标题、版块和标签；L3 起",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                title: z.string().trim().min(4).max(80).optional(),
                board: z.string().optional(),
                tags: z
                  .array(z.string())
                  .max(5)
                  .transform((t) => [...new Set(t)])
                  .optional(),
                reason: z.string().trim().max(100).optional(),
              }),
            },
          },
        },
      },
      responses: {
        204: { description: "已提交" },
        400: errorResponse("一项都没改，或者标签不存在"),
        403: errorResponse("等级不够，帖子已锁定（thread_locked），或者不能移到这个版块"),
        404: errorResponse("帖子或版块不存在"),
        409: errorResponse("对这个帖子已有待处理的建议（suggestion_exists）"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      await suggestChange(
        actorOf(c, viewer),
        viewer,
        reachOf(viewer, c.var.bot),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/suggestions/{id}",
      summary: "处理修改建议：accepted 照建议修改，rejected 不改；楼主和版主",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ status: z.enum(["accepted", "rejected"]) }),
            },
          },
        },
      },
      responses: {
        204: { description: "已处理" },
        403: errorResponse("不是楼主或版主，或者帖子已锁定"),
        404: errorResponse("修改建议或帖子不存在"),
        409: errorResponse("已经处理过了（suggestion_handled）"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      await decideSuggestion(
        actorOf(c, viewer),
        viewer,
        readerOf(c),
        c.req.valid("param").id,
        c.req.valid("json").status,
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/suggestions",
      summary: "待处理的修改建议，最新的在前；帖子删了的不列",
      request: { query: z.object({ cursor: IntParam.optional() }) },
      responses: {
        200: {
          description: "修改建议",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  SuggestionSchema.extend({
                    thread: z.object({
                      id: z.number(),
                      title: z.string(),
                      board: BoardBriefSchema,
                      tags: z.array(z.string()),
                    }),
                  }),
                ),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        403: errorResponse("不是版主"),
      },
    }),
    async (c) => {
      authorize(c, "moderate");
      const page = await listSuggestions(c.req.valid("query").cursor);
      return c.json(
        {
          items: page.items.map(({ thread, ...s }) => ({ ...suggestionJson(s), thread })),
          next_cursor: page.next_cursor,
        },
        200,
      );
    },
  );
