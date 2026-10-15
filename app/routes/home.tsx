import { data, redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import { feedTitle, readCounts, readFilter, ThreadFeed } from "~/components/thread-feed";
import { shareMeta } from "~/share-meta";
import { unixNow } from "~/time";
import type { Route } from "./+types/home.ts";
import { SITE_NAME, SITE_DESCRIPTION } from "../../server/platform/site.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return shareMeta(
    [...feedTitle(loaderData.view, loaderData.tag), "全部帖子"],
    `${SITE_DESCRIPTION}：保研经验、院校信息、夏令营和预推免`,
    SITE_NAME,
  );
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
