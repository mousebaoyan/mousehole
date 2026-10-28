import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { isMember } from "../../platform/access.ts";
import { AppError } from "../../platform/errors.ts";
import {
  actorOf,
  authorize,
  createRouter,
  errorResponse,
  IdParam,
  IntParam,
  requireWeb,
  unix,
  UnixSeconds,
  type AppEnv,
} from "../../platform/http.ts";
import { getSettings } from "../../platform/settings.ts";
import { UserBriefSchema, UserRefSchema } from "../users/schemas.ts";
import { findUserId, userBriefs } from "../users/service.ts";
import { codeImage } from "./code-image.ts";
import { daysOf, MAX_AMOUNT, MAX_MESSAGE, METHODS, MIN_AMOUNT, STATUSES, yuan } from "./rules.ts";
import {
  addSponsorship,
  countPending,
  deleteSponsorship,
  editOwnSponsorship,
  listForReview,
  listMine,
  listThanks,
  registerSponsorship,
  reviewSponsorship,
  sponsorStatus,
  withdrawSponsorship,
} from "./service.ts";

const Amount = z
  .number()
  .int()
  .min(MIN_AMOUNT, `金额至少 ¥${yuan(MIN_AMOUNT)}`)
  .max(MAX_AMOUNT, `金额最多 ¥${yuan(MAX_AMOUNT)}`)
  .openapi({ description: "金额，以分记" });
const Message = z
  .string()
  .trim()
  .max(MAX_MESSAGE)
  .nullable()
  .transform((m) => m || null)
  .openapi({ description: `留言，最多 ${MAX_MESSAGE} 个字，纯文本` });

const SponsorshipSchema = z
  .object({
    id: z.number(),
    amount: z.number().openapi({ description: "金额，以分记" }),
    method: z.enum(METHODS),
    status: z
      .enum(STATUSES)
      .openapi({ description: "pending 待确认、confirmed 已确认、rejected 没收到" }),
    message: z.string().nullable(),
    anonymous: z.boolean().openapi({ description: "在感谢墙上匿名" }),
    paid_at: z.number(),
    reason: z.string().nullable().openapi({ description: "标为没收到的理由" }),
  })
  .openapi("Sponsorship");

const ReviewedSchema = SponsorshipSchema.extend({
  user: UserBriefSchema.extend({ qq: z.number().nullable() }).openapi({
    description: "赞助的人，匿名的也给",
  }),
  reviewer: UserBriefSchema.nullable().openapi({ description: "最近一次确认或标为没收到的人" }),
  reviewed_at: z.number().nullable(),
  created_at: z.number().openapi({ description: "登记的时间" }),
}).openapi("ReviewedSponsorship");

const ThanksSchema = z
  .object({
    id: z.number(),
    user: UserBriefSchema.nullable().openapi({ description: "匿名的为 null" }),
    days: z.number().nullable().openapi({
      description: "档位：7（¥24 起）、4（¥14 起）、2（¥7 起），不到 ¥7 的为 null",
    }),
    message: z.string().nullable(),
    paid_at: z.number(),
  })
  .openapi("Thanks");

const Page = z.object({ cursor: IntParam.optional() });

function own(r: Awaited<ReturnType<typeof listMine>>[number]) {
  return {
    id: r.id,
    amount: r.amount,
    method: r.method,
    status: r.status,
    message: r.message,
    anonymous: r.anonymous,
    paid_at: unix(r.paid_at),
    reason: r.reason,
  };
}

// The payee and the owner see to sponsorships, on the web (design §8.21). A payee no longer an
// admin, or frozen, stays in the settings until the owner picks another, but sees to none.
async function authorizePayee(c: Context<AppEnv>) {
  requireWeb(c);
  const viewer = authorize(c, "admin");
  if (viewer.role !== "owner" && viewer.id !== (await getSettings()).sponsor.payee) {
    throw new AppError(403, "forbidden", "只有收款人和站长能操作");
  }
  return viewer;
}

const notOwn = {
  401: errorResponse("没有登录"),
  403: errorResponse("不是成员，或者用 token 调用"),
  404: errorResponse("没有这笔赞助，或者不是自己的"),
};

const notPayee = {
  401: errorResponse("没有登录"),
  403: errorResponse("不是收款人或站长，或者用 token 调用"),
};

export const sponsorsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/sponsor",
      summary: "赞助页：收款人、收款码和今年确认过的合计",
      responses: {
        200: {
          description: "赞助页",
          content: {
            "application/json": {
              schema: z.object({
                payee: UserBriefSchema.nullable().openapi({
                  description: "收款人；没设时为 null，不能登记",
                }),
                codes: z
                  .object({ wechat: z.string().nullable(), alipay: z.string().nullable() })
                  .nullable()
                  .openapi({ description: "收款码的内容，没设的为 null；只给成员，访客为 null" }),
                year: z
                  .object({ amount: z.number(), count: z.number() })
                  .openapi({ description: "今年（北京时间）确认过的赞助：金额以分记，笔数" }),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const { payee, codes, year } = await sponsorStatus();
      const user = await userBriefs(payee === null ? [] : [payee]);
      return c.json(
        {
          payee: payee === null ? null : user(payee),
          codes: isMember(c.var.viewer, c.var.bot) ? codes : null,
          year,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/sponsorships",
      summary: "感谢墙：确认过的赞助，最近登记的在前，每页 50 条，不带金额",
      request: { query: Page },
      responses: {
        200: {
          description: "设了不给访客看的人，访客拿到的没有 TA 的那条",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(ThanksSchema),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        400: errorResponse("cursor 不对"),
      },
    }),
    async (c) => {
      const guest = !isMember(c.var.viewer, c.var.bot);
      const page = await listThanks(guest, c.req.valid("query").cursor);
      const user = await userBriefs(page.rows.map((r) => r.user_id));
      return c.json(
        {
          items: page.rows.map((r) => ({
            id: r.id,
            user: r.anonymous ? null : user(r.user_id),
            days: daysOf(r.amount),
            message: r.message,
            paid_at: unix(r.paid_at),
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
      path: "/me/sponsorships",
      summary: "自己的赞助记录，最近登记的在前，最多 50 条",
      responses: {
        200: {
          description: "赞助记录",
          content: {
            "application/json": { schema: z.object({ items: z.array(SponsorshipSchema) }) },
          },
        },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "read");
      return c.json({ items: (await listMine(viewer.id)).map(own) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/sponsorships",
      summary: "付完款后登记，记为待确认，收款人收到通知",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                method: z.enum(METHODS),
                amount: Amount,
                message: Message,
                anonymous: z.boolean(),
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "登记好的记录",
          content: { "application/json": { schema: SponsorshipSchema } },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("不是成员，用 token 调用，或者没开放这种方式（sponsor_closed）"),
        409: errorResponse("已经有一笔待确认的（sponsorship_pending）"),
      },
    }),
    async (c) => {
      requireWeb(c);
      const viewer = authorize(c, "act");
      const row = await registerSponsorship(actorOf(c, viewer), c.req.valid("json"));
      return c.json(own(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/sponsorships/{id}",
      summary: "改自己的记录：随时可以改匿名；留言只能删掉",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({
                  anonymous: z.boolean().optional(),
                  message: z.null().optional().openapi({ description: "为 null 时删掉留言" }),
                })
                .refine(
                  (b) => b.anonymous !== undefined || b.message !== undefined,
                  "anonymous 和 message 至少带一个",
                ),
            },
          },
        },
      },
      responses: { 204: { description: "已修改" }, ...notOwn },
    }),
    async (c) => {
      requireWeb(c);
      const viewer = authorize(c, "act");
      await editOwnSponsorship(actorOf(c, viewer), c.req.valid("param").id, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/sponsorships/{id}",
      summary: "撤回自己待确认的记录",
      request: { params: IdParam },
      responses: {
        204: { description: "已撤回" },
        ...notOwn,
        409: errorResponse("收款人已经处理过（sponsorship_reviewed）"),
      },
    }),
    async (c) => {
      requireWeb(c);
      const viewer = authorize(c, "act");
      await withdrawSponsorship(actorOf(c, viewer), c.req.valid("param").id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/sponsorships",
      summary: "赞助记录：待确认的先登记的在前，其余最近登记的在前，每页 30 条",
      request: {
        query: Page.extend({ status: z.enum(STATUSES).default("pending") }),
      },
      responses: {
        200: {
          description: "赞助记录",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(ReviewedSchema),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        ...notPayee,
      },
    }),
    async (c) => {
      await authorizePayee(c);
      const { status, cursor } = c.req.valid("query");
      const page = await listForReview(status, cursor);
      const user = await userBriefs(
        page.rows.flatMap((r) =>
          r.reviewer_id === null ? [r.user_id] : [r.user_id, r.reviewer_id],
        ),
      );
      return c.json(
        {
          items: page.rows.map((r) => ({
            ...own(r),
            user: { ...user(r.user_id), qq: r.qq },
            reviewer: r.reviewer_id === null ? null : user(r.reviewer_id),
            reviewed_at: r.reviewed_at && unix(r.reviewed_at),
            created_at: unix(r.created_at),
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
      path: "/admin/sponsorships/count",
      summary: "待确认的赞助有几条，后台的菜单上显示",
      responses: {
        200: {
          description: "条数",
          content: { "application/json": { schema: z.object({ count: z.number() }) } },
        },
        ...notPayee,
      },
    }),
    async (c) => {
      await authorizePayee(c);
      return c.json({ count: await countPending() }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/sponsorships",
      summary: "补录：直接是已确认、匿名的，本人收到通知",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                user: UserRefSchema,
                method: z.enum(METHODS),
                amount: Amount,
                paid_at: UnixSeconds.refine((t) => t <= Date.now() / 1000, "付款时间不能晚于现在"),
                message: Message,
              }),
            },
          },
        },
      },
      responses: {
        201: {
          description: "补录的记录",
          content: { "application/json": { schema: SponsorshipSchema } },
        },
        ...notPayee,
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const viewer = await authorizePayee(c);
      const { user, paid_at, ...entry } = c.req.valid("json");
      const row = await addSponsorship(actorOf(c, viewer), {
        ...entry,
        user_id: await findUserId(user),
        paid_at: new Date(paid_at * 1000),
      });
      return c.json(own(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/sponsorships/{id}",
      summary: "确认、标为没收到或撤销确认，改金额，删掉留言；状态变了时本人收到通知",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                status: z
                  .enum(["confirmed", "rejected"])
                  .optional()
                  .openapi({ description: "confirmed 确认；rejected 没收到，或者撤销确认" }),
                reason: z
                  .string()
                  .trim()
                  .max(200)
                  .nullable()
                  .optional()
                  .transform((r) => r || null)
                  .openapi({ description: "标为没收到的理由" }),
                amount: Amount.optional(),
                message: z.null().optional().openapi({ description: "为 null 时删掉留言" }),
              }),
            },
          },
        },
      },
      responses: {
        204: { description: "已修改" },
        ...notPayee,
        404: errorResponse("没有这笔赞助"),
      },
    }),
    async (c) => {
      const viewer = await authorizePayee(c);
      await reviewSponsorship(actorOf(c, viewer), c.req.valid("param").id, c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/sponsorships/{id}",
      summary: "删掉记错的赞助记录",
      request: { params: IdParam },
      responses: {
        204: { description: "已删除" },
        ...notPayee,
        404: errorResponse("没有这笔赞助"),
      },
    }),
    async (c) => {
      const viewer = await authorizePayee(c);
      await deleteSponsorship(actorOf(c, viewer), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

// Registered after sessions in app.ts: a code shows part of the payee's real name, so members only
// (design §8.21). Pages name it by what it holds (codeImagePath), and a name for a code since
// replaced finds nothing, so caching it a while is safe.
export async function serveSponsorCode(c: Context<AppEnv>) {
  if (!isMember(c.var.viewer, c.var.bot)) {
    throw new AppError(403, "forbidden", "登录后才能看到收款码");
  }
  const method = METHODS.find((m) => c.req.path === `/sponsor/${m}.png`);
  const text = method && (await getSettings()).sponsor[method];
  if (!text || c.req.query("v") !== text) {
    throw new AppError(404, "not_found", "没有设置这种收款码，或者收款码已更换");
  }
  return c.body(await codeImage(text), 200, {
    "content-type": "image/png",
    "cache-control": "private, max-age=86400",
  });
}
