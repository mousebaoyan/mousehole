import { z } from "zod";

export const env = z
  .object({
    DATABASE_URL: z.url(),
    // Kept as a bare origin, e.g. https://bbs.mousebaoyan.cn, so it compares with Origin headers.
    PUBLIC_URL: z.url().transform((url) => new URL(url).origin),
  })
  .parse(process.env);
