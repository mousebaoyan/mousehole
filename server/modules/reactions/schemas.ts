import { z } from "@hono/zod-openapi";
import { unix } from "../../platform/http.ts";
import { WriterSchema } from "../users/schemas.ts";
import type { Boost } from "./service.ts";

export const BoostSchema = z
  .object({ id: z.number(), user: WriterSchema, body: z.string(), created_at: z.number() })
  .openapi("Boost");

export function boostJson(b: Boost) {
  return { id: b.id, user: b.user, body: b.body, created_at: unix(b.created_at) };
}
