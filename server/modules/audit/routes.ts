import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { UserBriefSchema, UserRefSchema } from "../users/schemas.ts";
import { findUserId, userBriefs } from "../users/service.ts";
import { listAuditLogs } from "./service.ts";

export const auditRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/admin/audit-logs",
    summary: "操作日志，最新的在前，每页 50 条：按操作人、动作、对象筛选",
    request: {
      query: z.object({
        actor: UserRefSchema.optional(),
        action: z.string().max(40).optional().openapi({ example: "user.restrict" }),
        target_type: z.string().max(20).optional().openapi({ example: "user" }),
        target_id: z.coerce.number().int().optional(),
        cursor: z.coerce.number().int().optional(),
      }),
    },
    responses: {
      200: {
        description: "日志",
        content: {
          "application/json": {
            schema: z.object({
              items: z.array(
                z.object({
                  id: z.number(),
                  actor: UserBriefSchema.nullable().openapi({ description: "以谁的身份" }),
                  operator: UserBriefSchema.nullable().openapi({ description: "让 bot 做的人" }),
                  token: z.string().nullable().openapi({ description: "经由哪个 bot token" }),
                  action: z.string(),
                  target_type: z.string().nullable(),
                  target_id: z.number().nullable(),
                  data: z.record(z.string(), z.unknown()),
                  ip: z.string().nullable(),
                  created_at: z.number(),
                }),
              ),
              next_cursor: z.string().nullable(),
            }),
          },
        },
      },
      403: errorResponse("不是管理员"),
      404: errorResponse("操作人不存在"),
    },
  }),
  async (c) => {
    authorize(c, "admin");
    const { actor, action, target_type, target_id, cursor } = c.req.valid("query");
    const page = await listAuditLogs({
      actorId: actor === undefined ? undefined : await findUserId(actor),
      action,
      targetType: target_type,
      targetId: target_id,
      cursor,
    });
    const user = await userBriefs(
      page.rows.flatMap((r) => [r.actor_id, r.operator_id]).filter((id) => id !== null),
    );
    return c.json(
      {
        items: page.rows.map(({ actor_id, operator_id, token_name, created_at, ...r }) => ({
          ...r,
          actor: actor_id === null ? null : user(actor_id),
          operator: operator_id === null ? null : user(operator_id),
          token: token_name,
          created_at: unix(created_at),
        })),
        next_cursor: page.next_cursor,
      },
      200,
    );
  },
);
