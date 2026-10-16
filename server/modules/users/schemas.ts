import { z } from "@hono/zod-openapi";
import type { UserRef } from "../../platform/access.ts";
import { FRAMES } from "./customization.ts";

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
    title: z.string().openapi({
      description: "头衔：选了徽章当头衔时是徽章名，否则是 QQ 的专属头衔；没有为空字符串",
    }),
    title_tier: z
      .string()
      .nullable()
      .openapi({ description: "当头衔的徽章的档，gold 或 silver；QQ 的专属头衔为 null" }),
    user_status: z
      .object({ emoji: z.string(), text: z.string() })
      .nullable()
      .openapi({ description: "状态：一个表情加一句话；没有或过期了为 null" }),
    frame: z
      .object({ key: z.enum(FRAMES), moving: z.boolean() })
      .nullable()
      .openapi({
        description: "头像框；moving 是动不动：兑换了动态版的、徽章解锁的会动。没有为 null",
      }),
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
