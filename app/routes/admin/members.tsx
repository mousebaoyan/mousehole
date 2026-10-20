import { ArrowDown, ArrowUp, Columns3, Lock, Search } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { cn } from "~/cn";
import { useState } from "react";
import { Form, Link, useRouteLoaderData, useSearchParams } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Badge, readForm, Time } from "~/components/form-parts";
import { Dropdown } from "~/components/disclosure";
import { Checkbox } from "~/components/ui/checkbox";
import { Select } from "~/components/ui/select";
import { UserAvatar } from "~/components/user-avatar";
import { restrictionText } from "~/restriction";
import { LevelBadge } from "~/components/user-badges";
import { LEVEL_NAMES, levelName } from "../../../server/platform/site.ts";

import type { Route } from "./+types/members.ts";
import type { loader as adminLoader } from "./layout.tsx";

// The name column stays put while the rest scrolls sideways under it, so it has to paint over the
// dropdowns in the cells, which are positioned; on phones a line marks its edge.
const pinned = "sticky left-0 z-10 bg-card px-3 sm:px-4 max-sm:shadow-[inset_-1px_0_var(--border)]";

export function meta() {
  return [{ title: pageTitle("成员", "管理后台") }];
}

const STATUSES = [
  { value: "member", label: "成员" },
  { value: "frozen", label: "已冻结" },
  { value: "restricted", label: "被禁言或封禁" },
] as const;

const ACTIVATION = [
  { value: "true", label: "已激活" },
  { value: "false", label: "未激活" },
] as const;

const ROLES = [
  { value: "user", label: "成员" },
  { value: "moderator", label: "版主" },
  { value: "admin", label: "管理员" },
] as const;

const ROLE_FILTERS = [
  ...ROLES,
  { value: "owner", label: "站长" },
  { value: "bot", label: "bot" },
] as const;

const LEVELS = LEVEL_NAMES.map((_, level) => ({ value: String(level), label: levelName(level) }));

const SEEN = [
  { value: "7", label: "7 天内访问过" },
  { value: "30", label: "30 天内访问过" },
  { value: "-30", label: "30 天以上没访问" },
  { value: "-90", label: "90 天以上没访问" },
] as const;

const EMAIL = [
  { value: "true", label: "开着邮件提醒" },
  { value: "false", label: "关了邮件提醒" },
] as const;

// The filters on top, each a dropdown; the first choice, any, filters nothing.
const FILTERS = [
  { name: "status", label: "状态", any: "全部状态", options: STATUSES, width: "sm:w-36" },
  { name: "activated", label: "激活", any: "全部账号", options: ACTIVATION, width: "sm:w-28" },
  { name: "role", label: "角色", any: "全部角色", options: ROLE_FILTERS, width: "sm:w-28" },
  { name: "level", label: "等级", any: "全部等级", options: LEVELS, width: "sm:w-32" },
  { name: "seen", label: "最近访问", any: "访问时间不限", options: SEEN, width: "sm:w-40" },
  { name: "email", label: "邮件提醒", any: "邮件提醒不限", options: EMAIL, width: "sm:w-36" },
] as const;

// Every column but the name can be hidden; those with a sort are sorted by clicking the heading.
const COLUMNS = [
  { key: "status", label: "状态" },
  { key: "level", label: "等级", sort: "level" },
  { key: "role", label: "角色" },
  { key: "activated_at", label: "激活时间", sort: "activated_at" },
  { key: "last_seen_at", label: "最近访问", sort: "last_seen_at" },
  { key: "created_at", label: "加入时间", sort: "created_at" },
  { key: "thread_count", label: "帖子", sort: "thread_count" },
  { key: "post_count", label: "回复", sort: "post_count" },
  { key: "like_received", label: "获赞", sort: "like_received" },
  { key: "people_reached", label: "帮到的人", sort: "people_reached" },
  { key: "days_visited", label: "访问天数", sort: "days_visited" },
  { key: "notify_email", label: "邮件提醒" },
] as const;
type Column = (typeof COLUMNS)[number]["key"];

const SHOWN_BY_DEFAULT: Column[] = [
  "status",
  "level",
  "role",
  "activated_at",
  "last_seen_at",
  "thread_count",
  "post_count",
];

// A filter's value when it is one of its options; anything else, the empty "any" among them,
// filters nothing.
function pick<T extends string>(options: readonly { value: T }[], value: string) {
  return options.find((o) => o.value === value)?.value;
}

// The columns picked here, kept for the next visit in a cookie so the server renders them too.
const COOKIE = "member_columns";

function remember(columns: Column[]) {
  void cookieStore.set({
    name: COOKIE,
    value: columns.join("."),
    path: "/admin",
    expires: Date.now() + 365 * 24 * 3600_000,
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const param = (name: string) => search.get(name) ?? "";
  const q = param("q").trim();
  const status = param("status");
  const seen = Number(SEEN.find((s) => s.value === param("seen"))?.value);
  const sort = COLUMNS.flatMap((c) => ("sort" in c ? [c.sort] : [])).find(
    (s) => s === param("sort"),
  );
  const res = await context.get(apiContext).admin.members.$get({
    query: {
      q: q || undefined,
      status: status === "member" || status === "frozen" ? status : undefined,
      restricted: status === "restricted" ? "true" : undefined,
      activated: pick(ACTIVATION, param("activated")),
      role: pick(ROLE_FILTERS, param("role")),
      level: pick(LEVELS, param("level")),
      email: pick(EMAIL, param("email")),
      seen_within: seen > 0 ? String(seen) : undefined,
      unseen_for: seen < 0 ? String(-seen) : undefined,
      sort,
      order: param("order") === "asc" ? "asc" : undefined,
      page: param("page") || undefined,
    },
  });
  if (!res.ok) throw new Error("Members failed");
  const saved = request.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`))?.[1]
    ?.split(".");
  const columns = saved ? COLUMNS.map((c) => c.key).filter((key) => saved.includes(key)) : null;
  return { ...(await res.json()), columns: columns ?? SHOWN_BY_DEFAULT };
}

// Admins set roles and levels here; mutes and bans are on each person's page. Either is fixed
// by choosing it, or left to the groups and to activity.
export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const users = context.get(apiContext).users[":user"];
  const param = { user: field("id") };
  const res =
    field("intent") === "level"
      ? await users.level.$put({
          param,
          json: field("level")
            ? { level: Number(field("level")), locked: true }
            : { level: Number(field("current")), locked: false },
        })
      : await users.$patch({
          param,
          json: { role: ROLES.find((r) => r.value === field("role"))?.value ?? null },
        });
  if (res.ok) return null;
  return { message: (await res.json()).error.message };
}

export default function Members({ loaderData, actionData }: Route.ComponentProps) {
  const { items, total, pages } = loaderData;
  const [params] = useSearchParams();
  const [columns, setColumns] = useState(loaderData.columns);
  // From the admin layout: admins set roles, and only the owner makes or unmakes admins.
  const rank = useRouteLoaderData<typeof adminLoader>("routes/admin/layout")?.rank;
  const admin = rank !== "moderator";
  const roles = rank === "owner" ? ROLES : ROLES.filter((r) => r.value !== "admin");
  const sort = params.get("sort") ?? "created_at";
  const order = params.get("order") ?? "desc";
  const page = Number(params.get("page") ?? 1);
  // This page's address with some parameters changed; an empty value drops one.
  const href = (change: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(change)) {
      if (value === "") next.delete(name);
      else next.set(name, value);
    }
    return `?${next}`;
  };
  const toggle = (key: Column) => {
    const next = COLUMNS.map((c) => c.key).filter((k) => (k === key) !== columns.includes(k));
    setColumns(next);
    remember(next);
  };
  const shown = COLUMNS.filter((c) => columns.includes(c.key));
  const filters = ["q", ...FILTERS.map((f) => f.name)];
  return (
    <>
      {/* The column picker sits at the right end of the heading, where its menu always has room
          to open leftwards, unlike at the end of the filters, which wrap anywhere. */}
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">
          成员
          <span className="ml-2 text-sm font-normal text-muted-foreground">共 {total} 人</span>
        </h1>
        {filters.some((name) => params.get(name)) && (
          <Link
            to={href(Object.fromEntries(["page", ...filters].map((name) => [name, ""])))}
            className="px-2 text-sm text-muted-foreground hover:text-foreground"
          >
            清除筛选
          </Link>
        )}
        <Dropdown
          label="显示的列"
          triggerClassName="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-accent"
          trigger={
            <>
              <Columns3 className="size-4 text-muted-foreground" />列
            </>
          }
        >
          {() =>
            COLUMNS.map((c) => (
              <label
                key={c.key}
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-accent"
              >
                <Checkbox checked={columns.includes(c.key)} onChange={() => toggle(c.key)} />
                {c.label}
              </label>
            ))
          }
        </Dropdown>
      </div>
      <Form className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <label className="col-span-2 flex h-9 min-w-48 flex-1 items-center gap-2 rounded-lg border px-3 text-sm focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-4 text-muted-foreground" />
          <input
            type="search"
            name="q"
            defaultValue={params.get("q") ?? ""}
            placeholder="名字、QQ 昵称或 QQ 号"
            aria-label="名字、QQ 昵称或 QQ 号"
            className="w-full bg-transparent outline-none"
          />
        </label>
        {params.get("sort") && <input type="hidden" name="sort" value={sort} />}
        {params.get("order") && <input type="hidden" name="order" value={order} />}
        {FILTERS.map((f) => (
          <Select
            key={f.name}
            name={f.name}
            defaultValue={params.get(f.name) ?? ""}
            options={[{ value: "", label: f.any }, ...f.options]}
            aria-label={f.label}
            submitOnChange
            className={`${f.width} [&>button]:h-9`}
          />
        ))}
      </Form>
      {actionData && (
        <p role="alert" className="mt-3 text-meta text-destructive">
          {actionData.message}
        </p>
      )}
      <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-2xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b text-left text-meta text-muted-foreground">
            <tr>
              <th className={cn(pinned, "py-2 font-medium")}>成员</th>
              {shown.map((c) => (
                <th key={c.key} className="px-3 py-2 font-medium whitespace-nowrap">
                  {"sort" in c ? (
                    <Link
                      to={href({
                        sort: c.sort,
                        order: sort === c.sort && order === "desc" ? "asc" : "",
                        page: "",
                      })}
                      className="inline-flex items-center gap-0.5 hover:text-foreground"
                    >
                      {c.label}
                      {sort === c.sort &&
                        (order === "asc" ? (
                          <ArrowUp aria-label="从小到大" className="size-3.5" />
                        ) : (
                          <ArrowDown aria-label="从大到小" className="size-3.5" />
                        ))}
                    </Link>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((m) => (
              <tr key={m.id}>
                <td className={cn(pinned, "py-2.5")}>
                  <Link
                    to={`/u/${m.id}`}
                    className="flex w-32 items-center gap-2.5 sm:w-auto sm:min-w-40"
                  >
                    <UserAvatar user={m} className="size-8 shrink-0" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{m.display_name}</span>
                      <span className="text-meta text-muted-foreground">{m.qq ?? "站长账号"}</span>
                    </span>
                  </Link>
                </td>
                {shown.map((c) => (
                  <td key={c.key} className="px-3 py-2.5 whitespace-nowrap">
                    {c.key === "status" ? (
                      <span className="flex gap-1">
                        {m.member_status === "frozen" && <Badge>已冻结</Badge>}
                        {m.activated_at === null && <Badge>未激活</Badge>}
                        {m.restriction && <Badge>{restrictionText(m.restriction)}</Badge>}
                      </span>
                    ) : c.key === "level" ? (
                      admin && m.role !== "bot" && m.role !== "owner" ? (
                        <Form method="post" className="flex items-center gap-1">
                          <input type="hidden" name="intent" value="level" />
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="current" value={m.level} />
                          {m.level_locked && (
                            <Lock
                              aria-label="等级已锁定"
                              className="size-3.5 text-muted-foreground"
                            />
                          )}
                          <Select
                            name="level"
                            defaultValue={m.level_locked ? String(m.level) : ""}
                            options={[
                              { value: "", label: `自动（${levelName(m.level)}）` },
                              ...LEVELS,
                            ]}
                            aria-label={`${m.display_name} 的等级`}
                            submitOnChange
                            className="w-40"
                          />
                        </Form>
                      ) : (
                        <LevelBadge level={m.level} />
                      )
                    ) : c.key === "role" ? (
                      admin && roles.some((r) => r.value === m.role) ? (
                        <Form method="post" className="flex items-center gap-1">
                          <input type="hidden" name="intent" value="role" />
                          <input type="hidden" name="id" value={m.id} />
                          {m.role_locked && (
                            <Lock
                              aria-label="角色已锁定"
                              className="size-3.5 text-muted-foreground"
                            />
                          )}
                          <Select
                            name="role"
                            defaultValue={m.role_locked ? m.role : ""}
                            options={[
                              {
                                value: "",
                                label: `跟随群角色（${ROLES.find((r) => r.value === m.role)?.label}）`,
                              },
                              ...roles,
                            ]}
                            aria-label={`${m.display_name} 的角色`}
                            submitOnChange
                            className="w-44"
                          />
                        </Form>
                      ) : (
                        <Badge>{ROLE_FILTERS.find((r) => r.value === m.role)?.label}</Badge>
                      )
                    ) : c.key === "activated_at" ? (
                      <Time value={m.activated_at} never="未激活" />
                    ) : c.key === "last_seen_at" ? (
                      <Time value={m.last_seen_at} never="从未访问" />
                    ) : c.key === "created_at" ? (
                      <Time value={m.created_at} />
                    ) : c.key === "notify_email" ? (
                      m.notify_email ? (
                        "开"
                      ) : (
                        <span className="text-muted-foreground">关</span>
                      )
                    ) : (
                      <span className="tabular-nums">{m[c.key]}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={shown.length + 1}
                  className="px-4 py-12 text-center text-muted-foreground"
                >
                  暂无符合条件的成员
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-center gap-4 text-meta text-muted-foreground">
          {page > 1 ? (
            <Link to={href({ page: String(page - 1) })} className="hover:text-foreground">
              上一页
            </Link>
          ) : (
            <span className="opacity-50">上一页</span>
          )}
          <span>
            第 {page} / {pages} 页
          </span>
          {page < pages ? (
            <Link to={href({ page: String(page + 1) })} className="hover:text-foreground">
              下一页
            </Link>
          ) : (
            <span className="opacity-50">下一页</span>
          )}
        </nav>
      )}
    </>
  );
}
