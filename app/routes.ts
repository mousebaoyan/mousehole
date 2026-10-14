import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  layout("routes/forum-layout.tsx", [
    index("routes/home.tsx"),
    route("b/:slug", "routes/board.tsx"),
    route("t/:id", "routes/topic.tsx"),
    route("new", "routes/new-thread.tsx"),
    route("my/:list", "routes/my-threads.tsx"),
    route("u/:id", "routes/user.tsx"),
    route("notifications", "routes/notifications.tsx"),
    route("settings", "routes/settings.tsx"),
    route("search", "routes/search.tsx"),
  ]),
  layout("routes/login-layout.tsx", [
    route("login", "routes/login.tsx"),
    route("login/link", "routes/login-link.tsx"),
  ]),
  // For fetchers on the forum's pages.
  route("t/:id/floors", "routes/topic-floors.ts"),
  route("t/:id/p/:post", "routes/topic-post.ts"),
  route("t/:id/p/:post/replies", "routes/topic-replies.ts"),
  route("t/:id/p/:post/revisions", "routes/topic-revisions.ts"),
  route("t/:id/p/:post/reactions", "routes/topic-reactions.ts"),
  route("t/:id/p/:post/boosts", "routes/topic-boosts.ts"),
  route("t/:id/reply", "routes/topic-reply.ts"),
  route("u/:id/card", "routes/user-card.ts"),
  route("preview", "routes/preview.ts"),
  route("mention", "routes/mention.ts"),
  route("login/code", "routes/login-code.ts"),
  route("logout", "routes/logout.ts"),
  route("admin", "routes/admin/layout.tsx", [
    index("routes/admin/overview.tsx"),
    route("reports", "routes/admin/reports.tsx"),
    route("members", "routes/admin/members.tsx"),
    route("logs", "routes/admin/logs.tsx"),
    route("groups", "routes/admin/groups.tsx"),
    route("boards", "routes/admin/boards.tsx"),
    route("tags", "routes/admin/tags.tsx"),
    route("site", "routes/admin/site.tsx"),
    route("email", "routes/admin/email.tsx"),
    route("tokens", "routes/admin/tokens.tsx"),
  ]),
] satisfies RouteConfig;
