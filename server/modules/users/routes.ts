import { readFile } from "node:fs/promises";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../../platform/errors.ts";
import { isMember, restrictionOf, STAFF, type Restriction } from "../../platform/access.ts";
import { actorOf, authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { UserBriefSchema, UserRefSchema } from "./schemas.ts";
import { setCustomName } from "../members/service.ts";
import { NOTIFICATION_TYPES, notifyPrefs } from "../notifications/service.ts";
import {
  AVATARS_DIR,
  getProfile,
  getSettings,
  getUser,
  searchUsers,
  setEndorsement,
  setFollow,
  updateSettings,
} from "./service.ts";

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
  restriction: z
    .object({ type: z.string(), until: z.number().nullable() })
    .nullable()
    .optional()
    .openapi({ description: "禁言（mute）或封禁（ban）和到期时间；只给本人和版主" }),
  followed: z.boolean().optional().openapi({ description: "自己是否关注了 TA；只在登录时有" }),
  endorsed: z.boolean().optional().openapi({ description: "自己是否认可了 TA；只在登录时有" }),
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
    followers: z.number(),
    following: z.number(),
    endorsements: z.number(),
  }),
}).openapi("User");

const UserParam = z.object({ user: UserRefSchema });

function restrictionJson(r: Restriction) {
  return r && { type: r.type, until: r.until && unix(r.until) };
}

const Switches = z.object({ site: z.boolean(), qq: z.boolean() });

const SettingsSchema = z
  .object({
    custom_name: z.string().nullable().openapi({ description: "自己起的名字；null 是跟着 QQ" }),
    bio: z.string(),
    allow_proxy: z.boolean().openapi({ description: "是否允许 bot 代自己发帖、回复等" }),
    notify_prefs: z
      .record(z.string(), Switches)
      .openapi({ description: "每类通知的站内（site）和 QQ 提醒（qq）开关，含默认值" }),
  })
  .openapi("Settings");

async function settingsJson(userId: number) {
  const settings = await getSettings(userId);
  return { ...settings, notify_prefs: notifyPrefs(settings.notify_prefs) };
}

const changed = {
  204: { description: "已更新" },
  400: errorResponse("是自己"),
  403: errorResponse("不是成员"),
  404: errorResponse("用户不存在"),
};

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
      request: { params: UserParam },
      responses: {
        200: { description: "用户", content: { "application/json": { schema: UserSchema } } },
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const { viewer, bot } = c.var;
      const u = await getUser(c.req.valid("param").user, viewer?.id ?? null);
      const members = isMember(viewer, bot);
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
          ...(viewer && { followed: u.followed, endorsed: u.endorsed }),
          ...(viewer &&
            (viewer.id === u.id || STAFF.includes(viewer.role)) && {
              restriction: restrictionJson(restrictionOf(u.restriction, u.restricted_until)),
            }),
          stats: {
            threads: u.thread_count,
            posts: u.post_count,
            likes: u.like_received,
            days_visited: u.days_visited,
            read_seconds: u.read_seconds,
            threads_read: u.threads_read,
            posts_read: u.posts_read,
            followers: u.followers,
            following: u.following,
            endorsements: u.endorsements,
          },
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/users/{user}/follow",
      summary: "关注某人：TA 发新主题时通知我",
      request: { params: UserParam },
      responses: changed,
    }),
    async (c) => {
      await setFollow(authorize(c, "act"), c.req.valid("param").user, true);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/users/{user}/follow",
      summary: "取消关注",
      request: { params: UserParam },
      responses: changed,
    }),
    async (c) => {
      await setFollow(authorize(c, "act"), c.req.valid("param").user, false);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/users/{user}/endorsement",
      summary: "认可某人的帮助；每人对每人一次",
      request: { params: UserParam },
      responses: changed,
    }),
    async (c) => {
      await setEndorsement(authorize(c, "act"), c.req.valid("param").user, true);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/users/{user}/endorsement",
      summary: "撤回认可",
      request: { params: UserParam },
      responses: changed,
    }),
    async (c) => {
      await setEndorsement(authorize(c, "act"), c.req.valid("param").user, false);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me/settings",
      summary: "自己的设置：名字、简介、是否允许代发、通知开关",
      responses: {
        200: { description: "设置", content: { "application/json": { schema: SettingsSchema } } },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => c.json(await settingsJson(authorize(c, "read").id), 200),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/me",
      summary: "修改自己的设置，只改带了的字段；notify_prefs 里带了的类型整体替换",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                custom_name: z
                  .string()
                  .trim()
                  .min(1)
                  .max(24)
                  .regex(/^[^\n\r]*$/, "名字不能换行")
                  .nullable()
                  .optional()
                  .openapi({ description: "最多 24 个字；null 是改回跟着 QQ" }),
                bio: z.string().trim().max(60).optional(),
                allow_proxy: z.boolean().optional(),
                notify_prefs: z.partialRecord(z.enum(NOTIFICATION_TYPES), Switches).optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "改好的设置",
          content: { "application/json": { schema: SettingsSchema } },
        },
        403: errorResponse("不是成员"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const { custom_name, ...change } = c.req.valid("json");
      await updateSettings(viewer.id, change);
      if (custom_name !== undefined)
        await setCustomName(actorOf(c, viewer), viewer.id, custom_name);
      return c.json(await settingsJson(viewer.id), 200);
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
