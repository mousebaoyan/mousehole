import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import { readFilter, ThreadFeed } from "~/components/thread-feed";
import { unixNow } from "~/time";
import type { Route } from "./+types/home.ts";

export function meta() {
  return [{ title: "鼠洞 · 四非计算机保研鼠群的论坛" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { view, tag, cursor } = readFilter(request.url);
  const res = await context.get(apiContext).threads.$get({
    query: { view, tag: tag ?? undefined, cursor: cursor ?? undefined },
  });
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return { view, tag, threads: page.items, next_cursor: page.next_cursor, now: unixNow() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return <ThreadFeed {...loaderData} board={null} />;
}
