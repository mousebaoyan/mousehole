import { createRoute, z } from "@hono/zod-openapi";
import { isMember } from "../../platform/access.ts";
import {
  actorOf,
  authorize,
  authorizePosting,
  can,
  createRouter,
  errorResponse,
  unix,
} from "../../platform/http.ts";
import { UserBriefSchema, UserRefSchema, WriterSchema } from "../users/schemas.ts";
import { handleReport, lift, listReports, reportBoost, reportPost, restrict } from "./service.ts";

const UserParam = z.object({ user: UserRefSchema });
const IdParam = z.object({ id: z.coerce.number().int() });
const Reason = z.string().trim().min(1).max(200);

const ReportBody = {
  required: true,
  content: { "application/json": { schema: z.object({ reason: Reason }) } },
};

const reported = {
  204: { description: "已举报" },
  403: errorResponse("不是成员，或者被禁言了"),
  404: errorResponse("内容不存在"),
  409: errorResponse("已经举报过了"),
};

const ReportSchema = z
  .object({
    id: z.number(),
    reason: z.string(),
    status: z.string().openapi({ description: "open 待处理，resolved 已处理，dismissed 已驳回" }),
    reporter: UserBriefSchema,
    post: z.object({
      id: z.number(),
      floor: z.number(),
      thread: z.object({ id: z.number(), title: z.string() }),
      author: WriterSchema,
      excerpt: z.string(),
      deleted: z.boolean(),
    }),
    boost: z
      .object({ id: z.number(), body: z.string(), user: WriterSchema })
      .nullable()
      .openapi({ description: "举报的是这一层下的短评时" }),
    handler: UserBriefSchema.nullable(),
    handled_at: z.number().nullable(),
    created_at: z.number(),
  })
  .openapi("Report");

export const moderationRoutes = createRouter()
  .openapi(
    createRoute({
      method: "put",
      path: "/users/{user}/restriction",
      summary: "禁言（版主）或封禁（管理员）：until 是到期的 Unix 秒，null 是永久；已有的就换掉",
      request: {
        params: UserParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                type: z.enum(["mute", "ban"]),
                until: z.number().int().positive().nullable(),
                reason: Reason,
              }),
            },
          },
        },
      },
      responses: {
        204: { description: "已生效" },
        403: errorResponse("没有权限，或者对方不是普通成员"),
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const { type, until, reason } = c.req.valid("json");
      const viewer = authorize(c, type === "ban" ? "admin" : "moderate");
      await restrict(actorOf(c, viewer), c.req.valid("param").user, {
        type,
        until: until === null ? null : new Date(until * 1000),
        reason,
      });
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/users/{user}/restriction",
      summary: "解除禁言或封禁；解除封禁要管理员",
      request: {
        params: UserParam,
        body: {
          required: false,
          content: { "application/json": { schema: z.object({ reason: Reason.optional() }) } },
        },
      },
      responses: {
        204: { description: "已解除" },
        403: errorResponse("没有权限"),
        404: errorResponse("用户不存在，或者没有被禁言或封禁"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      await lift(
        actorOf(c, viewer),
        can(c, "admin"),
        c.req.valid("param").user,
        c.req.valid("json").reason,
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/posts/{id}/report",
      summary: "举报一层：每人对每层一次",
      request: { params: IdParam, body: ReportBody },
      responses: reported,
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      const members = isMember(viewer, c.var.bot);
      await reportPost(
        actorOf(c, viewer),
        viewer,
        members,
        c.req.valid("param").id,
        c.req.valid("json").reason,
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/boosts/{id}/report",
      summary: "举报一条短评：每人对每条一次",
      request: { params: IdParam, body: ReportBody },
      responses: reported,
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      const members = isMember(viewer, c.var.bot);
      await reportBoost(
        actorOf(c, viewer),
        viewer,
        members,
        c.req.valid("param").id,
        c.req.valid("json").reason,
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/reports",
      summary: "举报，最新的在前，每页 30 条；cursor 是上一页最后一条的 ID",
      request: {
        query: z.object({
          status: z.enum(["open", "resolved", "dismissed"]).default("open"),
          cursor: z.coerce.number().int().optional(),
        }),
      },
      responses: {
        200: {
          description: "举报",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(ReportSchema),
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
      const { status, cursor } = c.req.valid("query");
      const page = await listReports(status, cursor);
      return c.json(
        {
          items: page.items.map((r) => ({
            ...r,
            handled_at: r.handled_at && unix(r.handled_at),
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
      method: "patch",
      path: "/admin/reports/{id}",
      summary: "处理举报：resolved 已处理（内容另外删或隐藏），dismissed 驳回",
      request: {
        params: IdParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ status: z.enum(["resolved", "dismissed"]) }),
            },
          },
        },
      },
      responses: {
        204: { description: "已处理" },
        403: errorResponse("不是版主"),
        404: errorResponse("举报不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      await handleReport(actorOf(c, viewer), c.req.valid("param").id, c.req.valid("json").status);
      return c.body(null, 204);
    },
  );
