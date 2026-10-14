import { RouterContextProvider } from "react-router";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { SecureHeadersVariables } from "hono/secure-headers";
import { createHonoServer } from "react-router-hono-server/node";
import { apiContext, createApi } from "../app/api.server.ts";
import { nonceContext } from "../app/nonce.ts";
import { app } from "./app.ts";
import { clearExpiredLogins } from "./modules/auth/service.ts";
import { clearOldEvents, EVENTS_CHANNEL, eventsArrived } from "./modules/events/service.ts";
import {
  clearOldNotifications,
  NOTIFICATIONS_CHANNEL,
  unreadChanged,
} from "./modules/notifications/service.ts";
import { indexMissingPosts } from "./modules/search/service.ts";
import { flushViews, recordView } from "./modules/threads/service.ts";
import { clearUnusedUploads } from "./modules/uploads/service.ts";
import { refreshAvatars } from "./modules/users/service.ts";
import { compressResponses } from "./platform/compress.ts";
import { clientIp } from "./platform/http.ts";
import { guestPages } from "./platform/page-cache.ts";
import { securityHeaders } from "./platform/security-headers.ts";
import { listen } from "./platform/db.ts";
import { log } from "./platform/log.ts";
import { clearIdempotencyKeys } from "./platform/idempotency.ts";
import { migrate } from "./platform/migrate.ts";
import { every } from "./platform/schedule.ts";

await migrate();
listen({ [EVENTS_CHANNEL]: eventsArrived, [NOTIFICATIONS_CHANNEL]: unreadChanged });
indexMissingPosts().catch((error: unknown) => log("error", "Indexing posts failed", { error }));
every(60_000, "Writing view counts", flushViews);
every(3600_000, "Refreshing avatars", refreshAvatars);
const DAY_MS = 24 * 3600_000;
every(DAY_MS, "Clearing unused uploads", clearUnusedUploads);
every(DAY_MS, "Clearing expired logins", clearExpiredLogins);
every(DAY_MS, "Clearing old idempotency keys", clearIdempotencyKeys);
every(DAY_MS, "Clearing old notifications", clearOldNotifications);
every(DAY_MS, "Clearing old events", clearOldEvents);

// A topic served from the guest page cache skips the loader that counts its view.
function countCachedView(c: Context) {
  const thread = /^\/t\/(\d+)/.exec(c.req.path)?.[1];
  const ip = clientIp(c);
  if (thread !== undefined && ip !== null) recordView(Number(thread), ip);
}

// The emoji data's path carries its version, so browsers may keep it; public files otherwise
// get an hour.
const cacheForAYear = createMiddleware(async (c, next) => {
  await next();
  c.res.headers.set("cache-control", "public, max-age=31536000, immutable");
});

// Docker stops the container with SIGTERM; the view counts not yet written go out first.
process.once("SIGTERM", () => {
  void flushViews().finally(() => process.exit(0));
});

export default await createHonoServer<{ Variables: SecureHeadersVariables }>({
  defaultLogger: false,
  listeningListener: ({ port }) => log("info", "Listening", { port }),
  // Before the static files, so they get the headers too; the guest page cache keeps pages
  // with theirs.
  beforeAll(server) {
    server.use(guestPages(server, countCachedView));
    server.use(securityHeaders);
    server.use("/emojibase/*", cacheForAYear);
  },
  // Built files have Brotli and gzip copies beside them; see scripts/compress-assets.ts.
  serveStaticOptions: {
    clientAssets: { precompressed: true },
    publicAssets: { precompressed: true },
  },
  configure(server) {
    server.use(compressResponses);
    server.route("/", app);
  },
  getLoadContext(c) {
    const context = new RouterContextProvider();
    context.set(apiContext, createApi(c.req.raw));
    context.set(nonceContext, c.get("secureHeadersNonce"));
    return context;
  },
});
