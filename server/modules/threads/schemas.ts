import { z } from "@hono/zod-openapi";
import { unix } from "../../platform/http.ts";
import { UserBriefSchema, WriterSchema } from "../users/schemas.ts";
import type { Lottery } from "./lotteries.ts";
import type { Poll } from "./polls.ts";
import type { threadsByIds } from "./service.ts";

// A thread as lists show it; also used by search results.
export const ThreadSchema = z
  .object({
    id: z.number(),
    board: z.object({ slug: z.string(), name: z.string(), color: z.string() }),
    kind: z
      .string()
      .openapi({ description: "discussion：讨论；question：问答；poll：投票；lottery：抽奖" }),
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

export const PollSchema = z
  .object({
    multiple: z.boolean().openapi({ description: "多选" }),
    max_choices: z.number().nullable().openapi({ description: "多选时最多选几项；null 不限" }),
    anonymous: z.boolean().openapi({ description: "匿名投票：只有票数，看不到谁投了什么" }),
    results: z.string().openapi({
      description: "voted 投过票或结束后才看得到结果，always 随时公开",
    }),
    closes_at: z.number().nullable().openapi({ description: "截止时间；null 不限" }),
    closed: z.boolean(),
    voter_count: z.number().openapi({ description: "一共多少人投了票" }),
    options: z.array(
      z.object({
        id: z.number(),
        label: z.string(),
        votes: z.number().nullable().openapi({ description: "票数；还看不到结果时为 null" }),
      }),
    ),
    my_votes: z
      .array(z.number())
      .nullable()
      .openapi({ description: "自己投的选项；访客为 null，没投为空数组" }),
  })
  .openapi("Poll");

export function pollJson(p: Poll) {
  return { ...p, closes_at: p.closes_at && unix(p.closes_at) };
}

export const LotterySchema = z
  .object({
    prizes: z.array(
      z.object({
        name: z.string(),
        winners: z.number().openapi({ description: "抽几人" }),
        won_by: z
          .array(UserBriefSchema)
          .nullable()
          .openapi({ description: "中奖的人，按抽中的先后；开奖前为 null" }),
      }),
    ),
    entry: z.string().openapi({ description: "button 点按钮参与，reply 回复帖子就算参与" }),
    min_level: z.number().openapi({ description: "参与要几级；版主和管理员不受限制" }),
    draws_at: z.number().openapi({ description: "开奖时间" }),
    drawn_at: z.number().nullable().openapi({ description: "实际开奖的时间；没开奖为 null" }),
    cancelled: z.boolean(),
    seed_hash: z.string().openapi({ description: "种子的 SHA-256，发帖时就公布" }),
    seed: z.string().nullable().openapi({ description: "种子，开奖后公开；之前为 null" }),
    entry_count: z.number().openapi({ description: "参与人数" }),
    entered: z.boolean().nullable().openapi({ description: "自己是否参与了；访客为 null" }),
  })
  .openapi("Lottery");

export function lotteryJson(l: Lottery) {
  return { ...l, draws_at: unix(l.draws_at), drawn_at: l.drawn_at && unix(l.drawn_at) };
}
