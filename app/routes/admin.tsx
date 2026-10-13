import {
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
  { label: "概览", icon: LayoutDashboard, active: true },
  { label: "站点", icon: Settings },
  { label: "邮件", icon: Mail },
  { label: "QQ 群", icon: UsersRound },
  { label: "成员", icon: Users },
  { label: "版块与标签", icon: LayoutList },
  { label: "内容审核", icon: ShieldAlert },
  { label: "bot", icon: Bot },
  { label: "操作日志", icon: ScrollText },
];

export default function Admin() {
  return (
    <div className="flex min-h-svh">
      <aside className="hidden w-56 shrink-0 flex-col gap-6 border-r bg-secondary/40 px-3 py-4 md:flex">
        <div className="flex items-center justify-between px-2">
          <Logo />
          <span className="rounded bg-primary px-1.5 py-px text-[11px] text-primary-foreground">
            后台
          </span>
        </div>
        <nav className="flex flex-col gap-0.5 text-sm">
          {sections.map((s) => (
            <Link
              key={s.label}
              to="/admin"
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-foreground/80 hover:bg-accent hover:text-foreground",
                s.active && "bg-background font-medium text-foreground shadow-sm",
              )}
            >
              <s.icon className="size-4" /> {s.label}
            </Link>
          ))}
        </nav>
        <Link
          to="/"
          className="mt-auto px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
        >
          ← 返回论坛
        </Link>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">概览</h1>
          <ThemeToggle />
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {adminOverview.stats.map((s) => (
            <div key={s.label} className="rounded-2xl border p-4">
              <div className="text-[13px] text-muted-foreground">{s.label}</div>
              <div className="mt-1 text-2xl font-semibold tabular-nums">{s.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{s.note}</div>
            </div>
          ))}
        </div>

        <section className="mt-8">
          <h2 className="text-base font-semibold">群信息同步</h2>
          <div className="mt-3 overflow-x-auto rounded-2xl border">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-left text-[13px] text-muted-foreground">
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
                          <span className="ml-2 rounded bg-secondary px-1.5 py-px text-[11px] text-muted-foreground">
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
                          <span className="size-1.5 rounded-full bg-current" />{" "}
                          名单骤减，等下次全量确认
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
          <div className="rounded-2xl border p-4">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Bot className="size-4" /> bot 事件流
            </h2>
            <p className="mt-2 inline-flex items-center gap-1.5 text-sm text-success">
              <span className="size-1.5 rounded-full bg-current" /> 在线，最近确认到事件 #10234
            </p>
          </div>
          <div className="rounded-2xl border p-4">
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
