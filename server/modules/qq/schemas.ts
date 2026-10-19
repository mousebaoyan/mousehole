import { z } from "@hono/zod-openapi";
import { UnixSeconds } from "../../platform/http.ts";

export const Source = z
  .object({
    chat_type: z.enum(["group", "private"]),
    chat_id: z.number().int().positive(),
    message_ids: z
      .array(z.number().int())
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, "消息不能重复"),
  })
  .openapi("Source", { description: "内容整理自同一个聊天里的哪几条 QQ 消息" });

export const CreatedAt = UnixSeconds.positive().openapi({
  description: "bot 收录时带：消息在群里发出的时间（Unix 秒），晚于现在的按现在算",
});

// Archived content may say when it was said, along with where.
export function createdWithSource(b: { source?: unknown; created_at?: number }) {
  return b.created_at === undefined || b.source !== undefined;
}
export const CREATED_WITH_SOURCE = {
  message: "created_at 要和 source 一起带",
  path: ["created_at"],
};
