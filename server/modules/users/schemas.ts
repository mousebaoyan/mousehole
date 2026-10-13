import { z } from "@hono/zod-openapi";

// How a person appears next to what they wrote, wherever that is.
export const UserBriefSchema = z
  .object({
    id: z.number(),
    display_name: z.string(),
    role: z.string(),
    level: z.number().nullable(),
    title: z.string().openapi({ description: "主群里的专属头衔，没有为空字符串" }),
  })
  .openapi("UserBrief");
