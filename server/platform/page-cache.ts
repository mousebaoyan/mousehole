import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { acceptedEncoding } from "./compress.ts";

// Pages as guests see them, kept briefly so a link shared in the group is rendered once rather
// than for each reader (design §11.3): a topic for 10 seconds, a list for 30, page data for
// navigating between them likewise. A stale page is still served while it renders afresh in the
// background. Pages are kept compressed, as sent, with the headers that went with them: the
// CSP's nonce among them matches the scripts in the page.
const PAGES: [RegExp, number][] = [
  [/^\/t\/\d+(?:\.data)?$/, 10_000],
  [/^\/(?:_root\.data|b\/[a-z0-9-]+(?:\.data)?)?$/, 30_000],
];

// Least recently served go first; each is some 10KB compressed.
const MAX_PAGES = 500;

type Page = {
  status: number;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
  staleAt: number;
  refreshing: boolean;
};

const pages = new Map<string, Page>();

// Requests the cache makes itself, to render a stale page afresh.
const refreshes = new WeakSet<Request>();

// `server` renders stale pages again; `onHit` does what a served page's loaders would have.
export function guestPages<E extends object>(server: Hono<E>, onHit: (c: Context) => void) {
  return createMiddleware(async (c, next) => {
    const ttl = PAGES.find(([path]) => path.test(c.req.path))?.[1];
    const encoding = acceptedEncoding(c);
    if (
      c.req.method !== "GET" ||
      ttl === undefined ||
      encoding === null ||
      getCookie(c, "session") !== undefined
    ) {
      return next();
    }
    const url = new URL(c.req.url);
    const key = `${encoding} ${url.pathname}${url.search}`;
    const page = pages.get(key);
    if (page && !refreshes.has(c.req.raw)) {
      onHit(c);
      pages.delete(key);
      pages.set(key, page);
      if (page.staleAt < Date.now() && !page.refreshing) {
        page.refreshing = true;
        const request = new Request(url, { headers: { "accept-encoding": encoding } });
        refreshes.add(request);
        void Promise.resolve(server.fetch(request))
          .then((res) => res.body?.cancel())
          .finally(() => {
            page.refreshing = false;
          });
      }
      return new Response(page.body, { status: page.status, headers: page.headers });
    }

    await next();
    // A page gone or changed to something not to keep, such as a hidden thread, goes.
    if (
      c.res.status !== 200 ||
      c.res.headers.has("set-cookie") ||
      c.res.headers.get("content-encoding") !== encoding
    ) {
      pages.delete(key);
      return;
    }
    const body = new Uint8Array(await c.res.arrayBuffer());
    pages.delete(key);
    pages.set(key, {
      status: 200,
      headers: new Headers(c.res.headers),
      body,
      staleAt: Date.now() + ttl,
      refreshing: false,
    });
    const oldest = pages.keys().next().value;
    if (pages.size > MAX_PAGES && oldest !== undefined) pages.delete(oldest);
    c.res = new Response(body, c.res);
  });
}
