import { z } from "@hono/zod-openapi";

// How a person appears next to what they wrote, wherever that is.
export const UserBriefSchema = z
  .object({
    id: z.number(),
    display_name: z.string(),
    avatar_url: z.string().nullable().openapi({ description: "QQ 头像的副本；还没拉到时为 null" }),
    role: z.string(),
    level: z.number().nullable(),
    title: z.string().openapi({ description: "主群里的专属头衔，没有为空字符串" }),
  })
  .openapi("UserBrief");
