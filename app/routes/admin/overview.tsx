import { apiContext } from "../../api.server.ts";
import type { Route } from "./+types/overview.ts";
import { Section, Time } from "./parts.tsx";

export async function loader({ context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  // The layout already checked that this is an admin.
  const overview = await api.admin.overview.$get();
  const groups = await api.admin.groups.$get();
  if (!overview.ok || !groups.ok) throw new Error("Admin overview failed");
  return { members: (await overview.json()).members, groups: (await groups.json()).items };
}

export default function Overview({ loaderData: { members, groups } }: Route.ComponentProps) {
  const stats = [
    { label: "成员", value: members.total },
    { label: "已激活", value: members.activated },
    { label: "已冻结", value: members.frozen },
  ];
  return (
    <>
      <h1 className="text-xl font-semibold">概览</h1>
      <div className="mt-5 grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-2xl border bg-card p-4">
            <div className="text-meta text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">
              {s.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      <Section title="群同步">
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有关联 QQ 群</p>
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
