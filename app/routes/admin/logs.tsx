import { Bot, Search } from "lucide-react";
import { Form, Link } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Time } from "~/components/form-parts";
import { NativeSelect } from "~/components/ui/native-select";
import { UserAvatar } from "~/components/user-avatar";
import type { Route } from "./+types/logs.ts";

export function meta() {
  return [{ title: "操作日志 · 管理后台" }];
}

// What each action is called here; others show as they are written.
const ACTIONS: Record<string, string> = {
  "auth.login": "登录",
  "auth.code_confirm": "确认登录口令",
  "auth.link_issue": "签发登录链接",
  "thread.create": "发帖",
  "thread.update": "修改帖子",
  "thread.delete": "删除帖子",
  "thread.solve": "采纳答案",
  "thread.unsolve": "取消采纳",
  "post.create": "回复",
  "post.edit": "编辑回复",
  "post.delete": "删除回复",
  "boost.delete": "删除短评",
  "report.resolve": "处理举报",
  "report.dismiss": "驳回举报",
  "user.restrict": "禁言或封禁",
  "user.unrestrict": "解除禁言或封禁",
  "user.bootstrap": "初始化管理员",
  "member.role": "角色变更",
  "member.freeze": "冻结",
  "member.restore": "恢复",
  "board.create": "新建版块",
  "board.update": "修改版块",
  "board.delete": "删除版块",
  "tag.create": "新建标签",
  "tag.update": "修改标签",
  "tag.merge": "合并标签",
  "tag.delete": "删除标签",
  "group.link": "关联群",
  "group.update": "修改群",
  "settings.update": "修改站点设置",
  "token.create": "创建 token",
  "token.revoke": "吊销 token",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const actor = search.get("actor")?.trim() ?? "";
  const action = search.get("action") ?? "";
  const res = await context.get(apiContext).admin["audit-logs"].$get({
    query: {
      actor: /^(qq:)?\d{1,12}$/.test(actor) ? actor : undefined,
      action: action || undefined,
      cursor: search.get("cursor") ?? undefined,
    },
  });
  if (res.status === 404) return { actor, action, items: [], next_cursor: null };
  if (!res.ok) throw new Error("Audit logs failed");
  const page = await res.json();
  return { actor, action, items: page.items, next_cursor: page.next_cursor };
}

// Where a log's target is on the site, when it is somewhere one can go.
function targetLink(type: string | null, id: number | null) {
  if (id === null) return null;
  if (type === "user") return `/u/${id}`;
  if (type === "thread") return `/t/${id}`;
  return null;
}

export default function Logs({ loaderData }: Route.ComponentProps) {
  const { actor, action, items, next_cursor } = loaderData;
  return (
    <>
      <h1 className="text-xl font-semibold">操作日志</h1>
      <Form className="mt-4 flex flex-wrap gap-2 text-sm">
        <label className="flex h-9 min-w-40 flex-1 items-center gap-2 rounded-lg border px-3 focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-4 text-muted-foreground" />
          <input
            name="actor"
            defaultValue={actor}
            placeholder="操作人：用户 ID 或 qq:QQ号"
            aria-label="操作人"
            className="w-full bg-transparent outline-none"
          />
        </label>
        <NativeSelect
          name="action"
          defaultValue={action}
          aria-label="动作"
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="w-40 [&_select]:h-9"
        >
          <option value="">全部动作</option>
          {Object.entries(ACTIONS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </Form>
      <ul className="mt-4 divide-y rounded-2xl border bg-card text-sm">
        {items.map((log) => {
          const to = targetLink(log.target_type, log.target_id);
          const target = log.target_type && `${log.target_type} ${log.target_id ?? ""}`;
          return (
            <li key={log.id} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {log.actor ? (
                  <Link
                    to={`/u/${log.actor.id}`}
                    className="inline-flex items-center gap-1.5 font-medium"
                  >
                    <UserAvatar user={log.actor} className="size-5 text-2xs" />
                    {log.actor.display_name}
                  </Link>
                ) : (
                  <span className="font-medium">系统</span>
                )}
                <span>{ACTIONS[log.action] ?? log.action}</span>
                {target &&
                  (to ? (
                    <Link to={to} className="text-link">
                      {target}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{target}</span>
                  ))}
                <span className="ml-auto text-meta text-muted-foreground">
                  <Time value={log.created_at} />
                </span>
              </div>
              {(log.token || log.operator) && (
                <p className="inline-flex items-center gap-1 text-meta text-muted-foreground">
                  <Bot className="size-3.5" />
                  经由 {log.token ?? "bot"}
                  {log.operator && `，${log.operator.display_name} 让它做的`}
                </p>
              )}
              {Object.keys(log.data).length > 0 && (
                <code className="block overflow-x-auto rounded-lg bg-secondary/60 px-2.5 py-1.5 text-xs whitespace-pre-wrap break-all">
                  {JSON.stringify(log.data)}
                </code>
              )}
              {log.ip && <span className="text-xs text-muted-foreground">IP {log.ip}</span>}
            </li>
          );
        })}
        {items.length === 0 && (
          <li className="px-4 py-12 text-center text-sm text-muted-foreground">没有记录</li>
        )}
      </ul>
      {next_cursor !== null && (
        <Link
          to={`?${new URLSearchParams({ actor, action, cursor: next_cursor })}`}
          className="mt-4 block text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更早的
        </Link>
      )}
    </>
  );
}
