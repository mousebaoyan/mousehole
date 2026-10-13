import { app } from "../server/app.ts";
import { issueLoginLink } from "../server/modules/auth/service.ts";
import { db } from "../server/platform/db.ts";
import { env } from "../server/platform/env.ts";

let lastQq = 10000;

export function nextQq() {
  return ++lastQq;
}

export async function createUser(role: "user" | "moderator" | "admin" = "user") {
  const qq = nextQq();
  const { id } = await db
    .insertInto("users")
    .values({ qq, display_name: "鼠鼠", role })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id, qq };
}

export function sessionCookie(res: Response) {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith("session="))
    ?.split(";")[0];
}

// Browsers send Origin with every POST and DELETE; the CSRF check relies on it.
export function as(cookie: string) {
  return { headers: { cookie, origin: env.PUBLIC_URL } };
}

export async function login(userId: number) {
  const token = await issueLoginLink(userId);
  const res = await app.request("/api/v1/auth/link", {
    method: "POST",
    headers: { "content-type": "application/json", origin: env.PUBLIC_URL },
    body: JSON.stringify({ token }),
  });
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error(`login failed: ${res.status}`);
  return cookie;
}
