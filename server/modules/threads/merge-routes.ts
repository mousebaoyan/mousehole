import { createRoute, z } from "@hono/zod-openapi";
import { actorOf, authorize, createRouter, errorResponse, readerOf } from "../../platform/http.ts";
import { mergeThread, renumberThread } from "./merges.ts";

const IdParam = z.object({ id: z.coerce.number().int() });
export const mergeRoutes = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/merge",
      summary: "把这个帖子合并到另一个帖子，楼层按发的时间重排；版主",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                into: z.number().int(),
                title: z.string().trim().min(4).max(80).optional(),
                board: z.string().optional(),
                tags: z
                  .array(z.string())
                  .transform((t) => [...new Set(t)])
                  .optional(),
                kind: z.enum(["discussion", "question"]).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "留下的帖子，和被合并的帖子的主楼现在的楼层号",
          content: {
            "application/json": {
              schema: z.object({ thread_id: z.number(), floor: z.number() }),
            },
          },
        },
        400: errorResponse("有一个帖子不能合并，是同一个帖子，或者标签超过 5 个、不存在"),
        403: errorResponse("不是版主"),
        404: errorResponse("帖子或版块不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      const merged = await mergeThread(
        actorOf(c, viewer),
        viewer,
        readerOf(c),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(merged, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/renumber",
      summary: "按发的时间重排楼层号，主楼还是 1 楼；版主",
      request: { params: IdParam },
      responses: {
        200: {
          description: "换了号的层数",
          content: { "application/json": { schema: z.object({ moved: z.number() }) } },
        },
        403: errorResponse("不是版主"),
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      const moved = await renumberThread(actorOf(c, viewer), readerOf(c), c.req.valid("param").id);
      return c.json({ moved }, 200);
    },
  );
