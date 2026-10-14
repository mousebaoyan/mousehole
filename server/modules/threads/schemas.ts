import { z } from "@hono/zod-openapi";
import { unix } from "../../platform/http.ts";
import { UserBriefSchema, WriterSchema } from "../users/schemas.ts";
import type { threadsByIds } from "./service.ts";

// A thread as lists show it; also used by search results.
export const ThreadSchema = z
  .object({
    id: z.number(),
    board: z.object({ slug: z.string(), name: z.string(), color: z.string() }),
    kind: z.string().openapi({ description: "discussion：讨论；question：问答" }),
    title: z.string(),
    author: WriterSchema,
    posters: z
      .array(UserBriefSchema)
      .openapi({ description: "作者以外最近回复的最多 4 个人，不含匿名回复的" }),
    tags: z.array(z.string()),
    pinned: z.number().openapi({ description: "0：不置顶；1：版块内置顶；2：全站置顶" }),
    featured: z.boolean(),
    locked: z.boolean(),
    solved_post_id: z.number().nullable(),
    reply_count: z.number(),
    floor_count: z.number(),
    view_count: z.number(),
    like_count: z.number(),
    last_post_at: z.number(),
    created_at: z.number(),
    last_read_floor: z
      .number()
      .optional()
      .openapi({ description: "自己读过的最高一楼，没打开过为 0；只在登录时有" }),
  })
  .openapi("Thread");

type ThreadItem = NonNullable<ReturnType<Awaited<ReturnType<typeof threadsByIds>>["get"]>>;

// What is the reader's own comes only to someone signed in.
export function threadJson(t: ThreadItem, signedIn: boolean) {
  return {
    id: t.id,
    board: { slug: t.board_slug, name: t.board_name, color: t.board_color },
    kind: t.kind,
    title: t.title,
    author: t.author,
    posters: t.posters,
    tags: t.tags,
    pinned: t.pinned,
    featured: t.featured,
    locked: t.locked,
    solved_post_id: t.solved_post_id,
    reply_count: t.reply_count,
    floor_count: t.floor_count,
    view_count: t.view_count,
    like_count: t.like_count,
    last_post_at: unix(t.last_post_at),
    created_at: unix(t.created_at),
    ...(signedIn && { last_read_floor: t.last_read_floor ?? 0 }),
  };
}
