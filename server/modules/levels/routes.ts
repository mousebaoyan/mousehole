import { createRoute, z } from "@hono/zod-openapi";
import { AppError } from "../../platform/errors.ts";
import { actorOf, authorize, can, createRouter, errorResponse } from "../../platform/http.ts";
import { UserRefSchema } from "../users/schemas.ts";
import { findUserId } from "../users/service.ts";
import { levelProgress, setLevel } from "./service.ts";

const UserParam = z.object({ user: UserRefSchema });

const ProgressSchema = z
  .object({
    level: z.number(),
    locked: z.boolean().openapi({ description: "管理员定下的等级，不再自动升降" }),
    next: z
      .object({
        level: z.number().openapi({ description: "下一级；和 level 相同时是 L4 保级的条件" }),
        items: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            have: z.number(),
            need: z.number().openapi({ description: "阅读时间以秒计" }),
          }),
        ),
      })
      .nullable()
      .openapi({ description: "L5 和锁定的等级为 null" }),
  })
  .openapi("LevelProgress");

export const levelsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}/level",
      summary: "等级和升级进度：下一级的每项条件和现在的数，L4 是保级的条件；本人和管理员能看",
      request: { params: UserParam },
      responses: {
        200: { description: "进度", content: { "application/json": { schema: ProgressSchema } } },
        403: errorResponse("不是本人或管理员"),
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "read");
      const id = await findUserId(c.req.valid("param").user);
      if (id !== viewer.id && !can(c, "admin")) {
        throw new AppError(403, "forbidden", "只能看自己的升级进度");
      }
      return c.json(await levelProgress(id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/users/{user}/level",
      summary: "设定等级：L5 只能这样授予；locked 为 true 时不再自动升降。升级时本人收到通知",
      request: {
        params: UserParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ level: z.number().int().min(0).max(5), locked: z.boolean() }),
            },
          },
        },
      },
      responses: {
        204: { description: "已设定" },
        403: errorResponse("不是管理员"),
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      const id = await findUserId(c.req.valid("param").user);
      await setLevel(actorOf(c, viewer), id, c.req.valid("json"));
      return c.body(null, 204);
    },
  );
