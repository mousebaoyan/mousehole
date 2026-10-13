import { data, redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import { readCounts, readFilter, ThreadFeed } from "~/components/thread-feed";
import { unixNow } from "~/time";
import type { Route } from "./+types/home.ts";

export function meta() {
  return [{ title: "鼠洞 · 四非计算机保研鼠群的论坛" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const { view, tag, cursor } = readFilter(request.url);
  const scope = { tag: tag ?? undefined };
  const [res, counts] = await Promise.all([
    api.threads.$get({ query: { ...scope, view, cursor: cursor ?? undefined } }),
    readCounts(api, scope, cursor),
  ]);
  if (res.status === 401) return redirect("/login");
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return { view, tag, counts, threads: page.items, next_cursor: page.next_cursor, now: unixNow() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return <ThreadFeed {...loaderData} board={null} />;
}
