import { data, Link, redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import { ChartBar } from "~/components/icons";
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
  // The plain first page asks members to vote on 保研定位 threads (design §8.14).
  const asking = view === "latest" && tag === null && cursor === null;
  const [res, counts, awaiting] = await Promise.all([
    api.threads.$get({ query: { ...scope, view, cursor: cursor ?? undefined } }),
    readCounts(api, scope, cursor),
    asking ? api.threads["awaiting-votes"].$get() : null,
  ]);
  if (res.status === 401) return redirect("/login");
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return {
    view,
    tag,
    counts,
    threads: page.items,
    next_cursor: page.next_cursor,
    now: unixNow(),
    awaiting: awaiting?.ok ? (await awaiting.json()).items : [],
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <>
      {loaderData.awaiting.length > 0 && <AwaitingVotes threads={loaderData.awaiting} />}
      <ThreadFeed {...loaderData} board={null} />
    </>
  );
}

function AwaitingVotes({ threads }: { threads: Route.ComponentProps["loaderData"]["awaiting"] }) {
  return (
    <section aria-label="等你投票" className="mb-4 rounded-2xl border bg-card px-4 py-3">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-medium">
        <ChartBar className="size-4 text-primary" />
        等你投票
        <span className="text-meta font-normal text-muted-foreground">保研定位</span>
      </h2>
      <ul>
        {threads.map((t) => (
          <li key={t.id}>
            <Link to={`/t/${t.id}`} className="flex items-baseline gap-3 py-1.5 hover:text-primary">
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                {t.schools} 所院校 · {t.voter_count} 人已投
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
