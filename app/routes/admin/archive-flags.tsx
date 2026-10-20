import { Form, Link, useNavigation } from "react-router";
import { Check, ChevronRight, EyeOff, Flag } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { apiContext } from "../../api.server.ts";
import { readForm, Result, Time } from "~/components/form-parts";
import { Button } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import type { Route } from "./+types/archive-flags.ts";

export function meta() {
  return [{ title: pageTitle("收录有误", "管理后台") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin["archive-flags"].$get();
  if (!res.ok) throw new Error("Archive flags failed");
  return res.json();
}

// Hiding the floor (the thread, for its opening post) also clears its flags; so does finding it
// fine.
export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext);
  const post = { id: field("id") };
  if (field("intent") === "hide") {
    const json = { status: "hidden" as const, reason: "收录有误" };
    const res =
      field("floor") === "1"
        ? await api.threads[":id"].$patch({ param: { id: field("thread_id") }, json })
        : await api.posts[":id"].$patch({ param: post, json });
    if (!res.ok) return { ok: false, message: (await res.json()).error.message };
  }
  const res = await api.admin["archive-flags"][":id"].$delete({ param: post });
  if (res.ok) return { ok: true, message: field("intent") === "hide" ? "已隐藏" : "已处理" };
  return { ok: false, message: (await res.json()).error.message };
}

// Floors collected from the group chats that members flagged as wrongly collected, the most
// flagged first (design §6.5).
export default function ArchiveFlags({ loaderData, actionData }: Route.ComponentProps) {
  const { items } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">收录有误</h1>
        <Result result={actionData} />
      </div>
      <p className="mt-1 text-meta text-muted-foreground">
        成员认为不该收录的群聊楼层，比如串台、截断或答非所问。查看后隐藏这一层，或者确认没有问题。
      </p>
      {items.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">暂无待处理的反馈</p>
      )}
      <ul className="mt-4 flex flex-col gap-3">
        {items.map(({ post, count, flagged_at }) => (
          <li key={post.id} className="rounded-2xl border bg-card p-4">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded bg-warning/10 px-1.5 py-px font-medium text-warning">
                <Flag className="size-3.5" />
                {count} 人反馈
              </span>
              最近 <Time value={flagged_at} />
            </div>
            <Link
              to={`/t/${post.thread.id}${post.floor > 1 ? `?floor=${post.floor}` : ""}`}
              className="group mt-3 block rounded-xl bg-secondary/50 px-3 py-2.5 hover:bg-secondary"
            >
              <span className="flex items-start justify-between gap-2 text-meta font-medium">
                <span>
                  {post.thread.title}
                  {post.floor > 1 && ` · #${post.floor}`}
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </span>
              <span className="mt-1.5 flex gap-1.5 text-sm">
                <UserAvatar
                  user={post.author}
                  thread={post.thread.id}
                  className="size-5 shrink-0 text-2xs"
                />
                <span className="line-clamp-3">
                  {post.author.display_name}：{post.excerpt}
                </span>
              </span>
              <span className="mt-1.5 block text-xs text-muted-foreground">
                群里发于 <Time value={post.created_at} />
              </span>
            </Link>
            <Form method="post" className="mt-3 flex flex-wrap gap-2">
              <input type="hidden" name="id" value={post.id} />
              <input type="hidden" name="thread_id" value={post.thread.id} />
              <input type="hidden" name="floor" value={post.floor} />
              <Button name="intent" value="hide" size="sm" variant="outline" disabled={busy}>
                <EyeOff /> {post.floor === 1 ? "隐藏帖子" : "隐藏这一层"}
              </Button>
              <Button name="intent" value="dismiss" size="sm" variant="ghost" disabled={busy}>
                <Check /> 没有问题
              </Button>
            </Form>
          </li>
        ))}
      </ul>
    </>
  );
}
