import { createRoute, z } from "@hono/zod-openapi";
import {
  actorOf,
  authorize,
  authorizePosting,
  can,
  createRouter,
  errorResponse,
  IdParam,
  readerOf,
} from "../../platform/http.ts";
import { UserBriefSchema } from "../users/schemas.ts";
import { cancelLottery, enter, getLottery, leave, listEntries } from "./lotteries.ts";
import { lotteryJson, LotterySchema } from "./schemas.ts";
import { getThread } from "./service.ts";

const lotteryResponse = {
  description: "抽奖",
  content: { "application/json": { schema: LotterySchema } },
};

const notFound = errorResponse("帖子不存在，或者不是抽奖帖");

export const lotteryRoutes = createRouter()
  .openapi(
    createRoute({
      method: "put",
      path: "/threads/{id}/lottery/entry",
      summary: "参与抽奖；已经参与的不变。只用于点按钮参与的抽奖",
      request: { params: IdParam },
      responses: {
        200: lotteryResponse,
        403: errorResponse(
          "不是成员、被禁言、是楼主、等级不够（level_required）、已开奖或已取消（lottery_closed）、帖子已锁定或不公开，或者是回复参与的抽奖",
        ),
        404: notFound,
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      const thread = await getThread(c.req.valid("param").id, readerOf(c));
      await enter(actorOf(c, viewer), viewer, thread);
      return c.json(lotteryJson(await getLottery(thread.id, viewer.id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/threads/{id}/lottery/entry",
      summary: "退出抽奖；没参与的不变",
      request: { params: IdParam },
      responses: {
        200: lotteryResponse,
        403: errorResponse("已开奖或已取消（lottery_closed），或者是回复参与的抽奖"),
        404: notFound,
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const thread = await getThread(c.req.valid("param").id, readerOf(c));
      await leave(actorOf(c, viewer), viewer, thread);
      return c.json(lotteryJson(await getLottery(thread.id, viewer.id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/lottery/cancel",
      summary: "开奖前取消抽奖；楼主和版主",
      request: { params: IdParam },
      responses: {
        200: lotteryResponse,
        403: errorResponse("不是楼主或版主，或者已开奖、已取消（lottery_closed）"),
        404: notFound,
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const thread = await getThread(c.req.valid("param").id, readerOf(c));
      await cancelLottery(actorOf(c, viewer), can(c, "moderate"), thread);
      return c.json(lotteryJson(await getLottery(thread.id, viewer.id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/{id}/lottery/entries",
      summary: "参与的人：开奖前按参与的先后，开奖后按抽中的先后，带 prize（中了第几个奖项）",
      request: { params: IdParam },
      responses: {
        200: {
          description: "参与的人",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    user: UserBriefSchema,
                    prize: z
                      .number()
                      .nullable()
                      .openapi({ description: "中了第几个奖项，从 0 数；没中为 null" }),
                  }),
                ),
              }),
            },
          },
        },
        401: errorResponse("没有登录"),
        404: notFound,
      },
    }),
    async (c) => {
      authorize(c, "read");
      const { id } = c.req.valid("param");
      const thread = await getThread(id, readerOf(c));
      return c.json({ items: await listEntries(thread.lottery, id) }, 200);
    },
  );
