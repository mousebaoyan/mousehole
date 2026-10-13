import { data, redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import { More } from "~/components/thread-feed";
import { ThreadList } from "~/components/thread-list";
import { unixNow } from "~/time";
import type { Route } from "./+types/my-bookmarks.ts";

export function meta() {
  return [{ title: "收藏 · 鼠洞" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  const res = await context.get(apiContext).threads.$get({ query: { view: "bookmarked", cursor } });
  if (res.status === 401) return redirect("/login");
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return { threads: page.items, next_cursor: page.next_cursor, now: unixNow() };
}

// Latest bookmarked first.
export default function Bookmarks({ loaderData }: Route.ComponentProps) {
  const { threads, next_cursor, now } = loaderData;
  return (
    <section>
      <h1 className="mb-4 px-1 text-xl font-semibold">收藏</h1>
      {threads.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          还没有收藏的主题，在主题底部点「收藏」就会出现在这里
        </p>
      ) : (
        <ThreadList threads={threads} now={now} showBoard>
          {next_cursor !== null && <More cursor={next_cursor} showBoard />}
        </ThreadList>
      )}
    </section>
  );
}
