import { createRoute, z } from "@hono/zod-openapi";
import { reachOf } from "../../platform/access.ts";
import {
  actorOf,
  authorize,
  authorizePosting,
  can,
  createRouter,
  errorResponse,
  IdParam,
  IntParam,
  unix,
  UnixSeconds,
} from "../../platform/http.ts";
import { UserBriefSchema, UserRefSchema, WriterSchema } from "../users/schemas.ts";
import {
  clearArchiveFlags,
  countArchiveFlags,
  flagArchived,
  handleReport,
  lift,
  listArchiveFlags,
  listReports,
  reportBoost,
  reportPost,
  restrict,
} from "./service.ts";

const UserParam = z.object({ user: UserRefSchema });
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
    held: z.boolean().openapi({
      description: "L4 举报等级比自己低的人，这一层先隐藏了；驳回时恢复",
    }),
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

const flagged = {
  204: { description: "已保存" },
  400: errorResponse("这一层不是从群聊收录的"),
  403: errorResponse("不是成员，或者被禁言了"),
  404: errorResponse("回复不存在"),
};

const ArchiveFlagSchema = z
  .object({
    post: z.object({
      id: z.number(),
      floor: z.number(),
      thread: z.object({ id: z.number(), title: z.string() }),
      author: WriterSchema,
      excerpt: z.string(),
      created_at: z.number().openapi({ description: "在群里发出的时间" }),
    }),
    count: z.number().openapi({ description: "几个人反馈了" }),
    flagged_at: z.number().openapi({ description: "最近一次反馈的时间" }),
  })
  .openapi("ArchiveFlag");

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
                until: UnixSeconds.positive().nullable(),
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
      const reach = reachOf(viewer, c.var.bot);
      await reportPost(
        actorOf(c, viewer),
        viewer,
        reach,
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
      const reach = reachOf(viewer, c.var.bot);
      await reportBoost(
        actorOf(c, viewer),
        viewer,
        reach,
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
          cursor: IntParam.optional(),
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
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/posts/{id}/archive-flag",
      summary: "反馈这一层收录有误：只有从群聊收录的楼层能反馈，已反馈过的不变",
      request: { params: IdParam },
      responses: flagged,
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      await flagArchived(viewer, reachOf(viewer, c.var.bot), c.req.valid("param").id, true);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/posts/{id}/archive-flag",
      summary: "撤回自己对这一层收录有误的反馈",
      request: { params: IdParam },
      responses: flagged,
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      await flagArchived(viewer, reachOf(viewer, c.var.bot), c.req.valid("param").id, false);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/archive-flags",
      summary: "被反馈收录有误、还公开着的楼层，反馈的人多的在前，再按最近反馈的时间，最多 100 层",
      responses: {
        200: {
          description: "楼层",
          content: {
            "application/json": { schema: z.object({ items: z.array(ArchiveFlagSchema) }) },
          },
        },
        403: errorResponse("不是版主"),
      },
    }),
    async (c) => {
      authorize(c, "moderate");
      const items = await listArchiveFlags();
      return c.json(
        {
          items: items.map((f) => ({
            ...f,
            post: { ...f.post, created_at: unix(f.post.created_at) },
            flagged_at: unix(f.flagged_at),
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/archive-flags/count",
      summary: "被反馈收录有误、还公开着的楼层有几层，后台的菜单上显示",
      responses: {
        200: {
          description: "层数",
          content: { "application/json": { schema: z.object({ count: z.number() }) } },
        },
        403: errorResponse("不是版主"),
      },
    }),
    async (c) => {
      authorize(c, "moderate");
      return c.json({ count: await countArchiveFlags() }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/admin/archive-flags/{id}",
      summary:
        "处理完一层的反馈（楼层另外隐藏，或者没有问题），清掉它收到的全部反馈；id 是楼层的 ID",
      request: { params: IdParam },
      responses: {
        204: { description: "已清除" },
        403: errorResponse("不是版主"),
        404: errorResponse("这一层没有反馈"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      await clearArchiveFlags(actorOf(c, viewer), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
