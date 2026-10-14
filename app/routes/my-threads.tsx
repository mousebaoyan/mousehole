import { data, redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import { More } from "~/components/thread-feed";
import { ThreadList } from "~/components/thread-list";
import { unixNow } from "~/time";
import type { Route } from "./+types/my-threads.ts";

// The reader's own lists in the sidebar, by the path after /my/.
const LISTS = [
  { name: "posts", view: "posted", title: "我的帖子", empty: "还没有发过帖子或回复" },
  {
    name: "bookmarks",
    view: "bookmarked",
    title: "收藏",
    empty: "还没有收藏的帖子，在帖子底部点「收藏」就会出现在这里",
  },
  { name: "read", view: "read", title: "已读", empty: "还没有读过的帖子" },
] as const;

function listOf(name: string) {
  const list = LISTS.find((l) => l.name === name);
  if (!list) throw data("页面不存在", { status: 404 });
  return list;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData.list.title} · 鼠洞` }];
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
        <ThreadList threads={threads} now={now} showBoard>
          {next_cursor !== null && <More cursor={next_cursor} showBoard />}
        </ThreadList>
      )}
    </section>
  );
}
