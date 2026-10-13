import { createRoute, z } from "@hono/zod-openapi";
import { actorOf, authorize, createRouter, errorResponse } from "../../platform/http.ts";
import { sendMail } from "../../platform/mail.ts";
import { getSettings } from "../../platform/settings.ts";
import { memberStats } from "../users/service.ts";
import { updateSettings } from "./service.ts";

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
      summary: "概览：成员数、已激活和已冻结的人数",
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
              }),
            },
          },
        },
        403: errorResponse("不是管理员"),
      },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json({ members: await memberStats() }, 200);
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
