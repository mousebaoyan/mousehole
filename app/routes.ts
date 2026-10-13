import { index, layout, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  layout("routes/forum-layout.tsx", [
    index("routes/home.tsx"),
    route("b/:slug", "routes/board.tsx"),
    route("t/:id", "routes/topic.tsx"),
  ]),
  layout("routes/login-layout.tsx", [
    route("login", "routes/login.tsx"),
    route("login/link", "routes/login-link.tsx"),
  ]),
  route("login/code", "routes/login-code.ts"),
  route("logout", "routes/logout.ts"),
  route("admin", "routes/admin/layout.tsx", [
    index("routes/admin/overview.tsx"),
    route("groups", "routes/admin/groups.tsx"),
    route("site", "routes/admin/site.tsx"),
    route("email", "routes/admin/email.tsx"),
    route("tokens", "routes/admin/tokens.tsx"),
  ]),
] satisfies RouteConfig;
