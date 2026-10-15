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
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { data, Link, NavLink, Outlet, redirect, useLocation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { cn } from "cn";
import { Logo } from "~/components/logo";
import { PageTransition } from "~/components/page-transition";
import { ThemeToggle } from "~/components/theme-toggle";
import type { Route } from "./+types/layout.ts";
import { SITE_NAME } from "../../../server/platform/site.ts";

export function meta() {
  return [{ title: `管理后台 · ${SITE_NAME}` }];
}

// Who sees which pages (design §10): moderators those for their work, starting at reports;
// admins the forum's as well; the owner also the system's.
const RANKS = ["moderator", "admin", "owner"] as const;
type Rank = (typeof RANKS)[number];

const pages: { to: string; label: string; icon: LucideIcon; end?: boolean; from: Rank }[] = [
  { to: "/admin", label: "概览", icon: LayoutDashboard, end: true, from: "admin" },
  { to: "/admin/content", label: "内容", icon: ClipboardCheck, from: "moderator" },
  { to: "/admin/reports", label: "举报", icon: Flag, from: "moderator" },
  { to: "/admin/members", label: "成员", icon: Users, from: "moderator" },
  { to: "/admin/boards", label: "版块", icon: LayoutList, from: "admin" },
  { to: "/admin/tags", label: "标签", icon: Tags, from: "admin" },
  { to: "/admin/site", label: "站点", icon: Settings, from: "owner" },
  { to: "/admin/groups", label: "QQ 群", icon: UsersRound, from: "owner" },
  { to: "/admin/email", label: "邮件", icon: Mail, from: "owner" },
  { to: "/admin/tokens", label: "bot", icon: Bot, from: "owner" },
  { to: "/admin/logs", label: "操作日志", icon: ScrollText, from: "owner" },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  const res = await context.get(apiContext).me.$get();
  if (!res.ok) return redirect("/login");
  const { role } = await res.json();
  const rank = RANKS.find((r) => r === role);
  if (!rank) throw data("仅版主、管理员和站长可以进入管理后台", { status: 403 });
  const { pathname } = new URL(request.url);
  if (rank === "moderator" && pathname === "/admin") return redirect("/admin/reports");
  const page = pages.find((p) => p.to === pathname);
  if (page && RANKS.indexOf(page.from) > RANKS.indexOf(rank)) {
    throw data("没有权限访问此页面", { status: 403 });
  }
  return { rank };
}

const link = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-foreground/80 hover:bg-accent hover:text-foreground",
    isActive && "bg-background font-medium text-foreground shadow-sm",
  );

export default function AdminLayout({ loaderData: { rank } }: Route.ComponentProps) {
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
            .filter((p) => RANKS.indexOf(p.from) <= RANKS.indexOf(rank))
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
          <PageTransition>
            <Outlet />
          </PageTransition>
        </div>
      </main>
    </div>
  );
}
