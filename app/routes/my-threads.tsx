import { pageTitle } from "~/share-meta";
import { data, redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import { ThreadPages } from "~/components/thread-feed";
import { unixNow } from "~/time";
import type { Route } from "./+types/my-threads.ts";

// The reader's own lists in the sidebar, by the path after /my/.
const LISTS = [
  { name: "posts", view: "posted", title: "我的帖子", empty: "暂无帖子或回复" },
  {
    name: "bookmarks",
    view: "bookmarked",
    title: "收藏",
    empty: "暂无收藏。在帖子底部点击「收藏」后会显示在这里",
  },
  { name: "read", view: "read", title: "已读", empty: "暂无已读的帖子" },
] as const;

function listOf(name: string) {
  const list = LISTS.find((l) => l.name === name);
  if (!list) throw data("页面不存在", { status: 404 });
  return list;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: pageTitle(loaderData.list.title) }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const list = listOf(params.list);
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  const res = await context.get(apiContext).threads.$get({ query: { view: list.view, cursor } });
  if (res.status === 401) return redirect("/login");
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return { list, threads: page.items, next_cursor: page.next_cursor, now: unixNow() };
}

export default function MyThreads({ loaderData }: Route.ComponentProps) {
  const { list, threads, next_cursor, now } = loaderData;
  return (
    <section>
      <h1 className="mb-4 px-1 text-xl font-semibold">{list.title}</h1>
      {threads.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">{list.empty}</p>
      ) : (
        <ThreadPages first={{ threads, next_cursor, now }} showBoard />
      )}
    </section>
  );
}
