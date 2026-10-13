import { z } from "@hono/zod-openapi";
import { unix } from "../../platform/http.ts";
import { UserBriefSchema } from "../users/schemas.ts";
import type { Boost } from "./service.ts";

export const BoostSchema = z
  .object({ id: z.number(), user: UserBriefSchema, body: z.string(), created_at: z.number() })
  .openapi("Boost");

export function boostJson(b: Boost) {
  return { id: b.id, user: b.user, body: b.body, created_at: unix(b.created_at) };
}
