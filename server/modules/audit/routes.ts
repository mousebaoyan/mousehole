import { createRoute, z } from "@hono/zod-openapi";
import {
  authorizeOwner,
  createRouter,
  errorResponse,
  IntParam,
  unix,
} from "../../platform/http.ts";
import { deviceSummary } from "../auth/device.ts";
import { UserBriefSchema, UserRefSchema } from "../users/schemas.ts";
import { findUserId, userBriefs } from "../users/service.ts";
import { listAuditLogs } from "./service.ts";

export const auditRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/admin/audit-logs",
    summary: "操作日志，最新的在前，每页 50 条：按操作人、IP、动作、对象筛选",
    request: {
      query: z.object({
        actor: UserRefSchema.optional(),
        ip: z.union([z.ipv4(), z.ipv6()]).optional(),
        action: z.string().max(40).optional().openapi({ example: "user.restrict" }),
        target_type: z.string().max(20).optional().openapi({ example: "user" }),
        target_id: IntParam.optional(),
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
                  user_agent: z.string().nullable(),
                  device: z
                    .string()
                    .nullable()
                    .openapi({ description: "从 User-Agent 看出的设备，例如 Chrome · macOS" }),
                  created_at: z.number(),
                }),
              ),
              next_cursor: z.string().nullable(),
            }),
          },
        },
      },
      400: errorResponse("IP 格式不对"),
      403: errorResponse("不是站长，或者用 bot token 调用"),
      404: errorResponse("操作人不存在"),
    },
  }),
  async (c) => {
    authorizeOwner(c);
    const { actor, ip, action, target_type, target_id, cursor } = c.req.valid("query");
    const page = await listAuditLogs({
      actorId: actor === undefined ? undefined : await findUserId(actor),
      ip,
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
          device: r.user_agent === null ? null : deviceSummary(r.user_agent),
          created_at: unix(created_at),
        })),
        next_cursor: page.next_cursor,
      },
      200,
    );
  },
);
