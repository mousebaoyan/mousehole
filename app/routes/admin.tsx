import {
  ArrowLeft,
  Bot,
  FileText,
  LayoutDashboard,
  LayoutList,
  Mail,
  ScrollText,
  Settings,
  ShieldAlert,
  Users,
  UsersRound,
} from "lucide-react";
import { Link } from "react-router";
import { cn } from "cn";
import { Logo } from "~/components/logo";
import { ThemeToggle } from "~/components/theme-toggle";
import { adminOverview } from "~/draft-data";

export function meta() {
  return [{ title: "管理后台 · 鼠洞" }];
}

const sections = [
  { title: null, items: [{ label: "概览", icon: LayoutDashboard, active: true }] },
  {
    title: "社区",
    items: [
      { label: "内容审核", icon: ShieldAlert },
      { label: "成员", icon: Users },
      { label: "版块与标签", icon: LayoutList },
      { label: "QQ 群", icon: UsersRound },
    ],
  },
  {
    title: "系统",
    items: [
      { label: "站点", icon: Settings },
      { label: "邮件", icon: Mail },
      { label: "bot", icon: Bot },
      { label: "操作日志", icon: ScrollText },
    ],
  },
];

export default function Admin() {
  return (
    <div className="flex min-h-svh">
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r bg-secondary/40 px-4 py-5 md:flex">
        <div className="flex items-center justify-between px-2">
          <Logo />
          <span className="rounded bg-primary px-1.5 py-px text-2xs text-primary-foreground">
            后台
          </span>
        </div>
        <nav className="flex flex-col gap-5 text-sm">
          {sections.map((section, i) => (
            // A fixed list, so the index is a stable key.
            <div key={i} className="flex flex-col gap-1">
              {section.title && (
                <h2 className="px-3 pb-1 text-xs font-medium text-muted-foreground">
                  {section.title}
                </h2>
              )}
              {section.items.map((item) => (
                <Link
                  key={item.label}
                  to="/admin"
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-foreground/80 hover:bg-accent hover:text-foreground",
                    "active" in item && "bg-background font-medium text-foreground shadow-sm",
                  )}
                >
                  <item.icon className="size-4" /> {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <Link
          to="/"
          className="mt-auto inline-flex items-center gap-1.5 px-3 text-meta text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> 返回论坛
        </Link>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">概览</h1>
          <ThemeToggle />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {adminOverview.stats.map((s) => (
            <div key={s.label} className="rounded-2xl border bg-card p-4">
              <div className="text-meta text-muted-foreground">{s.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{s.note}</div>
            </div>
          ))}
        </div>

        <section className="mt-8">
          <h2 className="text-base font-semibold">群信息同步</h2>
          <div className="mt-3 overflow-x-auto rounded-2xl border bg-card">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-left text-meta text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">群</th>
                  <th className="px-4 py-2.5 font-medium">人数</th>
                  <th className="px-4 py-2.5 font-medium">最近全量</th>
                  <th className="px-4 py-2.5 font-medium">最近增量</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {adminOverview.groups.map((g) => (
                  <tr key={g.id}>
                    <td className="px-4 py-3">
                      <div className="font-medium">
                        {g.name}
                        {g.primary && (
                          <span className="ml-2 rounded bg-secondary px-1.5 py-px text-2xs text-muted-foreground">
                            主群
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums">{g.id}</div>
                    </td>
                    <td className="px-4 py-3 tabular-nums">{g.members}</td>
                    <td className="px-4 py-3 text-muted-foreground">{g.full}</td>
                    <td className="px-4 py-3 text-muted-foreground">{g.delta}</td>
                    <td className="px-4 py-3">
                      {g.ok ? (
                        <span className="inline-flex items-center gap-1.5 text-success">
                          <span className="size-1.5 rounded-full bg-current" /> 正常
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-warning">
                          <span className="size-1.5 rounded-full bg-current" /> 名单骤减，待确认
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-8 grid gap-3 lg:grid-cols-2">
          <div className="rounded-2xl border bg-card p-4">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Bot className="size-4" /> bot 事件流
            </h2>
            <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-success">
              <span className="size-1.5 rounded-full bg-current" /> 在线 · 已确认至 #10234
            </p>
          </div>
          <div className="rounded-2xl border bg-card p-4">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <FileText className="size-4" /> 存储
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">数据库 182 MB · 图片 1.3 GB</p>
          </div>
        </section>
      </main>
    </div>
  );
}
