import { createRoute, z } from "@hono/zod-openapi";
import { actorOf, authorize, can, createRouter, errorResponse } from "../../platform/http.ts";
import { UserRefSchema } from "../users/schemas.ts";
import { lift, restrict } from "./service.ts";

const UserParam = z.object({ user: UserRefSchema });
const Reason = z.string().trim().min(1).max(200);

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
  );
