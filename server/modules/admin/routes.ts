import { createRoute, z } from "@hono/zod-openapi";
import {
  actorOf,
  authorize,
  authorizeOwner,
  createRouter,
  errorResponse,
  unix,
} from "../../platform/http.ts";
import { testMailboxes } from "../../platform/mail.ts";
import { getSettings } from "../../platform/settings.ts";
import { botListening } from "../events/service.ts";
import { emailPolicies, NOTIFICATION_TYPES } from "../notifications/service.ts";
import { countOpenReports } from "../moderation/service.ts";
import { countOpenSuggestions } from "../threads/suggestions.ts";
import { contentStats } from "../threads/service.ts";
import { uploadBytes } from "../uploads/service.ts";
import { memberStats } from "../users/service.ts";
import { databaseBytes, updateSettings } from "./service.ts";

const SiteSettings = z.object({
  banner: z.string().trim().max(200).openapi({ description: "公告横幅，空字符串不显示" }),
  qq_public: z.boolean().openapi({ description: "访客也能看到 QQ 号" }),
  summaries: z.boolean().openapi({ description: "显示 AI 总结，并给插件派写总结的活" }),
});

const LoginSettings = z.object({
  code: z.boolean(),
  link: z.boolean(),
  email: z.boolean(),
  code_hint: z.string().max(100),
});

const SmtpAccount = z.object({
  host: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().min(1).max(200),
});

// Up to this many mailboxes to send from.
const MAX_MAILBOXES = 10;

const BotSettings = z.object({ require_operator: z.boolean() });

const EmailPolicy = z.enum(["on", "off", "never"]).openapi({
  description: "on：默认发邮件；off：默认不发，成员可以自己打开；never：不发，成员也不能打开",
});

const WeeklySettings = z
  .object({
    enabled: z.boolean().openapi({ description: "是否发每周影响力邮件" }),
    min_reads: z.number().int().min(0).max(10000).openapi({ description: "一周被读至少几次" }),
    min_likes: z.number().int().min(0).max(10000).openapi({ description: "同时获赞至少几次" }),
    top_likes: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .openapi({ description: "一层一周获赞至少几次才写进邮件" }),
  })
  .openapi({ description: "每周影响力邮件：被读和获赞都达到门槛，或者有回答被采纳，才发" });

const SettingsSchema = z
  .object({
    site: SiteSettings,
    login: LoginSettings,
    smtp: z.object({
      accounts: z
        .array(SmtpAccount.extend({ password_set: z.boolean() }))
        .openapi({ description: "发信邮箱，按顺序用，一个发不出去就换下一个" }),
    }),
    bot: BotSettings,
    notify: z.object({
      email: z
        .record(z.string(), EmailPolicy)
        .openapi({ description: "每类通知是否发邮件；成员没改过的按这里的默认" }),
      unactivated: z.boolean().openapi({ description: "没登录过论坛的成员也发通知邮件和每周来信" }),
    }),
    weekly: WeeklySettings,
  })
  .openapi("Settings");

export const adminRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/site",
      summary: "页面要用的站点设置：公告横幅",
      responses: {
        200: {
          description: "站点设置",
          content: { "application/json": { schema: z.object({ banner: z.string() }) } },
        },
      },
    }),
    async (c) => c.json({ banner: (await getSettings()).site.banner }, 200),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/overview",
      summary: "概览：成员、今天的内容、待处理的事、bot 的事件流和存储",
      responses: {
        200: {
          description: "群的同步状态见 /admin/groups",
          content: {
            "application/json": {
              schema: z.object({
                members: z.object({
                  total: z.number(),
                  activated: z.number(),
                  frozen: z.number(),
                }),
                content: z.object({
                  threads_today: z.number().openapi({ description: "今天（北京时间）公开的帖子" }),
                  posts_today: z.number().openapi({ description: "今天公开的回复" }),
                  pending: z.number().openapi({ description: "待审核的帖子和回复" }),
                  reports: z.number().openapi({ description: "待处理的举报" }),
                  suggestions: z.number().openapi({ description: "待处理的修改建议" }),
                }),
                events: z.object({
                  streams: z.number().openapi({ description: "现在连着的事件流" }),
                  polled_at: z
                    .number()
                    .nullable()
                    .openapi({ description: "最近一次按游标拉取事件的时间，进程重启后为 null" }),
                }),
                storage: z.object({
                  database: z.number().openapi({ description: "数据库占用的字节数" }),
                  uploads: z
                    .number()
                    .openapi({ description: "上传的图片占用的字节数，两种尺寸合计" }),
                }),
              }),
            },
          },
        },
        403: errorResponse("不是管理员"),
      },
    }),
    async (c) => {
      authorize(c, "admin");
      const [members, content, reports, suggestions, database, uploads] = await Promise.all([
        memberStats(),
        contentStats(),
        countOpenReports(),
        countOpenSuggestions(),
        databaseBytes(),
        uploadBytes(),
      ]);
      const events = botListening();
      return c.json(
        {
          members,
          content: { ...content, reports, suggestions },
          events: {
            streams: events.streams,
            polled_at: events.polled_at && unix(events.polled_at),
          },
          storage: { database, uploads },
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/settings",
      summary: "站点设置；密码只返回是否已设置",
      responses: {
        200: {
          description: "当前设置",
          content: { "application/json": { schema: SettingsSchema } },
        },
        403: errorResponse("不是站长，或者用 bot token 调用"),
      },
    }),
    async (c) => {
      authorizeOwner(c);
      const { site, login, smtp, bot, notify, weekly } = await getSettings();
      const accounts = smtp.accounts.map(({ password, ...rest }) => ({
        ...rest,
        password_set: password !== "",
      }));
      return c.json(
        {
          site,
          login,
          smtp: { accounts },
          bot,
          notify: { email: await emailPolicies(), unactivated: notify.unactivated },
          weekly,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/settings",
      summary:
        "修改站点设置，立即生效；只改带了的字段，notify.email 只改带了的类型。发信邮箱整组替换，某个邮箱不带密码就沿用这个账号原来的。改了什么记进操作日志，密码只记哪个邮箱改了",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                site: SiteSettings.partial().optional(),
                login: LoginSettings.partial().optional(),
                smtp: z
                  .object({
                    accounts: z
                      .array(SmtpAccount.extend({ password: z.string().max(200).optional() }))
                      .max(MAX_MAILBOXES),
                  })
                  .optional(),
                bot: BotSettings.partial().optional(),
                notify: z
                  .object({
                    email: z.partialRecord(z.enum(NOTIFICATION_TYPES), EmailPolicy).optional(),
                    unactivated: z.boolean().optional(),
                  })
                  .optional(),
                weekly: WeeklySettings.partial().optional(),
              }),
            },
          },
        },
      },
      responses: {
        204: { description: "已保存" },
        403: errorResponse("不是站长，或者用 bot token 调用"),
      },
    }),
    async (c) => {
      const viewer = authorizeOwner(c);
      await updateSettings(actorOf(c, viewer), c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/settings/test-email",
      summary: "每个发信邮箱各给 QQ号@qq.com 发一封测试邮件",
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: z.object({ qq: z.number().int().min(10000) }) },
          },
        },
      },
      responses: {
        200: {
          description: "每个邮箱的结果，按设置里的顺序",
          content: {
            "application/json": {
              schema: z.object({
                results: z.array(
                  z.object({
                    user: z.string(),
                    error: z.string().nullable().openapi({ description: "发送失败的原因" }),
                  }),
                ),
              }),
            },
          },
        },
        403: errorResponse("不是站长，或者用 bot token 调用"),
        503: errorResponse("邮件服务还没有配置"),
      },
    }),
    async (c) => {
      authorizeOwner(c);
      const results = await testMailboxes(`${c.req.valid("json").qq}@qq.com`);
      return c.json({ results }, 200);
    },
  );
