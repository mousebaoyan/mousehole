import { data, Link, redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import { ChartBar, ChevronRight } from "~/components/icons";
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
  const { view, tag, counts } = loaderData;
  // The plain first page tells members how many polls wait for their vote (design §8.11); the
  // counts are there only for someone signed in, on a first page.
  const unvoted = view === "latest" && tag === null && counts ? counts.unvoted : 0;
  return (
    <>
      {unvoted > 0 && (
        <Link
          to="/?view=unvoted"
          className="mb-3 flex items-center gap-2.5 rounded-xl bg-primary/8 px-3.5 py-2.5 text-sm transition-colors hover:bg-primary/12"
        >
          <ChartBar className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">
            还有 <span className="font-semibold text-primary tabular-nums">{unvoted}</span>{" "}
            个投票等你参与
          </span>
          <span className="flex shrink-0 items-center text-meta text-primary">
            去投票
            <ChevronRight className="size-4" />
          </span>
        </Link>
      )}
      <ThreadFeed {...loaderData} board={null} />
    </>
  );
}
