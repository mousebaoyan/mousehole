import { Check, Eye, EyeOff } from "lucide-react";
import { Form, Link, useNavigation } from "react-router";
import { cn } from "cn";
import { apiContext } from "../../api.server.ts";
import { readForm, Result, Time } from "~/components/form-parts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { UserAvatar } from "~/components/user-avatar";
import type { Route } from "./+types/content.ts";

export function meta() {
  return [{ title: "内容 · 管理后台" }];
}

const TABS = [
  { status: "pending", label: "待审核" },
  { status: "hidden", label: "已隐藏" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const status = TABS.find((t) => t.status === search.get("status"))?.status ?? "pending";
  const res = await context
    .get(apiContext)
    .admin.content.$get({ query: { status, cursor: search.get("cursor") ?? undefined } });
  if (!res.ok) throw new Error("Content failed");
  const page = await res.json();
  return { status, items: page.items, next_cursor: page.next_cursor };
}

// A thread's opening post stands for the thread, whose status it follows.
export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext);
  const json = {
    status: field("status") === "hidden" ? ("hidden" as const) : ("visible" as const),
    reason: field("reason") || undefined,
  };
  const res =
    field("floor") === "1"
      ? await api.threads[":id"].$patch({ param: { id: field("thread_id") }, json })
      : await api.posts[":id"].$patch({ param: { id: field("id") }, json });
  if (res.ok) return { ok: true, message: json.status === "visible" ? "已公开" : "已隐藏" };
  return { ok: false, message: (await res.json()).error.message };
}

// What waits for review in boards reviewed before publishing, and what moderators have hidden.
export default function Content({ loaderData, actionData }: Route.ComponentProps) {
  const { status, items, next_cursor } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <>
      <h1 className="text-xl font-semibold">内容</h1>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav aria-label="内容" className="flex gap-1">
          {TABS.map((t) => (
            <Link
              key={t.status}
              to={t.status === "pending" ? "." : `?status=${t.status}`}
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
        <Result result={actionData} />
      </div>
      {items.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">
          没有{TABS.find((t) => t.status === status)?.label}的内容
        </p>
      )}
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((c) => (
          <li key={c.id} className="rounded-2xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
              <span className="rounded bg-secondary px-1.5 py-px font-medium text-foreground">
                {c.floor === 1 ? "帖子" : "回复"}
              </span>
              {c.board.name} · <Time value={c.created_at} />
            </div>
            <Link
              to={`/t/${c.thread_id}${c.floor > 1 ? `?floor=${c.floor}` : ""}`}
              className="mt-3 block rounded-xl bg-secondary/50 px-3 py-2.5 hover:bg-secondary"
            >
              <span className="text-meta font-medium">
                {c.title}
                {c.floor > 1 && ` · #${c.floor}`}
              </span>
              <span className="mt-1.5 flex gap-1.5 text-sm">
                <UserAvatar user={c.author} className="size-5 shrink-0 text-2xs" />
                <span className="line-clamp-3">
                  {c.author.display_name}：{c.excerpt}
                </span>
              </span>
            </Link>
            <Form method="post" className="mt-3 flex flex-wrap gap-2">
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="thread_id" value={c.thread_id} />
              <input type="hidden" name="floor" value={c.floor} />
              {status === "pending" ? (
                <>
                  <Input
                    name="reason"
                    maxLength={200}
                    placeholder="不通过的理由，会告诉作者；可以不填"
                    aria-label="理由"
                    className="h-8 min-w-0 basis-full sm:basis-72"
                  />
                  <Button name="status" value="visible" size="sm" disabled={busy}>
                    <Check /> 通过
                  </Button>
                  <Button name="status" value="hidden" size="sm" variant="outline" disabled={busy}>
                    <EyeOff /> 不通过
                  </Button>
                </>
              ) : (
                <Button name="status" value="visible" size="sm" variant="outline" disabled={busy}>
                  <Eye /> 恢复显示
                </Button>
              )}
            </Form>
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
