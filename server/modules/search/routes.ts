import { createRoute, z } from "@hono/zod-openapi";
import { isMember } from "../../platform/access.ts";
import { createRouter, errorResponse } from "../../platform/http.ts";
import { getBoard, getTagId } from "../boards/service.ts";
import { threadJson, ThreadSchema } from "../threads/schemas.ts";
import { threadsByIds } from "../threads/service.ts";
import { UserRefSchema } from "../users/schemas.ts";
import { findUserId } from "../users/service.ts";
import { search, similar, SORTS } from "./service.ts";

export const searchRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/search",
      summary: "搜索帖子和回复：每个帖子一条，带最相关的那一层和命中的片段；每页 20 个",
      request: {
        query: z.object({
          q: z.string().trim().min(1).max(100),
          board: z.string().optional(),
          tag: z.string().optional(),
          author: UserRefSchema.optional().openapi({ description: "楼主" }),
          kind: z.enum(["discussion", "question"]).optional(),
          solved: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => (v === undefined ? undefined : v === "true"))
            .openapi({ description: "true：已解决；false：还在等回答的问答帖" }),
          since: z
            .enum(["week", "month", "year"])
            .optional()
            .openapi({ description: "一周、一个月、一年内发的帖子" }),
          title_only: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
          sort: z.enum(SORTS).default("relevance").openapi({
            description:
              "relevance 相关度，旧的逐渐靠后；created 最新发布；last_post 最新回复；replies 回复最多；likes 点赞最多",
          }),
          cursor: z.coerce.number().int().min(0).default(0),
        }),
      },
      responses: {
        200: {
          description: "结果",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    thread: ThreadSchema,
                    post: z.object({ id: z.number(), floor: z.number() }),
                    snippet: z.string().openapi({ description: "命中处前后的纯文本" }),
                  }),
                ),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        404: errorResponse("版块、标签或用户不存在"),
      },
    }),
    async (c) => {
      const { q, board, tag, author, title_only, cursor, ...rest } = c.req.valid("query");
      const { viewer, bot } = c.var;
      const members = isMember(viewer, bot);
      const filter = {
        ...rest,
        titleOnly: title_only,
        boardId: board === undefined ? undefined : (await getBoard(board, members)).id,
        tagId: tag === undefined ? undefined : await getTagId(tag),
        authorId: author === undefined ? undefined : await findUserId(author),
      };
      const { hits, next_cursor } = await search(members, q, filter, cursor);
      const threads = await threadsByIds(
        members,
        viewer?.id ?? null,
        hits.map((h) => h.thread_id),
      );
      const items = hits.flatMap((h) => {
        const thread = threads.get(h.thread_id);
        return thread
          ? [
              {
                thread: threadJson(thread, viewer !== null),
                post: { id: h.post_id, floor: h.floor },
                snippet: h.snippet,
              },
            ]
          : [];
      });
      return c.json({ items, next_cursor }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/search/similar",
      summary: "相似问题：用提问原文找最像的 5 个帖子，score 在 0 到 1 之间",
      request: { query: z.object({ text: z.string().trim().min(1).max(2000) }) },
      responses: {
        200: {
          description: "最像的在前",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(z.object({ thread: ThreadSchema, score: z.number() })),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { viewer, bot } = c.var;
      const members = isMember(viewer, bot);
      const found = await similar(members, c.req.valid("query").text);
      const threads = await threadsByIds(
        members,
        viewer?.id ?? null,
        found.map((f) => f.thread_id),
      );
      const items = found.flatMap((f) => {
        const thread = threads.get(f.thread_id);
        return thread ? [{ thread: threadJson(thread, viewer !== null), score: f.score }] : [];
      });
      return c.json({ items }, 200);
    },
  );
