import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, unix, UnixSecondsParam } from "../../platform/http.ts";
import { BOUNTY_ANSWER, BOUNTY_REPLY } from "../coins/rules.ts";
import { listBounties } from "./bounties.ts";

export const bountyRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/bot/bounties",
    summary: "[since, until) 里开始悬赏、到现在还没有别人回复的问题，给插件每天在群里发",
    request: {
      query: z.object({
        since: UnixSecondsParam.openapi({ description: "Unix 秒" }),
        until: UnixSecondsParam.optional().openapi({ description: "Unix 秒，默认现在" }),
      }),
    },
    responses: {
      200: {
        description: "悬赏的问题和奖励",
        content: {
          "application/json": {
            schema: z.object({
              items: z.array(
                z.object({
                  thread: z.object({ id: z.number(), title: z.string(), kind: z.string() }),
                  board: z.object({ slug: z.string(), name: z.string() }),
                  url: z.string(),
                  until: z.number().openapi({ description: "悬赏的截止时间" }),
                }),
              ),
              reward: z.object({
                reply: z.number().openapi({ description: "回复得的鼠币" }),
                answer: z.number().openapi({ description: "回复被采纳再得的鼠币" }),
              }),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    authorize(c, "read");
    const { since, until } = c.req.valid("query");
    const items = await listBounties(
      new Date(since * 1000),
      until === undefined ? new Date() : new Date(until * 1000),
    );
    return c.json(
      {
        items: items.map((i) => ({ ...i, until: unix(i.until) })),
        reward: { reply: BOUNTY_REPLY, answer: BOUNTY_ANSWER },
      },
      200,
    );
  },
);
