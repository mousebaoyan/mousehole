import { data, Link, redirect } from "react-router";
import { Lock } from "~/components/icons";
import { apiContext } from "../api.server.ts";
import { feedTitle, readCounts, readFilter, ThreadFeed } from "~/components/thread-feed";
import { buttonVariants } from "~/components/ui/button";
import { useMe } from "~/forum";
import { shareMeta } from "~/share-meta";
import { unixNow } from "~/time";
import type { Route } from "./+types/board.ts";
import { SITE_NAME } from "../../server/platform/site.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  const { name, description } = loaderData.board;
  // A board above the reader's level has no list, and so no filters.
  const filters = loaderData.view ? feedTitle(loaderData.view, loaderData.tag ?? null) : [];
  return shareMeta([...filters, name], description || `${SITE_NAME}的${name}版块`);
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const { view, tag, cursor } = readFilter(request.url);
  const scope = { board: params.slug, tag: tag ?? undefined };
  const [boardRes, res, counts] = await Promise.all([
    api.boards[":slug"].$get({ param: { slug: params.slug } }),
    api.threads.$get({ query: { ...scope, view, cursor: cursor ?? undefined } }),
    readCounts(api, scope, cursor),
  ]);
  if (!boardRes.ok) throw data("版块不存在", { status: 404 });
  if (res.status === 401) return redirect("/login");
  // A member short of the board's level (design §8.10).
  if (res.status === 403) {
    return { board: await boardRes.json(), locked: (await res.json()).error.message };
  }
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return {
    board: await boardRes.json(),
    view,
    tag,
    counts,
    threads: page.items,
    next_cursor: page.next_cursor,
    now: unixNow(),
  };
}

export default function Board({ loaderData }: Route.ComponentProps) {
  const { board } = loaderData;
  const me = useMe();
  return (
    <>
      <header className="mb-5 flex items-start gap-4 px-1">
        <span
          className="mt-1.5 size-3 shrink-0 rounded-full"
          style={{ backgroundColor: board.color }}
        />
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{board.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {board.description && `${board.description} · `}
            {board.thread_count.toLocaleString()} 个帖子
          </p>
        </div>
      </header>
      {"locked" in loaderData ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Lock className="size-8 text-muted-foreground" />
          <p className="text-muted-foreground">{loaderData.locked}</p>
          {me && (
            <Link to={`/u/${me.id}`} className={buttonVariants({ variant: "outline" })}>
              查看升级进度
            </Link>
          )}
        </div>
      ) : (
        <ThreadFeed {...loaderData} />
      )}
    </>
  );
}
