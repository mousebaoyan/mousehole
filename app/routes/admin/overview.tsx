import { pageTitle } from "~/share-meta";
import { Link } from "react-router";
import { cn } from "~/cn";
import { apiContext } from "../../api.server.ts";
import type { Route } from "./+types/overview.ts";
import { Section, Time } from "~/components/form-parts";

export function meta() {
  return [{ title: pageTitle("概览", "管理后台") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  // The layout already checked that this is an admin.
  const overview = await api.admin.overview.$get();
  const groups = await api.admin.groups.$get();
  if (!overview.ok || !groups.ok) throw new Error("Admin overview failed");
  return { ...(await overview.json()), groups: (await groups.json()).items };
}

// 1536 → "1.5 KB"; storage is shown to one decimal.
function size(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${i === 0 ? bytes : bytes.toFixed(1)} ${units[i]}`;
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { members, content, events, storage, groups } = loaderData;
  // What waits for someone links to where it is handled.
  const stats = [
    {
      label: "成员",
      value: members.total,
      note: `已激活 ${members.activated.toLocaleString()} · 已冻结 ${members.frozen.toLocaleString()}`,
    },
    { label: "今天的帖子", value: content.threads_today },
    { label: "今天的回复", value: content.posts_today },
    { label: "待审核", value: content.pending, to: "/admin/content" },
    { label: "待处理的举报", value: content.reports, to: "/admin/reports" },
    { label: "待处理的修改建议", value: content.suggestions, to: "/admin/suggestions" },
  ];
  return (
    <>
      <h1 className="text-xl font-semibold">概览</h1>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {stats.map((s) => {
          const body = (
            <>
              <div className="text-meta text-muted-foreground">{s.label}</div>
              <div
                className={cn(
                  "mt-1 text-2xl font-semibold tabular-nums",
                  s.to && s.value > 0 && "text-warning",
                )}
              >
                {s.value.toLocaleString()}
              </div>
              {s.note && <div className="text-xs text-muted-foreground">{s.note}</div>}
            </>
          );
          return s.to ? (
            <Link
              key={s.label}
              to={s.to}
              className="rounded-2xl border bg-card p-4 hover:bg-accent"
            >
              {body}
            </Link>
          ) : (
            <div key={s.label} className="rounded-2xl border bg-card p-4">
              {body}
            </div>
          );
        })}
      </div>

      <Section title="bot 与存储">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          <dt className="text-muted-foreground">事件流</dt>
          <dd
            className={cn(
              "inline-flex items-center gap-1.5",
              events.streams > 0 ? "text-success" : "text-muted-foreground",
            )}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {events.streams > 0 ? `已连接（${events.streams} 个）` : "未连接"}
          </dd>
          <dt className="text-muted-foreground">按游标拉取</dt>
          <dd>
            <Time value={events.polled_at} never="启动以来未拉取" />
          </dd>
          <dt className="text-muted-foreground">数据库</dt>
          <dd className="tabular-nums">{size(storage.database)}</dd>
          <dt className="text-muted-foreground">上传的图片</dt>
          <dd className="tabular-nums">{size(storage.uploads)}</dd>
        </dl>
      </Section>

      <Section title="群同步">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂未关联 QQ 群</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm whitespace-nowrap">
              <thead className="text-left text-meta text-muted-foreground">
                <tr>
                  <th className="px-5 py-2 font-medium">群</th>
                  <th className="px-3 py-2 font-medium">人数</th>
                  <th className="px-3 py-2 font-medium">最近全量</th>
                  <th className="px-3 py-2 font-medium">最近增量</th>
                  <th className="px-5 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y border-t">
                {groups.map((g) => (
                  <tr key={g.group_id}>
                    <td className="px-5 py-3">
                      <div className="font-medium">{g.name || "（未同步群资料）"}</div>
                      <div className="text-xs text-muted-foreground tabular-nums">{g.group_id}</div>
                    </td>
                    <td className="px-3 py-3 tabular-nums">{g.member_count ?? "—"}</td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <Time value={g.full_synced_at} never="从未" />
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      <Time value={g.delta_synced_at} never="从未" />
                    </td>
                    <td className="px-5 py-3">
                      <GroupStatus group={g} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

function GroupStatus({ group }: { group: { enabled: boolean; shrink_held_at: number | null } }) {
  const [tone, text] = !group.enabled
    ? ["text-muted-foreground", "已停用"]
    : group.shrink_held_at !== null
      ? ["text-warning", "名单骤减，待下次全量确认"]
      : ["text-success", "正常"];
  return (
    <span className={`inline-flex items-center gap-1.5 ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" /> {text}
    </span>
  );
}
