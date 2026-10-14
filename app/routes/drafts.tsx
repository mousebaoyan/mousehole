import { PenSquare, Reply, Trash2 } from "lucide-react";
import { Form, redirect, useNavigate } from "react-router";
import { apiContext } from "../api.server.ts";
import { useComposer } from "~/components/composer";
import { Button } from "~/components/ui/button";
import { confirmSubmit } from "~/components/ui/dialog";
import { ago, unixNow } from "~/time";
import type { Route } from "./+types/drafts.ts";
import { SITE_NAME } from "../../server/platform/site.ts";

export function meta() {
  return [{ title: `草稿 · ${SITE_NAME}` }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).me.drafts.$get();
  if (!res.ok) return redirect("/login");
  return { drafts: (await res.json()).items, now: unixNow() };
}

// Discarding one; the layout loads again, so the sidebar and the composer see it gone.
export async function action({ request, context }: Route.ActionArgs) {
  const key = (await request.formData()).get("key");
  if (typeof key === "string") {
    await context.get(apiContext).me.drafts[":key"].$delete({ param: { key } });
  }
  return null;
}

// Everything still being written; going on with one opens it in the composer (design §8.2).
export default function Drafts({ loaderData: { drafts, now } }: Route.ComponentProps) {
  const open = useComposer();
  const navigate = useNavigate();
  return (
    <section>
      <h1 className="mb-4 px-1 text-xl font-semibold">草稿</h1>
      {drafts.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">没有草稿</p>
      )}
      <ul className="divide-y rounded-2xl border bg-card">
        {drafts.map(({ thread, title, excerpt, updated_at }) => (
          <li key={thread?.id ?? "new"} className="flex items-start gap-3 px-4 py-3">
            {thread ? (
              <Reply className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <PenSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {thread ? `回复：${thread.title}` : title || "没有标题的新帖"}
              </p>
              {excerpt && (
                <p className="mt-0.5 line-clamp-2 text-meta text-muted-foreground">{excerpt}</p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">{ago(updated_at, now)}保存</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (thread) void navigate(`/t/${thread.id}`);
                open(
                  thread
                    ? { mode: "reply", thread, replyTo: null }
                    : { mode: "thread", board: null },
                );
              }}
            >
              继续写
            </Button>
            <Form method="post">
              <input type="hidden" name="key" value={thread?.id ?? "new"} />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="放弃这份草稿"
                title="放弃"
                onClick={confirmSubmit("放弃这份草稿？", "放弃")}
              >
                <Trash2 />
              </Button>
            </Form>
          </li>
        ))}
      </ul>
    </section>
  );
}
