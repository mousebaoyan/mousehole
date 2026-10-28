import {
  ArrowLeft,
  Award,
  Bot,
  ChartLine,
  ClipboardCheck,
  FilePen,
  Flag,
  HandHeart,
  LayoutDashboard,
  LayoutList,
  Mail,
  MessageSquareWarning,
  ScrollText,
  Settings,
  Tags,
  Users,
  UsersRound,
  type LucideIcon,
} from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { useEffect, useRef } from "react";
import { data, Link, NavLink, Outlet, redirect, useLocation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { cn } from "~/cn";
import { Logo } from "~/components/logo";
import { PageTransition } from "~/components/page-transition";
import { ThemeToggle } from "~/components/theme-toggle";
import type { Route } from "./+types/layout.ts";

export function meta() {
  return [{ title: pageTitle("管理后台") }];
}

// Who sees which pages (design §10): moderators those for their work, starting at reports;
// admins the forum's as well; the owner also the system's. Sponsorships are the payee's and the
// owner's (design §8.21).
const RANKS = ["moderator", "admin", "owner"] as const;
type Rank = (typeof RANKS)[number];

const pages: {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  from: Rank | "payee";
}[] = [
  { to: "/admin", label: "概览", icon: LayoutDashboard, end: true, from: "admin" },
  { to: "/admin/stats", label: "数据", icon: ChartLine, from: "admin" },
  { to: "/admin/content", label: "内容", icon: ClipboardCheck, from: "moderator" },
  { to: "/admin/reports", label: "举报", icon: Flag, from: "moderator" },
  {
    to: "/admin/archive-flags",
    label: "收录有误",
    icon: MessageSquareWarning,
    from: "moderator",
  },
  { to: "/admin/suggestions", label: "修改建议", icon: FilePen, from: "moderator" },
  { to: "/admin/members", label: "成员", icon: Users, from: "moderator" },
  { to: "/admin/boards", label: "版块", icon: LayoutList, from: "admin" },
  { to: "/admin/tags", label: "标签", icon: Tags, from: "admin" },
  { to: "/admin/badges", label: "徽章", icon: Award, from: "admin" },
  { to: "/admin/sponsor", label: "赞助", icon: HandHeart, from: "payee" },
  { to: "/admin/site", label: "站点", icon: Settings, from: "owner" },
  { to: "/admin/groups", label: "QQ 群", icon: UsersRound, from: "owner" },
  { to: "/admin/email", label: "邮件", icon: Mail, from: "owner" },
  { to: "/admin/tokens", label: "bot", icon: Bot, from: "owner" },
  { to: "/admin/logs", label: "操作日志", icon: ScrollText, from: "owner" },
];

// `pending` is null for those who don't see to sponsorships.
function opens(page: (typeof pages)[number], rank: Rank, pending: number | null) {
  return page.from === "payee" ? pending !== null : RANKS.indexOf(page.from) <= RANKS.indexOf(rank);
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const res = await api.me.$get();
  if (!res.ok) return redirect("/login");
  const { role } = await res.json();
  const rank = RANKS.find((r) => r === role);
  if (!rank) throw data("仅版主、管理员和站长可以进入管理后台", { status: 403 });
  const { pathname } = new URL(request.url);
  if (rank === "moderator" && pathname === "/admin") return redirect("/admin/reports");
  // Floors flagged as wrongly collected and sponsorships to confirm, counted beside their pages in
  // the menu; only the payee and the owner get the latter.
  const [flags, sponsorships] = await Promise.all([
    api.admin["archive-flags"].count.$get(),
    api.admin.sponsorships.count.$get(),
  ]);
  if (!flags.ok) throw new Error("Archive flag count failed");
  const pending = sponsorships.ok ? (await sponsorships.json()).count : null;
  const page = pages.find((p) => p.to === pathname);
  if (page && !opens(page, rank, pending)) throw data("没有权限访问此页面", { status: 403 });
  const counts: Record<string, number> = {
    "/admin/archive-flags": (await flags.json()).count,
    "/admin/sponsor": pending ?? 0,
  };
  return { rank, pending, counts };
}

const link = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-foreground/80 hover:bg-accent hover:text-foreground",
    isActive && "bg-background font-medium text-foreground shadow-sm",
  );

export default function AdminLayout({
  loaderData: { rank, pending, counts },
}: Route.ComponentProps) {
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
        <nav
          ref={nav}
          className="-mx-1 flex gap-1 overflow-x-auto px-1 text-sm [scrollbar-width:none] md:flex-col"
        >
          {pages
            .filter((p) => opens(p, rank, pending))
            .map((p) => (
              <NavLink key={p.to} to={p.to} end={p.end} className={link}>
                <p.icon className="size-4" /> {p.label}
                {!!counts[p.to] && (
                  <span className="rounded-full bg-warning/15 px-1.5 text-2xs font-medium text-warning tabular-nums md:ml-auto">
                    {counts[p.to]}
                  </span>
                )}
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
