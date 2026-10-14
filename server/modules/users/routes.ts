import { readFile } from "node:fs/promises";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../../platform/errors.ts";
import { isMember, restrictionOf, STAFF, type Restriction } from "../../platform/access.ts";
import {
  actorOf,
  authorize,
  createRouter,
  errorResponse,
  requireWeb,
  unix,
} from "../../platform/http.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import { getSettings as getSiteSettings } from "../../platform/settings.ts";
import { UserBriefSchema, UserRefSchema } from "./schemas.ts";
import { setCustomName } from "../members/service.ts";
import { NOTIFICATION_TYPES, notifyPrefs } from "../notifications/service.ts";
import { exportOwnBoosts } from "../reactions/service.ts";
import { exportOwnPosts } from "../threads/service.ts";
import {
  AVATARS_DIR,
  getProfile,
  getSettings,
  getUser,
  listMembers,
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
  qq: z.number().optional().openapi({
    description:
      "qq 只给成员和 bot，站点设置为公开时也给访客；member_status、activated 只给成员和 bot",
  }),
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

const ExportSchema = z.object({
  exported_at: z.number(),
  user: z.object({
    id: z.number(),
    qq: z.number().nullable(),
    display_name: z.string(),
    bio: z.string(),
  }),
  posts: z.array(
    z.object({
      id: z.number(),
      thread_id: z.number(),
      title: z.string(),
      board: z.string(),
      floor: z.number().openapi({ description: "1 是主楼，也就是自己发的帖子" }),
      body: z.string().openapi({ description: "Markdown 原文" }),
      status: z.string(),
      created_at: z.number(),
      edited_at: z.number().nullable(),
    }),
  ),
  boosts: z.array(
    z.object({
      thread_id: z.number(),
      floor: z.number(),
      body: z.string(),
      created_at: z.number(),
    }),
  ),
  bookmarks: z.array(
    z.object({ thread_id: z.number(), title: z.string(), bookmarked_at: z.number().nullable() }),
  ),
});

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
  .openapi("MySettings");

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
      const { site } = await getSiteSettings();
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
          // Like a group's member list, which people outside it can't see, unless the site
          // shows QQ numbers to everyone.
          ...((members || site.qq_public) && { qq: u.qq }),
          ...(members && {
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
      summary: "关注某人：TA 发新帖时通知我",
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
      summary: "自己的设置：名字、个性签名、是否允许代发、通知开关",
      responses: {
        200: { description: "设置", content: { "application/json": { schema: SettingsSchema } } },
        401: errorResponse("没有登录"),
      },
    }),
    async (c) => c.json(await settingsJson(authorize(c, "read").id), 200),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/me/export",
      summary:
        "导出自己的全部内容，作为附件下载：资料、发过的主楼和回复（Markdown 原文，含待审核和已隐藏的）、短评和收藏；每小时最多 3 次，只能在网页上",
      responses: {
        200: {
          description: "JSON 文件",
          content: { "application/json": { schema: ExportSchema } },
        },
        401: errorResponse("没有登录"),
        403: errorResponse("bot 不能代为导出"),
        429: errorResponse("导出太频繁"),
      },
    }),
    async (c) => {
      const viewer = requireWeb(c);
      rateLimit(`export:${viewer.id}`, 3, 60 * 60_000);
      const [user, { posts, bookmarks }, boosts] = await Promise.all([
        getUser({ id: viewer.id }, viewer.id),
        exportOwnPosts(viewer.id),
        exportOwnBoosts(viewer.id),
      ]);
      c.header("content-disposition", `attachment; filename="mousehole-${viewer.id}.json"`);
      return c.json(
        {
          exported_at: unix(new Date()),
          user: { id: user.id, qq: user.qq, display_name: user.display_name, bio: user.bio },
          posts: posts.map((p) => ({
            ...p,
            created_at: unix(p.created_at),
            edited_at: p.edited_at && unix(p.edited_at),
          })),
          boosts: boosts.map((b) => ({ ...b, created_at: unix(b.created_at) })),
          bookmarks: bookmarks.map((b) => ({
            ...b,
            bookmarked_at: b.bookmarked_at && unix(b.bookmarked_at),
          })),
        },
        200,
      );
    },
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
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/members",
      summary: "成员列表，新建的在前，每页 50 个：按名字或 QQ 号找，按成员资格、角色、是否受限筛选",
      request: {
        query: z.object({
          q: z.string().trim().min(1).max(30).optional(),
          status: z.enum(["member", "frozen"]).optional(),
          role: z.enum(["user", "moderator", "admin", "bot"]).optional(),
          restricted: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
          cursor: z.coerce.number().int().optional(),
        }),
      },
      responses: {
        200: {
          description: "成员",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    id: z.number(),
                    display_name: z.string(),
                    avatar_url: z.string().nullable(),
                    qq: z.number().nullable(),
                    role: z.string(),
                    role_locked: z.boolean(),
                    member_status: z.string(),
                    activated: z.boolean(),
                    restriction: z
                      .object({ type: z.string(), until: z.number().nullable() })
                      .nullable(),
                    last_seen_at: z.number().nullable(),
                    thread_count: z.number(),
                    post_count: z.number(),
                  }),
                ),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        403: errorResponse("不是版主"),
      },
    }),
    async (c) => {
      authorize(c, "moderate");
      const page = await listMembers(c.req.valid("query"));
      return c.json(
        {
          items: page.items.map(
            ({ activated_at, restriction, restricted_until, last_seen_at, ...m }) => ({
              ...m,
              activated: activated_at !== null,
              restriction: restrictionJson(restrictionOf(restriction, restricted_until)),
              last_seen_at: last_seen_at && unix(last_seen_at),
            }),
          ),
          next_cursor: page.next_cursor,
        },
        200,
      );
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
