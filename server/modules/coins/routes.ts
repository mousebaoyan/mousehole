import { createRoute, z } from "@hono/zod-openapi";
import { isMember } from "../../platform/access.ts";
import { AppError } from "../../platform/errors.ts";
import { authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { UserBriefSchema } from "../users/schemas.ts";
import { userBriefs } from "../users/service.ts";
import { PERIODS } from "./rules.ts";
import { coinBalance, leaderboard, listLedger } from "./service.ts";

const EntrySchema = z
  .object({
    amount: z.number().openapi({ description: "挣为正、花为负" }),
    reason: z.string().openapi({
      description:
        "check_in 签到、liked 获赞、accepted 回复被采纳、question 发问答帖、look 兑换动态版",
    }),
    day: z
      .string()
      .openapi({ description: "北京时间的日期 YYYY-MM-DD：挣的是算的那天，花的是花的那天" }),
    created_at: z.number(),
    thread: z
      .object({ id: z.number(), title: z.string() })
      .nullable()
      .openapi({ description: "发的问答帖" }),
    look: z
      .object({ kind: z.string(), key: z.string() })
      .nullable()
      .openapi({ description: "兑换的动态版" }),
  })
  .openapi("CoinEntry");

export const coinsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/me/coins",
      summary: "鼠币余额和明细，最新的在前，每页 50 条",
      request: { query: z.object({ cursor: z.coerce.number().int().optional() }) },
      responses: {
        200: {
          description: "余额和明细",
          content: {
            "application/json": {
              schema: z.object({
                coins: z.number(),
                items: z.array(EntrySchema),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "read");
      const page = await listLedger(viewer.id, c.req.valid("query").cursor);
      return c.json(
        {
          coins: await coinBalance(viewer.id),
          items: page.rows.map((r) => ({
            amount: r.amount,
            reason: r.reason,
            day: r.day,
            created_at: unix(r.created_at),
            thread:
              r.thread_id !== null && r.title !== null ? { id: r.thread_id, title: r.title } : null,
            look:
              r.look_kind !== null && r.look_key !== null
                ? { kind: r.look_kind, key: r.look_key }
                : null,
          })),
          next_cursor: page.next_cursor,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/coins/leaderboard",
      summary: "鼠币排行榜：这段时间挣到的鼠币，前 50 名，不含 bot 和冻结的账号",
      request: {
        query: z.object({
          period: z.enum(PERIODS).default("week").openapi({
            description: "week 本周一起、month 本月 1 日起、all 总榜，北京时间",
          }),
        }),
      },
      responses: {
        200: {
          description: "排行榜",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(z.object({ user: UserBriefSchema, earned: z.number() })),
              }),
            },
          },
        },
        403: errorResponse("不是成员"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "read");
      if (!isMember(viewer, c.var.bot)) throw new AppError(403, "forbidden", "仅成员可查看");
      const rows = await leaderboard(c.req.valid("query").period);
      const user = await userBriefs(rows.map((r) => r.user_id));
      return c.json({ items: rows.map((r) => ({ user: user(r.user_id), earned: r.earned })) }, 200);
    },
  );
