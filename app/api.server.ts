import { hc } from "hono/client";
import { createContext } from "react-router";
import { app, type ApiType } from "../server/app.ts";

const FORWARDED = ["cookie", "user-agent", "x-real-ip", "origin"];

// Loaders and actions call /api/v1 in-process as the visitor, so pages can do nothing a bot can't.
export function createApi(request: Request) {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return hc<ApiType>("http://localhost/api/v1", {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init),
    headers,
  });
}

export const apiContext = createContext<ReturnType<typeof createApi>>();

// Login and logout responses carry the session cookie, which has to reach the browser.
export function cookiesFrom(res: Response) {
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
}
