import { RouterContextProvider } from "react-router";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { SecureHeadersVariables } from "hono/secure-headers";
import { createHonoServer } from "react-router-hono-server/node";
import { apiContext, createApi } from "../app/api.server.ts";
import { nonceContext } from "../app/nonce.ts";
import { app } from "./app.ts";
import { clearExpiredLogins } from "./modules/auth/service.ts";
import { checkBadges, syncBadges } from "./modules/badges/service.ts";
import { clearOldDrafts } from "./modules/drafts/service.ts";
import { clearOldEvents, EVENTS_CHANNEL, eventsArrived } from "./modules/events/service.ts";
import {
  clearOldNotifications,
  NOTIFICATIONS_CHANNEL,
  unreadChanged,
} from "./modules/notifications/service.ts";
import { promoteActive, recheckL4 } from "./modules/levels/service.ts";
import { indexMissingPosts } from "./modules/search/service.ts";
import { drawDue } from "./modules/threads/lotteries.ts";
import { flushViews, recordView } from "./modules/threads/service.ts";
import { clearUnusedUploads } from "./modules/uploads/service.ts";
import { clearOldDays, refreshAvatars } from "./modules/users/service.ts";
import { compressResponses } from "./platform/compress.ts";
import { clientIp, type AppEnv } from "./platform/http.ts";
import { guestPages } from "./platform/page-cache.ts";
import { atPublicOrigin } from "./platform/public-origin.ts";
import { securityHeaders } from "./platform/security-headers.ts";
import { listen } from "./platform/db.ts";
import { log } from "./platform/log.ts";
import { clearIdempotencyKeys } from "./platform/idempotency.ts";
import { MAIL_CHANNEL, sendQueued } from "./platform/mail.ts";
import { migrate } from "./platform/migrate.ts";
import { every } from "./platform/schedule.ts";

await migrate();
await syncBadges();
listen({
  [EVENTS_CHANNEL]: eventsArrived,
  [NOTIFICATIONS_CHANNEL]: unreadChanged,
  [MAIL_CHANNEL]: () => void sendQueued(),
});
indexMissingPosts().catch((error: unknown) => log("error", "Indexing posts failed", { error }));
every(60_000, "Writing view counts", flushViews);
every(60_000, "Drawing lotteries", drawDue);
every(60_000, "Sending queued mail", sendQueued);
every(60_000, "Refreshing avatars", refreshAvatars);
every(5 * 60_000, "Checking badges", checkBadges);
every(3600_000, "Raising levels", promoteActive);
const DAY_MS = 24 * 3600_000;
every(DAY_MS, "Clearing unused uploads", clearUnusedUploads);
every(DAY_MS, "Clearing expired logins", clearExpiredLogins);
every(DAY_MS, "Clearing old idempotency keys", clearIdempotencyKeys);
every(DAY_MS, "Clearing old notifications", clearOldNotifications);
every(DAY_MS, "Clearing old events", clearOldEvents);
every(DAY_MS, "Clearing old drafts", clearOldDrafts);
every(DAY_MS, "Rechecking L4", recheckL4);
every(DAY_MS, "Clearing old active days", clearOldDays);

// A thread served from the guest page cache skips the loader that counts its view.
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

// The app's middleware runs for pages too, so they know their visitor.
export default await createHonoServer<{ Variables: SecureHeadersVariables & AppEnv["Variables"] }>({
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
    // Only the pages, which React Router serves after these routes.
    server.use(atPublicOrigin);
  },
  getLoadContext(c) {
    const context = new RouterContextProvider();
    context.set(
      apiContext,
      createApi(c.req.raw, { viewer: c.var.viewer, sessionId: c.var.sessionId }),
    );
    context.set(nonceContext, c.get("secureHeadersNonce"));
    return context;
  },
});
