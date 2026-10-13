import { z } from "zod";

export const env = z
  .object({
    DATABASE_URL: z.url(),
    // Kept as a bare origin, e.g. https://bbs.mousebaoyan.cn, so it compares with Origin headers.
    PUBLIC_URL: z.url().transform((url) => new URL(url).origin),
    // The AES-256 key for secrets in settings, used as is: 32 random bytes in base64.
    APP_SECRET: z
      .base64()
      .transform((s) => Buffer.from(s, "base64"))
      .refine((key) => key.length === 32, "应为 32 字节的 base64，用 openssl rand -base64 32 生成"),
  })
  .parse(process.env);
