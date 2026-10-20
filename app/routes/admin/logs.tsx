import { Bot, Search } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { Form, Link } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Time } from "~/components/form-parts";
import { Select } from "~/components/ui/select";
import { UserAvatar } from "~/components/user-avatar";
import type { Route } from "./+types/logs.ts";

export function meta() {
  return [{ title: pageTitle("操作日志", "管理后台") }];
}

// What each action is called here; others show as they are written.
const ACTIONS: Record<string, string> = {
  "auth.login": "登录",
  "auth.logout": "退出",
  "auth.session_end": "让设备下线",
  "auth.code_confirm": "确认登录口令",
  "auth.link_issue": "签发登录链接",
  "thread.create": "发帖",
  "thread.update": "修改帖子",
  "thread.delete": "删除帖子",
  "thread.solve": "采纳答案",
  "thread.unsolve": "取消采纳",
  "thread.approve": "通过帖子",
  "thread.reject": "不通过帖子",
  "thread.hide": "隐藏帖子",
  "thread.unhide": "恢复帖子",
  "thread.reveal": "查看匿名身份",
  "thread.merge": "合并帖子",
  "thread.renumber": "重排楼层号",
  "suggestion.create": "建议修改帖子",
  "suggestion.accept": "同意修改建议",
  "suggestion.reject": "不同意修改建议",
  "summary.save": "写 AI 总结",
  "summary.disable": "关闭 AI 总结",
  "summary.enable": "恢复 AI 总结",
  "poll.vote": "投票",
  "poll.close": "结束投票",
  "lottery.enter": "参与抽奖",
  "lottery.leave": "退出抽奖",
  "lottery.cancel": "取消抽奖",
  "post.create": "回复",
  "post.edit": "编辑回复",
  "post.delete": "删除回复",
  "post.approve": "通过回复",
  "post.reject": "不通过回复",
  "post.hide": "隐藏回复",
  "post.unhide": "恢复回复",
  "boost.set": "发表短评",
  "boost.unset": "删除自己的短评",
  "boost.delete": "删除短评",
  "report.create": "举报",
  "report.resolve": "处理举报",
  "report.dismiss": "驳回举报",
  "user.restrict": "禁言或封禁",
  "user.unrestrict": "解除禁言或封禁",
  "user.bootstrap": "命令行创建账号",
  "user.settings": "修改设置",
  "user.rename": "修改名字",
  "user.avatar": "修改头像",
  "user.background": "上传背景图片",
  "user.clear": "清除资料内容",
  "user.qq_bio": "推送 QQ 签名",
  "user.level": "设定等级",
  "badge.create": "新建徽章",
  "badge.update": "修改徽章",
  "badge.grant": "授予徽章",
  "badge.revoke": "收回徽章",
  "member.role": "角色变更",
  "member.role_unlock": "角色改回跟随群",
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
  const ip = search.get("ip")?.trim() ?? "";
  const action = search.get("action") ?? "";
  const res = await context.get(apiContext).admin["audit-logs"].$get({
    query: {
      actor: /^(qq:)?\d{1,12}$/.test(actor) ? actor : undefined,
      ip: ip || undefined,
      action: action || undefined,
      cursor: search.get("cursor") ?? undefined,
    },
  });
  // An unknown actor or a malformed address finds nothing.
  if (res.status === 404 || res.status === 400) {
    return { actor, ip, action, items: [], next_cursor: null };
  }
  if (!res.ok) throw new Error("Audit logs failed");
  const page = await res.json();
  return { actor, ip, action, items: page.items, next_cursor: page.next_cursor };
}

// Where a log's target is on the site, when it is somewhere one can go.
function targetLink(type: string | null, id: number | null) {
  if (id === null) return null;
  if (type === "user") return `/u/${id}`;
  if (type === "thread") return `/t/${id}`;
  return null;
}

export default function Logs({ loaderData }: Route.ComponentProps) {
  const { actor, ip, action, items, next_cursor } = loaderData;
  return (
    <>
      <h1 className="text-xl font-semibold">操作日志</h1>
      <Form
        action="/admin/logs"
        className="mt-4 grid grid-cols-2 gap-2 text-sm sm:flex sm:flex-wrap"
      >
        <label className="col-span-2 flex h-9 min-w-40 flex-1 items-center gap-2 rounded-lg border px-3 focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-4 text-muted-foreground" />
          <input
            name="actor"
            defaultValue={actor}
            placeholder="操作人：用户 ID 或 qq:QQ号"
            aria-label="操作人"
            className="w-full bg-transparent outline-none"
          />
        </label>
        <label className="flex h-9 items-center gap-2 sm:w-44 rounded-lg border px-3 focus-within:ring-2 focus-within:ring-ring/40">
          <input
            name="ip"
            defaultValue={ip}
            placeholder="IP"
            aria-label="IP"
            className="w-full bg-transparent outline-none"
          />
        </label>
        {/* With two text boxes, Enter in one sends the form only through a submit button. */}
        <button type="submit" className="sr-only">
          搜索
        </button>
        <Select
          name="action"
          defaultValue={action}
          options={[
            { value: "", label: "全部动作" },
            ...Object.entries(ACTIONS).map(([value, label]) => ({ value, label })),
          ]}
          aria-label="动作"
          submitOnChange
          className="sm:w-40 [&>button]:h-9"
        />
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
                  {log.operator && `，发起人：${log.operator.display_name}`}
                </p>
              )}
              {Object.keys(log.data).length > 0 && (
                <code className="block overflow-x-auto rounded-lg bg-secondary/60 px-2.5 py-1.5 text-xs whitespace-pre-wrap break-all">
                  {JSON.stringify(log.data)}
                </code>
              )}
              {(log.ip || log.device) && (
                <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {log.ip && (
                    <Link
                      to={`?${new URLSearchParams({ ip: log.ip })}`}
                      className="hover:text-foreground"
                    >
                      IP {log.ip}
                    </Link>
                  )}
                  {log.device && <span title={log.user_agent ?? undefined}>{log.device}</span>}
                </p>
              )}
            </li>
          );
        })}
        {items.length === 0 && (
          <li className="px-4 py-12 text-center text-sm text-muted-foreground">暂无记录</li>
        )}
      </ul>
      {next_cursor !== null && (
        <Link
          to={`?${new URLSearchParams({ actor, ip, action, cursor: next_cursor })}`}
          className="mt-4 block text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更早的
        </Link>
      )}
    </>
  );
}
