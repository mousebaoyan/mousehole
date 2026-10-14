import { z } from "@hono/zod-openapi";
import type { UserRef } from "../../platform/access.ts";

// A user in a path or header: a forum user ID, or qq: and a QQ number.
export const UserRefSchema = z
  .string()
  .regex(/^(qq:)?\d{1,12}$/, "格式应为 qq:QQ号 或论坛用户 ID")
  .transform((v): UserRef =>
    v.startsWith("qq:") ? { qq: Number(v.slice(3)) } : { id: Number(v) },
  );

// How a person appears next to what they wrote, wherever that is.
export const UserBriefSchema = z
  .object({
    id: z.number(),
    display_name: z.string(),
    avatar_url: z.string().nullable().openapi({ description: "QQ 头像的副本；还没拉到时为 null" }),
    role: z.string(),
    level: z.number().openapi({ description: "论坛等级 0–5" }),
    title: z.string().openapi({ description: "主群里的专属头衔，没有为空字符串" }),
  })
  .openapi("UserBrief");

// Someone who wrote anonymously, as all but themselves and admins see them (design §8.12).
export const AnonymousSchema = z
  .object({
    anonymous: z.literal(true),
    number: z.number().openapi({ description: "这个人在这个帖子里的编号" }),
    display_name: z.string().openapi({ description: "匿名鼠 3" }),
  })
  .openapi("Anonymous");

// Who wrote something: the person, or their number in the thread.
export const WriterSchema = z.union([UserBriefSchema, AnonymousSchema]);
