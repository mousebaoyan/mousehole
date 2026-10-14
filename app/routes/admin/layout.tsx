import {
  ArrowLeft,
  Bot,
  ClipboardCheck,
  Flag,
  LayoutDashboard,
  LayoutList,
  Mail,
  Settings,
  ScrollText,
  Tags,
  Users,
  UsersRound,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { data, Link, NavLink, Outlet, redirect, useLocation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { cn } from "cn";
import { Logo } from "~/components/logo";
import { ThemeToggle } from "~/components/theme-toggle";
import type { Route } from "./+types/layout.ts";
import { SITE_NAME } from "../../../server/platform/site.ts";

export function meta() {
  return [{ title: `管理后台 · ${SITE_NAME}` }];
}

// Admins see it all; moderators the pages for their work (design §10), starting at reports.
export async function loader({ context, request }: Route.LoaderArgs) {
  const res = await context.get(apiContext).me.$get();
  if (!res.ok) return redirect("/login");
  const { role } = await res.json();
  if (role === "admin") return { admin: true };
  if (role !== "moderator") throw data("管理后台只有管理员和版主能进", { status: 403 });
  if (new URL(request.url).pathname === "/admin") return redirect("/admin/reports");
  return { admin: false };
}

const pages = [
  { to: "/admin", label: "概览", icon: LayoutDashboard, end: true, admin: true },
  { to: "/admin/content", label: "内容", icon: ClipboardCheck, admin: false },
  { to: "/admin/reports", label: "举报", icon: Flag, admin: false },
  { to: "/admin/members", label: "成员", icon: Users, admin: false },
  { to: "/admin/groups", label: "QQ 群", icon: UsersRound, admin: true },
  { to: "/admin/boards", label: "版块", icon: LayoutList, admin: true },
  { to: "/admin/tags", label: "标签", icon: Tags, admin: true },
  { to: "/admin/site", label: "站点", icon: Settings, admin: true },
  { to: "/admin/email", label: "邮件", icon: Mail, admin: true },
  { to: "/admin/tokens", label: "bot", icon: Bot, admin: true },
  { to: "/admin/logs", label: "操作日志", icon: ScrollText, admin: true },
];

const link = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-foreground/80 hover:bg-accent hover:text-foreground",
    isActive && "bg-background font-medium text-foreground shadow-sm",
  );

export default function AdminLayout({ loaderData: { admin } }: Route.ComponentProps) {
  const { pathname } = useLocation();
  const nav = useRef<HTMLElement>(null);
  // On phones the row may have scrolled the current page out of sight.
  useEffect(() => {
    nav.current
      ?.querySelector(`a[href="${pathname}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b bg-secondary/40 px-3 py-3 md:sticky md:top-0 md:h-svh md:w-60 md:gap-6 md:border-r md:border-b-0 md:px-4 md:py-5">
        <div className="flex items-center gap-2 px-2">
          <Logo />
          <span className="rounded bg-primary px-1.5 py-px text-2xs text-primary-foreground">
            后台
          </span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
        {/* A sidebar on wide screens, a row that scrolls sideways on phones. */}
        <nav ref={nav} className="-mx-1 flex gap-1 overflow-x-auto px-1 text-sm md:flex-col">
          {pages
            .filter((p) => admin || !p.admin)
            .map((p) => (
              <NavLink key={p.to} to={p.to} end={p.end} className={link}>
                <p.icon className="size-4" /> {p.label}
              </NavLink>
            ))}
        </nav>
        <Link
          to="/"
          className="mt-auto hidden items-center gap-1.5 px-3 text-meta text-muted-foreground hover:text-foreground md:inline-flex"
        >
          <ArrowLeft className="size-4" /> 返回论坛
        </Link>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-4xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
