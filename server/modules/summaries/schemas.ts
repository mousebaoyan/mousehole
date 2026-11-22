import { z } from "@hono/zod-openapi";
import { unix } from "../../platform/http.ts";
import type { Point } from "./service.ts";

export const SummarySchema = z
  .object({
    lead: z.string().meta({ description: "讨论的是什么，一句话" }),
    points: z.array(
      z.object({
        text: z.string(),
        floors: z.array(z.number()).meta({ description: "出处的楼层号" }),
      }),
    ),
    replies: z.number().meta({ description: "根据几条回复写的" }),
    created_at: z.number(),
  })
  .openapi("Summary", { description: "AI 总结（总体设计 §8.18）" });

export function summaryJson(s: {
  lead: string;
  points: Point[];
  replies: number;
  created_at: Date;
}) {
  return { ...s, created_at: unix(s.created_at) };
}
