import { createRoute, z } from "@hono/zod-openapi";
import { authorize, createRouter, errorResponse } from "../../platform/http.ts";
import { getProfile } from "./service.ts";

const MeSchema = z
  .object({
    id: z.number(),
    display_name: z.string(),
    role: z.string(),
    qq: z.number().nullable(),
    member_status: z.string(),
    activated: z.boolean(),
  })
  .openapi("Me");

export const usersRoutes = createRouter().openapi(
  createRoute({
    method: "get",
    path: "/me",
    summary: "当前用户；bot 代表某人时返回这个人",
    responses: {
      200: { description: "当前用户", content: { "application/json": { schema: MeSchema } } },
      401: errorResponse("没有登录"),
      403: errorResponse("bot token 没有 read 范围"),
    },
  }),
  async (c) => {
    const { activated_at, ...profile } = await getProfile(authorize(c, "read").id);
    return c.json({ ...profile, activated: activated_at !== null }, 200);
  },
);
