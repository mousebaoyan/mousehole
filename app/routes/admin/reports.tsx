import { Check, X } from "lucide-react";
import { Form, Link, useNavigation } from "react-router";
import { cn } from "cn";
import { apiContext } from "../../api.server.ts";
import { readForm, Time } from "~/components/form-parts";
import { Button } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import type { Route } from "./+types/reports.ts";

export function meta() {
  return [{ title: "举报 · 管理后台" }];
}

const TABS = [
  { status: "open", label: "待处理" },
  { status: "resolved", label: "已处理" },
  { status: "dismissed", label: "已驳回" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const status = TABS.find((t) => t.status === search.get("status"))?.status ?? "open";
  const res = await context
    .get(apiContext)
    .admin.reports.$get({ query: { status, cursor: search.get("cursor") ?? undefined } });
  if (!res.ok) throw new Error("Reports failed");
  const page = await res.json();
  return { status, items: page.items, next_cursor: page.next_cursor };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  await context.get(apiContext).admin.reports[":id"].$patch({
    param: { id: field("id") },
    json: { status: field("status") === "dismissed" ? "dismissed" : "resolved" },
  });
  return null;
}

// What was reported and why; handling it is separate from acting on the content, which is done
// on the floor itself.
export default function Reports({ loaderData }: Route.ComponentProps) {
  const { status, items, next_cursor } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <>
      <h1 className="text-xl font-semibold">举报</h1>
      <nav aria-label="举报" className="mt-4 flex gap-1">
        {TABS.map((t) => (
          <Link
            key={t.status}
            to={t.status === "open" ? "." : `?status=${t.status}`}
            aria-current={t.status === status ? "page" : undefined}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground",
              t.status === status && "bg-secondary font-medium text-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {items.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          没有{TABS.find((t) => t.status === status)?.label}的举报
        </p>
      )}
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((r) => (
          <li key={r.id} className="rounded-2xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
              <span className="rounded bg-destructive/10 px-1.5 py-px font-medium text-destructive">
                {r.reason}
              </span>
              <span className="text-muted-foreground">
                {r.reporter.display_name} 举报于 <Time value={r.created_at} />
              </span>
              {r.handler && (
                <span className="text-muted-foreground">
                  · {r.handler.display_name} 处理于 <Time value={r.handled_at} />
                </span>
              )}
            </div>
            <Link
              to={`/t/${r.post.thread.id}?floor=${r.post.floor}`}
              className="mt-3 block rounded-xl bg-secondary/50 px-3 py-2.5 hover:bg-secondary"
            >
              <span className="text-meta font-medium">
                {r.post.thread.title} · #{r.post.floor}
                {r.post.deleted && <span className="ml-2 text-muted-foreground">（已删除）</span>}
              </span>
              {r.boost ? (
                <span className="mt-1.5 flex items-center gap-1.5 text-sm">
                  <UserAvatar user={r.boost.user} className="size-5 text-2xs" />
                  {r.boost.user.display_name} 的短评：{r.boost.body}
                </span>
              ) : (
                <span className="mt-1.5 flex gap-1.5 text-sm">
                  <UserAvatar user={r.post.author} className="size-5 shrink-0 text-2xs" />
                  <span className="line-clamp-3">
                    {r.post.author.display_name}：{r.post.excerpt}
                  </span>
                </span>
              )}
            </Link>
            {status === "open" && (
              <Form method="post" className="mt-3 flex gap-2">
                <input type="hidden" name="id" value={r.id} />
                <Button name="status" value="resolved" size="sm" disabled={busy}>
                  <Check /> 已处理
                </Button>
                <Button name="status" value="dismissed" size="sm" variant="outline" disabled={busy}>
                  <X /> 驳回
                </Button>
              </Form>
            )}
          </li>
        ))}
      </ul>
      {next_cursor !== null && (
        <Link
          to={`?${new URLSearchParams({ status, cursor: next_cursor })}`}
          className="mt-4 block text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更早的
        </Link>
      )}
    </>
  );
}
