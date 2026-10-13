import { createTransport } from "nodemailer";
import { AppError } from "./errors.ts";
import { getSettings } from "./settings.ts";

// Sends with the SMTP account from the admin settings. Called after transactions commit:
// a slow mail server must not hold database locks.
export async function sendMail(to: string, subject: string, text: string) {
  const { smtp } = await getSettings();
  if (!smtp.host) throw new AppError(503, "email_not_configured", "邮件服务还没有配置");
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({ from: smtp.from || smtp.user, to, subject, text });
  } catch (error) {
    throw new AppError(502, "email_failed", "邮件发送失败，请稍后再试", { cause: error });
  }
}
