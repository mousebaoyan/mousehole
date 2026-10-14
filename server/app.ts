import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { sql } from "kysely";
import { adminRoutes } from "./modules/admin/routes.ts";
import { auditRoutes } from "./modules/audit/routes.ts";
import { authenticate, authRoutes, bearerToken } from "./modules/auth/routes.ts";
import { tokenRoutes } from "./modules/auth/token-routes.ts";
import { boardsRoutes } from "./modules/boards/routes.ts";
import { draftsRoutes } from "./modules/drafts/routes.ts";
import { eventsRoutes } from "./modules/events/routes.ts";
import { membersRoutes } from "./modules/members/routes.ts";
import { moderationRoutes } from "./modules/moderation/routes.ts";
import { notificationsRoutes } from "./modules/notifications/routes.ts";
import { qqRoutes } from "./modules/qq/routes.ts";
import { reactionsRoutes } from "./modules/reactions/routes.ts";
import { searchRoutes } from "./modules/search/routes.ts";
import { serveSitemap, threadsRoutes } from "./modules/threads/routes.ts";
import { serveUpload, uploadsRoutes } from "./modules/uploads/routes.ts";
import { serveAvatar, usersRoutes } from "./modules/users/routes.ts";
import { db } from "./platform/db.ts";
import { env } from "./platform/env.ts";
import { createRouter, handleError, type AppEnv } from "./platform/http.ts";
import { requestBody } from "./platform/body.ts";
import { idempotency } from "./platform/idempotency.ts";
import { SITE_NAME } from "./platform/site.ts";

const api = createRouter()
  .route("/", authRoutes)
  .route("/", tokenRoutes)
  .route("/", usersRoutes)
  .route("/", membersRoutes)
  .route("/", boardsRoutes)
  .route("/", threadsRoutes)
  .route("/", draftsRoutes)
  .route("/", uploadsRoutes)
  .route("/", qqRoutes)
  .route("/", reactionsRoutes)
  .route("/", notificationsRoutes)
  .route("/", eventsRoutes)
  .route("/", searchRoutes)
  .route("/", moderationRoutes)
  .route("/", adminRoutes)
  .route("/", auditRoutes);

api.doc31("/openapi.json", { openapi: "3.1.0", info: { title: SITE_NAME, version: "1" } });

api.all("*", (c) => c.json({ error: { code: "not_found", message: "接口不存在" } }, 404));

export type ApiType = typeof api;

const checkOrigin = csrf({ origin: env.PUBLIC_URL });

// Crawlers that train AI models or scrape heavily are turned away; the rest may read what guests
// can, but not the pages that are someone's own or only fetched by the pages (design §11.2).
const ROBOTS = `${[
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "CCBot",
  "Google-Extended",
  "Applebot-Extended",
  "Bytespider",
  "PerplexityBot",
  "Amazonbot",
  "meta-externalagent",
  "FacebookBot",
  "cohere-ai",
  "Diffbot",
  "Omgilibot",
  "ImagesiftBot",
  "Timpibot",
  "AhrefsBot",
  "SemrushBot",
  "MJ12bot",
  "DotBot",
  "PetalBot",
]
  .map((bot) => `User-agent: ${bot}`)
  .join("\n")}
Disallow: /

User-agent: *
Disallow: /admin
Disallow: /api/
Disallow: /login
Disallow: /logout
Disallow: /my/
Disallow: /new
Disallow: /notifications
Disallow: /search
Disallow: /settings
Disallow: /preview
Disallow: /mention
Disallow: /t/*/
Disallow: /u/*/

Sitemap: ${env.PUBLIC_URL}/sitemap.xml
`;

// Mounted into the outer server, so the middleware here also runs for page requests.
export const app = new Hono<AppEnv>()
  // Before the session lookup: images don't need to know who is looking.
  .get("/uploads/:dir{[0-9a-f]{2}}/:file{[0-9a-f]{64}(?:-960)?\\.webp}", serveUpload)
  .get("/avatars/:file{[0-9]+\\.webp}", serveAvatar)
  .get("/robots.txt", (c) => c.text(ROBOTS, 200, { "cache-control": "public, max-age=86400" }))
  .get("/sitemap.xml", serveSitemap)
  // A cross-site page can make the browser send our cookie, but not a bearer token.
  .use((c, next) => (bearerToken(c) ? next() : checkOrigin(c, next)))
  .use(authenticate)
  .use("/api/v1/*", requestBody, idempotency)
  .get("/healthz", async (c) => {
    await sql`select 1`.execute(db);
    return c.text("ok");
  })
  .route("/api/v1", api)
  .onError(handleError);
