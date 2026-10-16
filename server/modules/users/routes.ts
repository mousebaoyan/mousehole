import { readFile } from "node:fs/promises";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../../platform/errors.ts";
import { isMember, reachOf, restrictionOf, type Restriction } from "../../platform/access.ts";
import { env } from "../../platform/env.ts";
import { SITE_NAME, STAFF } from "../../platform/site.ts";
import {
  actorOf,
  authorize,
  authorizePosting,
  clientIp,
  createRouter,
  errorResponse,
  requireWeb,
  unix,
} from "../../platform/http.ts";
import { signedUnsubscribe } from "../../platform/mail.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import { getSettings as getSiteSettings } from "../../platform/settings.ts";
import { UserBriefSchema, UserRefSchema } from "./schemas.ts";
import { coinBalance } from "../coins/service.ts";
import { setCustomName } from "../members/service.ts";
import { NOTIFICATION_TYPES, notifyPrefs } from "../notifications/service.ts";
import { exportOwnBoosts } from "../reactions/service.ts";
import { exportOwnPosts, listPins } from "../threads/service.ts";
import { backgroundOf, BACKGROUNDS_DIR, backgroundUrls, uploadBackground } from "./backgrounds.ts";
import {
  BACKGROUND_PRESETS,
  BACKGROUNDS,
  CLEARABLE,
  FRAMES,
  PINS_MAX,
  reaches,
  SHOWCASE_MAX,
  STATUS_MAX,
  THEMES,
  unlockedFrames,
  UPLOAD_LEVEL,
} from "./customization.ts";
import {
  assertRelationsShown,
  AVATARS_DIR,
  buyLook,
  clearCustomization,
  findUserId,
  getProfile,
  getSettings,
  getShowcase,
  getUser,
  listMembers,
  listPeople,
  MAX_BIO,
  RELATION_LISTS,
  restoreQqAvatar,
  searchUsers,
  setEndorsement,
  setFollow,
  setQqBio,
  updateSettings,
  uploadAvatar,
} from "./service.ts";

const MeSchema = z
  .object({
    id: z.number(),
    display_name: z.string(),
    avatar_url: z.string().nullable(),
    role: z.string(),
    level: z.number(),
    qq: z.number().nullable().openapi({ description: "站长账号没有 QQ 号，为 null" }),
    member_status: z.string(),
    activated: z.boolean(),
    coins: z.number().openapi({ description: "鼠币余额" }),
  })
  .openapi("Me");

// Behind a card and a page (design §8.16): a preset, or their own picture cut for each.
const BackgroundUrls = z.object({ card_url: z.string(), profile_url: z.string() });
const BackgroundSchema = z
  .union([z.object({ preset: z.enum(BACKGROUNDS), moving: z.boolean() }), BackgroundUrls])
  .nullable()
  .openapi({
    description:
      "背景：预设的 { preset, moving }，moving 是兑换了动态版；或上传的两张图。没有为 null",
  });

const UserSchema = UserBriefSchema.extend({
  members_only: z.literal(false),
  bio: z.string(),
  theme: z.string().nullable().openapi({ description: "主题色；null 是默认的海青" }),
  background: BackgroundSchema,
  card: z.string().nullable().optional().openapi({
    description:
      "群名片，取自主群，不在主群时取最早加入的群，都不在为 null；这一项和下面两项只给成员和 bot",
  }),
  joined_at: z.number().nullable().optional().openapi({ description: "加入这个群的时间" }),
  last_sent_at: z
    .number()
    .nullable()
    .optional()
    .openapi({ description: "最近一次在这个群发言，精确到小时" }),
  qq: z.number().nullable().optional().openapi({
    description:
      "qq 只给成员和 bot，站点设置为公开时也给访客，站长账号为 null；member_status、activated 只给成员和 bot",
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
  relations_public: z
    .boolean()
    .optional()
    .openapi({ description: "TA 是否公开赞和关系；只给成员" }),
  badges: z.array(z.object({ id: z.number(), name: z.string(), tier: z.string() })).openapi({
    description: "TA 选的展示徽章，按选的顺序；没选过的最多 3 枚，金的在前，同档的最近得到的在前",
  }),
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
    people_reached: z.number().openapi({ description: "帮到的人：读过 TA 至少一层的人数" }),
    reads: z.number().openapi({ description: "被读次数：别人第一次读到 TA 的一层算一次" }),
    reads_week: z.number().optional().openapi({ description: "最近 7 天的被读次数，只给本人" }),
  }),
}).openapi("User");

// What guests get of someone who keeps their content from them (design §8.10).
const MembersOnlyUserSchema = UserBriefSchema.extend({ members_only: z.literal(true) }).openapi(
  "MembersOnlyUser",
);

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

const Switches = z.object({
  site: z.boolean(),
  email: z.boolean().nullable().openapi({ description: "null：站长不允许这类通知发邮件" }),
});

const AvatarSchema = z.object({ avatar_url: z.string().nullable() });

const SettingsSchema = z
  .object({
    custom_name: z.string().nullable().openapi({ description: "自己起的名字；null 是跟着 QQ" }),
    custom_bio: z.string().nullable().openapi({ description: "自己写的个性签名；null 是跟着 QQ" }),
    qq_bio: z.string().openapi({ description: "QQ 的个性签名，由 bot 推送" }),
    avatar_custom: z.boolean().openapi({ description: "头像是自己上传的；false 是跟着 QQ" }),
    allow_proxy: z.boolean().openapi({ description: "是否允许 bot 代自己发帖、回复等" }),
    hide_from_guests: z.boolean().openapi({ description: "我的内容不给访客看" }),
    relations_public: z
      .boolean()
      .openapi({ description: "公开我的赞和关系：赞过、概要里的名单、关注和认可的名单" }),
    title_badge_id: z
      .number()
      .nullable()
      .openapi({ description: "当头衔的徽章；null 是 QQ 的专属头衔" }),
    title_badges: z
      .array(z.object({ id: z.number(), name: z.string(), tier: z.string() }))
      .openapi({ description: "能当头衔的徽章：自己得到的金徽章和银徽章" }),
    shown_badge_ids: z
      .array(z.number())
      .nullable()
      .openapi({ description: "资料卡上展示的徽章，按顺序；null 是没选过，按默认规则" }),
    badges: z
      .array(z.object({ id: z.number(), name: z.string(), tier: z.string() }))
      .openapi({ description: "自己得到的全部徽章，选展示徽章用" }),
    theme: z.string().nullable().openapi({ description: "主题色；null 是默认的海青" }),
    background: z
      .string()
      .nullable()
      .openapi({ description: "背景：预设的 key，上传的为 custom，没有为 null" }),
    background_urls: BackgroundUrls.nullable().openapi({ description: "上传的背景，没有为 null" }),
    frame: z.string().nullable().openapi({ description: "头像框；null 是不用" }),
    unlocked: z.object({
      backgrounds: z.array(z.string()).openapi({ description: "能选的预设背景" }),
      frames: z.array(z.string()).openapi({ description: "能选的头像框" }),
      upload: z.boolean().openapi({ description: "能不能上传自己的背景" }),
    }),
    owned: z
      .object({ backgrounds: z.array(z.string()), frames: z.array(z.string()) })
      .openapi({ description: "兑换了的动态版，key 的列表；上传背景的为 custom" }),
    coins: z.number().openapi({ description: "鼠币余额" }),
    user_status: z
      .object({ emoji: z.string(), text: z.string(), until: z.number().nullable() })
      .nullable()
      .openapi({ description: "状态；until 是自动清除的时间，null 是不清除" }),
    pins: z
      .array(z.object({ id: z.number(), title: z.string() }))
      .openapi({ description: "代表作，按顺序；删除、隐藏了的不在里面" }),
    showcase: z.string().nullable().openapi({ description: "展柜的 Markdown 原文" }),
    weekly_email: z.boolean().openapi({ description: "收每周影响力邮件" }),
    notify_email: z
      .boolean()
      .openapi({ description: "邮件提醒的总开关；关掉后哪类通知都不发邮件" }),
    notify_prefs: z.record(z.string(), Switches).openapi({
      description: "每类通知的站内（site）和邮件（email）开关；自己没改过的跟着站长设的默认值",
    }),
  })
  .openapi("MySettings");

async function settingsJson(userId: number) {
  const { level, role, background_version, badge_unlocks, looks, ...settings } =
    await getSettings(userId);
  return {
    ...settings,
    background_urls:
      settings.background === "custom" ? backgroundUrls(userId, background_version) : null,
    unlocked: {
      backgrounds: BACKGROUNDS.filter((key) =>
        reaches({ level, role }, BACKGROUND_PRESETS[key].level),
      ),
      frames: unlockedFrames({ level, role }, badge_unlocks),
      upload: reaches({ level, role }, UPLOAD_LEVEL),
    },
    owned: {
      backgrounds: looks.filter((l) => l.kind === "background").map((l) => l.key),
      frames: looks.filter((l) => l.kind === "frame").map((l) => l.key),
    },
    coins: await coinBalance(userId),
    notify_prefs: await notifyPrefs(settings.notify_prefs),
  };
}

// A region of a picture, as "x,y,width,height" in pixels.
const Region = z
  .string()
  .regex(/^\d{1,5},\d{1,5},[1-9]\d{0,4},[1-9]\d{0,4}$/, "裁剪的区域格式不正确")
  .transform((v) => {
    const [left, top, width, height] = v.split(",").map(Number);
    return { left, top, width, height };
  });

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
      summary:
        "按名字或 QQ 号找成员，最多 8 个：QQ 号正好是它的在前，再是名字以它开头的，再按最近活跃；编辑器的 @ 补全用",
      request: { query: z.object({ q: z.string().trim().min(1).max(20) }) },
      responses: {
        200: {
          description: "找到的成员",
          content: {
            "application/json": {
              schema: z.object({ items: z.array(UserBriefSchema.extend({ qq: z.number() })) }),
            },
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
        200: {
          description: "用户；本人设置了不给访客看时，访客只拿到名字和头像，members_only 为 true",
          content: {
            "application/json": {
              schema: z.discriminatedUnion("members_only", [UserSchema, MembersOnlyUserSchema]),
            },
          },
        },
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const { viewer, bot } = c.var;
      const u = await getUser(c.req.valid("param").user, viewer?.id ?? null);
      const members = isMember(viewer, bot);
      const brief = {
        id: u.id,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        role: u.role,
        level: u.level,
        frame: u.frame,
      };
      if (u.hide_from_guests && !members) {
        return c.json(
          { ...brief, title: "", title_tier: null, user_status: null, members_only: true as const },
          200,
        );
      }
      const { site } = await getSiteSettings();
      return c.json(
        {
          ...brief,
          members_only: false as const,
          title: u.title,
          title_tier: u.title_tier,
          user_status: u.user_status,
          bio: u.bio,
          theme: u.theme,
          background: backgroundOf(u.id, u.background, u.background_version, u.background_bought),
          badges: u.badges,
          // Like a group's member list, which people outside it can't see, unless the site
          // shows QQ numbers to everyone.
          ...((members || site.qq_public) && { qq: u.qq }),
          ...(members && {
            card: u.card,
            joined_at: u.joined_at && unix(u.joined_at),
            last_sent_at: u.last_sent_at && unix(u.last_sent_at),
            member_status: u.member_status,
            activated: u.activated_at !== null,
            relations_public: u.relations_public,
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
            people_reached: u.people_reached,
            reads: u.reads_received,
            ...(viewer?.id === u.id && { reads_week: u.reads_week }),
          },
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}/showcase",
      summary: "个人主页上的展柜和代表作（总体设计 §8.16）",
      request: { params: UserParam },
      responses: {
        200: {
          description: "看的人打不开的代表作不在里面；TA 不给访客看时，访客拿到的都是空的",
          content: {
            "application/json": {
              schema: z.object({
                showcase_html: z.string().nullable(),
                pins: z.array(
                  z.object({
                    id: z.number(),
                    title: z.string(),
                    board: z.object({ slug: z.string(), name: z.string(), color: z.string() }),
                    reply_count: z.number(),
                    like_count: z.number(),
                  }),
                ),
              }),
            },
          },
        },
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const { viewer, bot } = c.var;
      const shown = await getShowcase(c.req.valid("param").user);
      if (shown.hide_from_guests && !isMember(viewer, bot)) {
        return c.json({ showcase_html: null, pins: [] }, 200);
      }
      const pins = shown.pins.length > 0 ? await listPins(reachOf(viewer, bot), shown.pins) : [];
      return c.json(
        {
          showcase_html: shown.html,
          pins: pins.map((t) => ({
            id: t.id,
            title: t.title,
            board: { slug: t.board_slug, name: t.board_name, color: t.board_color },
            reply_count: t.reply_count,
            like_count: t.like_count,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/users/{user}/customization/{item}",
      summary: "清除不合适的状态或展柜，理由必填，记操作日志（总体设计 §8.16）",
      request: {
        params: UserParam.extend({ item: z.enum(CLEARABLE) }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ reason: z.string().trim().min(1).max(200) }),
            },
          },
        },
      },
      responses: {
        204: { description: "已清除" },
        403: errorResponse("不是版主"),
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      const { user, item } = c.req.valid("param");
      await clearCustomization(actorOf(c, viewer), user, item, c.req.valid("json").reason);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}/relations",
      summary:
        "TA 关注的人（following）、TA 的粉丝（followers）、TA 认可的人（endorsing）、认可 TA 的人（endorsers），最新的在前，每页 50 个",
      request: {
        params: UserParam,
        query: z.object({
          list: z.enum(RELATION_LISTS),
          cursor: z.coerce.number().int().optional().openapi({ description: "已经列出的人数" }),
        }),
      },
      responses: {
        200: {
          description: "关掉了公开的人不在名单里",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(z.object({ user: UserBriefSchema, created_at: z.number() })),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        403: errorResponse("不是成员，或者 TA 没有公开（relations_hidden）"),
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "read");
      if (!isMember(viewer, c.var.bot)) throw new AppError(403, "forbidden", "仅成员可查看");
      const userId = await findUserId(c.req.valid("param").user);
      await assertRelationsShown(viewer.id, userId);
      const { list, cursor } = c.req.valid("query");
      const page = await listPeople(userId, list, cursor ?? 0);
      return c.json(
        {
          items: page.items.map((p) => ({ user: p.user, created_at: unix(p.created_at) })),
          next_cursor: page.next === null ? null : String(page.next),
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
      summary:
        "修改自己的设置，只改带了的字段；notify_prefs 里也只改带了的开关，没改过的开关跟着站长设的默认值",
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
                custom_bio: z
                  .string()
                  .trim()
                  .max(MAX_BIO)
                  .nullable()
                  .optional()
                  .openapi({ description: "最多 60 个字；null 是改回跟着 QQ" }),
                allow_proxy: z.boolean().optional(),
                hide_from_guests: z.boolean().optional(),
                relations_public: z.boolean().optional(),
                title_badge_id: z
                  .number()
                  .int()
                  .nullable()
                  .optional()
                  .openapi({ description: "自己得到的金徽章或银徽章；null 改回 QQ 的专属头衔" }),
                shown_badge_ids: z
                  .array(z.number().int())
                  .max(3)
                  .refine((ids) => new Set(ids).size === ids.length, "展示徽章不能重复")
                  .nullable()
                  .optional()
                  .openapi({
                    description: "最多 3 枚自己得到的徽章，按顺序；[] 是不展示，null 改回默认规则",
                  }),
                theme: z
                  .enum(THEMES)
                  .nullable()
                  .optional()
                  .openapi({ description: "null 改回默认" }),
                frame: z.enum(FRAMES).nullable().optional().openapi({ description: "null 是不用" }),
                background: z.enum(BACKGROUNDS).nullable().optional().openapi({
                  description: "预设背景的 key，null 是不用背景；上传的用 PUT /me/background",
                }),
                user_status: z
                  .object({
                    emoji: z
                      .string()
                      .max(32)
                      .refine(
                        (e) =>
                          [...new Intl.Segmenter().segment(e)].length === 1 &&
                          /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(e),
                        "请选择一个表情",
                      ),
                    text: z.string().trim().min(1).max(STATUS_MAX),
                    until: z.number().int().nullable(),
                  })
                  .nullable()
                  .optional()
                  .openapi({
                    description:
                      "表情加一句话，until 是自动清除的 Unix 秒，null 是不清除；整个为 null 是清除状态",
                  }),
                pins: z
                  .array(z.number().int())
                  .max(PINS_MAX)
                  .refine((ids) => new Set(ids).size === ids.length, "代表作不能重复")
                  .optional()
                  .openapi({ description: "代表作：自己公开发布的帖子 ID，按顺序" }),
                showcase: z
                  .string()
                  .trim()
                  .min(1)
                  .max(SHOWCASE_MAX)
                  .nullable()
                  .optional()
                  .openapi({ description: "展柜的 Markdown，null 是不要展柜" }),
                weekly_email: z.boolean().optional(),
                notify_email: z.boolean().optional(),
                notify_prefs: z
                  .partialRecord(
                    z.enum(NOTIFICATION_TYPES),
                    z.object({ site: z.boolean().optional(), email: z.boolean().optional() }),
                  )
                  .optional(),
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
        400: errorResponse(
          "不是自己的金徽章或银徽章，展示了没得到的徽章，或者代表作不是自己公开的帖子",
        ),
        403: errorResponse("不是成员，或者选了还没解锁的背景、头像框（cosmetic_locked）"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const { custom_name, ...change } = c.req.valid("json");
      await updateSettings(actorOf(c, viewer), change);
      if (custom_name !== undefined)
        await setCustomName(actorOf(c, viewer), viewer.id, custom_name);
      return c.json(await settingsJson(viewer.id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/mail/unsubscribe",
      summary:
        "按邮件里的退订链接关掉一类邮件，不用登录：通知类型或 weekly（每周来信），和在设置里关一样",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                user_id: z.number().int(),
                kind: z.enum([...NOTIFICATION_TYPES, "weekly"]),
                sig: z.string().max(64),
              }),
            },
          },
        },
      },
      responses: {
        204: { description: "已关闭" },
        400: errorResponse("链接无效"),
      },
    }),
    async (c) => {
      const { user_id, kind, sig } = c.req.valid("json");
      if (!signedUnsubscribe(user_id, kind, sig)) {
        throw new AppError(400, "unsubscribe_invalid", "退订链接无效，请在设置中关闭邮件提醒");
      }
      const actor = {
        userId: user_id,
        operatorId: null,
        tokenId: null,
        ip: clientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
      };
      await updateSettings(
        actor,
        kind === "weekly"
          ? { weekly_email: false }
          : { notify_prefs: { [kind]: { email: false } } },
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/me/avatar",
      summary: "上传头像：multipart 的 file 字段，最大 20MB，裁成 96px 的方图；之后不再跟着 QQ",
      request: {
        body: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: z.object({
                file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
              }),
            },
          },
        },
      },
      responses: {
        200: { description: "新头像", content: { "application/json": { schema: AvatarSchema } } },
        400: errorResponse("不是能识别的图片"),
        413: errorResponse("超过 20MB"),
        429: errorResponse("上传太频繁"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      rateLimit(`upload:${viewer.id}`, 30, 10 * 60_000);
      const file = Buffer.from(await c.req.valid("form").file.arrayBuffer());
      return c.json({ avatar_url: await uploadAvatar(actorOf(c, viewer), file) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/me/background",
      summary:
        "上传背景：multipart 的 file 字段，格式同图片上传；card、profile 是在转正后的原图上裁的区域「x,y,宽,高」，资料卡 2:1、主页 3:1",
      request: {
        body: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: z.object({
                file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
                card: Region,
                profile: Region,
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "两张背景的地址",
          content: { "application/json": { schema: BackgroundUrls } },
        },
        400: errorResponse("不是能识别的图片，裁的区域超出图片，或者动图太大"),
        403: errorResponse("还没到能上传背景的等级"),
        413: errorResponse("超过 20MB"),
        429: errorResponse("上传太频繁"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      rateLimit(`background:${viewer.id}`, 10, 60 * 60_000);
      const { file, card, profile } = c.req.valid("form");
      const picture = Buffer.from(await file.arrayBuffer());
      return c.json(await uploadBackground(actorOf(c, viewer), picture, { card, profile }), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/me/looks",
      summary: "用鼠币兑换动态版并换上；上传背景的（key 为 custom）兑换后可以上传动图，不换背景",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.discriminatedUnion("kind", [
                z.object({
                  kind: z.literal("background"),
                  key: z.enum([...BACKGROUNDS, "custom"]),
                }),
                z.object({ kind: z.literal("frame"), key: z.enum(FRAMES) }),
              ]),
            },
          },
        },
      },
      responses: {
        200: {
          description: "改好的设置",
          content: { "application/json": { schema: SettingsSchema } },
        },
        400: errorResponse("这一款没有动态版"),
        403: errorResponse(
          "还没够得上这一款的等级（cosmetic_locked），或者鼠币不够（coins_insufficient）",
        ),
        409: errorResponse("兑换过了"),
      },
    }),
    async (c) => {
      requireWeb(c);
      const viewer = authorize(c, "act");
      await buyLook(actorOf(c, viewer), c.req.valid("json"));
      return c.json(await settingsJson(viewer.id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/me/avatar",
      summary: "头像改回跟着 QQ，立刻拉一次 QQ 头像",
      responses: {
        200: { description: "QQ 头像", content: { "application/json": { schema: AvatarSchema } } },
        502: errorResponse("QQ 头像获取失败"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      return c.json({ avatar_url: await restoreQqAvatar(actorOf(c, viewer)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/bot/users/{user}/bio",
      summary:
        "推送 QQ 的个性签名，超过 60 个字的截掉；本人没写过自己的就显示它。成员第一次登录（member.activated）时推送",
      request: {
        params: UserParam,
        body: {
          required: true,
          content: { "application/json": { schema: z.object({ bio: z.string().max(1000) }) } },
        },
      },
      responses: { 204: { description: "已更新" }, 404: errorResponse("用户不存在") },
    }),
    async (c) => {
      const viewer = authorize(c, "sync");
      const userId = await findUserId(c.req.valid("param").user);
      await setQqBio(actorOf(c, viewer), userId, c.req.valid("json").bio);
      return c.body(null, 204);
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
      const { id } = authorize(c, "read");
      const { activated_at, ...profile } = await getProfile(id);
      return c.json(
        { ...profile, activated: activated_at !== null, coins: await coinBalance(id) },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/members",
      summary:
        "成员列表，新建的在前，每页 50 个：按名字或 QQ 号找，按成员资格、角色、等级、是否受限筛选",
      request: {
        query: z.object({
          q: z.string().trim().min(1).max(30).optional(),
          status: z.enum(["member", "frozen"]).optional(),
          role: z.enum(["user", "moderator", "admin", "owner", "bot"]).optional(),
          level: z.coerce.number().int().min(0).max(5).optional(),
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
                    level: z.number(),
                    level_locked: z.boolean(),
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

const SITE = new URL(env.PUBLIC_URL).origin;

// Registered ahead of sessions in app.ts, as avatars are. Larger than avatars, so like uploaded
// images, other sites' pages may not show them (design §11.2).
export async function serveBackground(c: Context) {
  const referer = c.req.header("referer");
  if (referer !== undefined && URL.parse(referer)?.origin !== SITE) {
    throw new AppError(403, "forbidden", `背景只能在${SITE_NAME}的页面里显示`);
  }
  const file = await readFile(`${BACKGROUNDS_DIR}/${c.req.param("file")}`).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new AppError(404, "not_found", "背景不存在");
      }
      throw error;
    },
  );
  return c.body(file, 200, {
    "content-type": "image/webp",
    "cache-control": "public, max-age=31536000, immutable",
  });
}

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
