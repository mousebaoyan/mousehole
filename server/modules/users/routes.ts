import { readFile } from "node:fs/promises";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../../platform/errors.ts";
import { isMember } from "../../platform/access.ts";
import { authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { UserBriefSchema, UserRefSchema } from "./schemas.ts";
import { AVATARS_DIR, getProfile, getUser, searchUsers } from "./service.ts";

const MeSchema = z
  .object({
    id: z.number(),
    display_name: z.string(),
    avatar_url: z.string().nullable(),
    role: z.string(),
    qq: z.number().nullable(),
    member_status: z.string(),
    activated: z.boolean(),
  })
  .openapi("Me");

const UserSchema = UserBriefSchema.extend({
  card: z.string().nullable().openapi({ description: "主群的群名片；不在主群为 null" }),
  bio: z.string(),
  joined_at: z.number().nullable().openapi({ description: "加入主群的时间" }),
  last_sent_at: z.number().nullable().openapi({ description: "最近一次在主群发言，精确到小时" }),
  qq: z.number().optional().openapi({ description: "qq、member_status、activated 只给成员和 bot" }),
  member_status: z.string().optional(),
  activated: z.boolean().optional(),
  stats: z.object({
    threads: z.number(),
    posts: z.number(),
    likes: z.number().openapi({ description: "获赞数" }),
    days_visited: z.number(),
    read_seconds: z.number(),
    threads_read: z.number(),
    posts_read: z.number(),
  }),
}).openapi("User");

export const usersRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/users",
      summary: "按名字找成员，最多 8 个：名字以它开头的在前，再按最近活跃；编辑器的 @ 补全用",
      request: { query: z.object({ q: z.string().trim().min(1).max(20) }) },
      responses: {
        200: {
          description: "找到的成员",
          content: {
            "application/json": { schema: z.object({ items: z.array(UserBriefSchema) }) },
          },
        },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => {
      authorize(c, "read");
      return c.json({ items: await searchUsers(c.req.valid("query").q) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}",
      summary: "资料卡：群里的资料和论坛里的统计",
      request: { params: z.object({ user: UserRefSchema }) },
      responses: {
        200: { description: "用户", content: { "application/json": { schema: UserSchema } } },
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const u = await getUser(c.req.valid("param").user);
      const members = isMember(c.var.viewer, c.var.bot);
      return c.json(
        {
          id: u.id,
          display_name: u.display_name,
          avatar_url: u.avatar_url,
          role: u.role,
          level: u.level,
          title: u.title,
          card: u.card,
          bio: u.bio,
          joined_at: u.joined_at && unix(u.joined_at),
          last_sent_at: u.last_sent_at && unix(u.last_sent_at),
          // Like a group's member list, which people outside it can't see.
          ...(members && {
            qq: u.qq,
            member_status: u.member_status,
            activated: u.activated_at !== null,
          }),
          stats: {
            threads: u.thread_count,
            posts: u.post_count,
            likes: u.like_received,
            days_visited: u.days_visited,
            read_seconds: u.read_seconds,
            threads_read: u.threads_read,
            posts_read: u.posts_read,
          },
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me",
      summary: "当前用户；bot 代表某人时返回这个人",
      responses: {
        200: { description: "当前用户", content: { "application/json": { schema: MeSchema } } },
        401: errorResponse("没有登录"),
        403: errorResponse("bot token 没有 read 范围"),
      },
    }),
    async (c) => {
      const { activated_at, ...profile } = await getProfile(authorize(c, "read").id);
      return c.json({ ...profile, activated: activated_at !== null }, 200);
    },
  );

// Registered ahead of sessions in app.ts: avatars are public, and their addresses carry the
// version, so they can be cached for good.
export async function serveAvatar(c: Context) {
  const file = await readFile(`${AVATARS_DIR}/${c.req.param("file")}`).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AppError(404, "not_found", "头像不存在");
    }
    throw error;
  });
  return c.body(file, 200, {
    "content-type": "image/webp",
    "cache-control": "public, max-age=31536000, immutable",
  });
}
