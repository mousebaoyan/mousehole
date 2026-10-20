import { createRoute, z } from "@hono/zod-openapi";
import {
  actorOf,
  authorize,
  authorizePosting,
  can,
  createRouter,
  errorResponse,
  IdParam,
  Int,
  IntParam,
  readerOf,
  UnixSecondsParam,
} from "../../platform/http.ts";
import { UserBriefSchema } from "../users/schemas.ts";
import { closePoll, getPoll, listNewPolls, listVoters, vote } from "./polls.ts";
import { pollJson, PollSchema } from "./schemas.ts";
import { getThread } from "./service.ts";

const pollResponse = {
  description: "投票",
  content: { "application/json": { schema: PollSchema } },
};

export const pollRoutes = createRouter()
  .openapi(
    createRoute({
      method: "put",
      path: "/threads/{id}/poll/vote",
      summary: "投票、改票；options 为空是撤票",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ options: z.array(Int).max(20) }),
            },
          },
        },
      },
      responses: {
        200: pollResponse,
        400: errorResponse("单选选了几项、超过最多可选的项数，或者选项不在这个投票里"),
        403: errorResponse("不是成员、被禁言、投票已结束（poll_closed）或帖子已锁定"),
        404: errorResponse("帖子不存在，或者不是投票帖"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      const thread = await getThread(c.req.valid("param").id, readerOf(c));
      await vote(actorOf(c, viewer), thread, c.req.valid("json").options);
      return c.json(pollJson(await getPoll(thread.id, viewer.id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/poll/close",
      summary: "提前结束投票；楼主和版主",
      request: { params: IdParam },
      responses: {
        200: pollResponse,
        403: errorResponse("不是楼主或版主"),
        404: errorResponse("帖子不存在，或者不是投票帖"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const thread = await getThread(c.req.valid("param").id, readerOf(c));
      await closePoll(actorOf(c, viewer), can(c, "moderate"), thread);
      return c.json(pollJson(await getPoll(thread.id, viewer.id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/{id}/poll/options/{option}/voters",
      summary: "投了某个选项的人，先投的在前；实名投票、自己看得到结果时才能看",
      request: {
        params: IdParam.extend({ option: IntParam }),
      },
      responses: {
        200: {
          description: "投了这一项的人",
          content: {
            "application/json": { schema: z.object({ items: z.array(UserBriefSchema) }) },
          },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("匿名投票，或者还看不到结果"),
        404: errorResponse("帖子或选项不存在，或者不是投票帖"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      const { id, option } = c.req.valid("param");
      const thread = await getThread(id, readerOf(c));
      return c.json({ items: await listVoters(thread.poll, option) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/bot/polls",
      summary: "[since, until) 里发的、还能投的投票帖，给插件每天在群里汇总",
      request: {
        query: z.object({
          since: UnixSecondsParam.openapi({ description: "Unix 秒" }),
          until: UnixSecondsParam.optional().openapi({ description: "Unix 秒，默认现在" }),
        }),
      },
      responses: {
        200: {
          description: "投票帖，先发的在前",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    thread: z.object({ id: z.number(), title: z.string() }),
                    voters: z.number().openapi({ description: "到现在投了票的人数" }),
                    url: z.string(),
                  }),
                ),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      authorize(c, "read");
      const { since, until } = c.req.valid("query");
      const items = await listNewPolls(
        new Date(since * 1000),
        until === undefined ? new Date() : new Date(until * 1000),
      );
      return c.json({ items }, 200);
    },
  );
