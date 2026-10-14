import { Lock, Search } from "lucide-react";
import { Form, Link, useRouteLoaderData } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Badge, readForm, Time } from "~/components/form-parts";
import { Select } from "~/components/ui/select";
import { UserAvatar } from "~/components/user-avatar";
import { restrictionText } from "~/restriction";
import { LevelBadge } from "~/components/user-badges";
import { LEVEL_NAMES, levelName } from "../../../server/platform/site.ts";

import type { Route } from "./+types/members.ts";
import type { loader as adminLoader } from "./layout.tsx";

export function meta() {
  return [{ title: "成员 · 管理后台" }];
}

const STATUSES = [
  { value: "", label: "全部" },
  { value: "member", label: "成员" },
  { value: "frozen", label: "已冻结" },
  { value: "restricted", label: "被禁言或封禁" },
] as const;

const LEVELS = LEVEL_NAMES.map((_, level) => ({ value: String(level), label: levelName(level) }));

const ROLES = [
  { value: "user", label: "成员" },
  { value: "moderator", label: "版主" },
  { value: "admin", label: "管理员" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const q = search.get("q")?.trim() ?? "";
  const status = search.get("status") ?? "";
  const level = search.get("level") ?? "";
  const res = await context.get(apiContext).admin.members.$get({
    query: {
      q: q || undefined,
      status: status === "member" || status === "frozen" ? status : undefined,
      level: LEVELS.some((l) => l.value === level) ? level : undefined,
      restricted: status === "restricted" ? "true" : undefined,
      cursor: search.get("cursor") ?? undefined,
    },
  });
  if (!res.ok) throw new Error("Members failed");
  const page = await res.json();
  return { q, status, level, items: page.items, next_cursor: page.next_cursor };
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
  const { q, status, level, items, next_cursor } = loaderData;
  // From the admin layout: whether this is an admin or the owner, who may set roles.
  const admin = useRouteLoaderData<typeof adminLoader>("routes/admin/layout")?.rank !== "moderator";
  return (
    <>
      <h1 className="text-xl font-semibold">成员</h1>
      <Form className="mt-4 flex flex-wrap gap-2">
        <label className="flex h-9 min-w-48 flex-1 items-center gap-2 rounded-lg border px-3 text-sm focus-within:ring-2 focus-within:ring-ring/40">
          <Search className="size-4 text-muted-foreground" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="名字或 QQ 号"
            aria-label="名字或 QQ 号"
            className="w-full bg-transparent outline-none"
          />
        </label>
        <Select
          name="status"
          defaultValue={status}
          options={STATUSES}
          aria-label="状态"
          submitOnChange
          className="w-36 [&>button]:h-9"
        />
        <Select
          name="level"
          defaultValue={level}
          options={[{ value: "", label: "全部等级" }, ...LEVELS]}
          aria-label="等级"
          submitOnChange
          className="w-32 [&>button]:h-9"
        />
      </Form>
      {actionData && (
        <p role="alert" className="mt-3 text-meta text-destructive">
          {actionData.message}
        </p>
      )}
      <ul className="mt-4 divide-y rounded-2xl border bg-card">
        {items.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
            {/* A line of its own on phones, the badges and switches below it. */}
            <Link
              to={`/u/${m.id}`}
              className="flex min-w-0 flex-1 basis-full items-center gap-2.5 sm:basis-0"
            >
              <UserAvatar user={m} className="size-8" />
              <span className="min-w-0">
                <span className="block truncate font-medium">{m.display_name}</span>
                <span className="text-meta text-muted-foreground">
                  {m.qq ?? "站长账号"} · 最近 <Time value={m.last_seen_at} never="没来过" /> ·{" "}
                  {m.thread_count} 帖子 {m.post_count} 回复
                </span>
              </span>
            </Link>
            <span className="flex flex-wrap gap-1">
              {m.member_status === "frozen" && <Badge>已冻结</Badge>}
              {!m.activated && <Badge>未激活</Badge>}
              {m.restriction && <Badge>{restrictionText(m.restriction)}</Badge>}
            </span>
            {admin && m.role !== "bot" && m.role !== "owner" ? (
              <Form method="post" className="flex items-center gap-1">
                <input type="hidden" name="intent" value="level" />
                <input type="hidden" name="id" value={m.id} />
                <input type="hidden" name="current" value={m.level} />
                {m.level_locked && (
                  <Lock aria-label="等级已锁定" className="size-3.5 text-muted-foreground" />
                )}
                <Select
                  name="level"
                  defaultValue={m.level_locked ? String(m.level) : ""}
                  options={[{ value: "", label: `自动（${levelName(m.level)}）` }, ...LEVELS]}
                  aria-label={`${m.display_name} 的等级`}
                  submitOnChange
                  className="w-40"
                />
              </Form>
            ) : (
              <LevelBadge level={m.level} />
            )}
            {admin && m.role !== "bot" && m.role !== "owner" ? (
              <Form method="post" className="flex items-center gap-1">
                <input type="hidden" name="intent" value="role" />
                <input type="hidden" name="id" value={m.id} />
                {m.role_locked && (
                  <Lock aria-label="角色已锁定" className="size-3.5 text-muted-foreground" />
                )}
                <Select
                  name="role"
                  defaultValue={m.role_locked ? m.role : ""}
                  options={[
                    { value: "", label: `按群（${ROLES.find((r) => r.value === m.role)?.label}）` },
                    ...ROLES,
                  ]}
                  aria-label={`${m.display_name} 的角色`}
                  submitOnChange
                  className="w-36"
                />
              </Form>
            ) : (
              <Badge>
                {m.role === "bot"
                  ? "bot"
                  : m.role === "owner"
                    ? "站长"
                    : ROLES.find((r) => r.value === m.role)?.label}
              </Badge>
            )}
          </li>
        ))}
        {items.length === 0 && (
          <li className="px-4 py-12 text-center text-sm text-muted-foreground">没有找到</li>
        )}
      </ul>
      {next_cursor !== null && (
        <Link
          to={`?${new URLSearchParams({ q, status, level, cursor: next_cursor })}`}
          className="mt-4 block text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更早的
        </Link>
      )}
    </>
  );
}
