import { createRoute, z } from "@hono/zod-openapi";
import { actorOf, authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { sendMail } from "../../platform/mail.ts";
import { getSettings } from "../../platform/settings.ts";
import { botListening } from "../events/service.ts";
import { countOpenReports } from "../moderation/service.ts";
import { contentStats } from "../threads/service.ts";
import { uploadBytes } from "../uploads/service.ts";
import { memberStats } from "../users/service.ts";
import { databaseBytes, updateSettings } from "./service.ts";

const LoginSettings = z.object({
  code: z.boolean(),
  link: z.boolean(),
  email: z.boolean(),
  code_hint: z.string().max(100),
});

const SmtpSettings = z.object({
  host: z.string().max(200),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(200),
  from: z.string().max(200),
});

const BotSettings = z.object({ require_operator: z.boolean() });

const SettingsSchema = z
  .object({
    login: LoginSettings,
    smtp: SmtpSettings.extend({ password_set: z.boolean() }),
    bot: BotSettings,
  })
  .openapi("Settings");

export const adminRoutes = createRouter()
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
                  threads_today: z.number().openapi({ description: "今天（北京时间）公开的主题" }),
                  posts_today: z.number().openapi({ description: "今天公开的回复" }),
                  pending: z.number().openapi({ description: "待审核的主题和回复" }),
                  reports: z.number().openapi({ description: "待处理的举报" }),
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
      const [members, content, reports, database, uploads] = await Promise.all([
        memberStats(),
        contentStats(),
        countOpenReports(),
        databaseBytes(),
        uploadBytes(),
      ]);
      const events = botListening();
      return c.json(
        {
          members,
          content: { ...content, reports },
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
        403: errorResponse("不是管理员"),
      },
    }),
    async (c) => {
      authorize(c, "admin");
      const { login, smtp, bot } = await getSettings();
      const { password, ...rest } = smtp;
      return c.json({ login, smtp: { ...rest, password_set: password !== "" }, bot }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/settings",
      summary: "修改站点设置，立即生效；只改带了的字段，SMTP 密码不带就不变、传空字符串清空",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                login: LoginSettings.partial().optional(),
                smtp: SmtpSettings.extend({ password: z.string().max(200) })
                  .partial()
                  .optional(),
                bot: BotSettings.partial().optional(),
              }),
            },
          },
        },
      },
      responses: { 204: { description: "已保存" }, 403: errorResponse("不是管理员") },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      await updateSettings(actorOf(c, viewer), c.req.valid("json"));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/settings/test-email",
      summary: "用当前 SMTP 设置给 QQ号@qq.com 发一封测试邮件",
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: z.object({ qq: z.number().int().min(10000) }) },
          },
        },
      },
      responses: {
        204: { description: "已发送" },
        403: errorResponse("不是管理员"),
        502: errorResponse("发送失败，SMTP 设置可能有误"),
        503: errorResponse("邮件服务还没有配置"),
      },
    }),
    async (c) => {
      authorize(c, "admin");
      await sendMail(`${c.req.valid("json").qq}@qq.com`, "鼠洞测试邮件", "SMTP 设置可以正常发信。");
      return c.body(null, 204);
    },
  );
