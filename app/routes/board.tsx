import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import { readFilter, ThreadFeed } from "~/components/thread-feed";
import { unixNow } from "~/time";
import type { Route } from "./+types/board.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData.board.name} · 鼠洞` }];
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const { view, tag, cursor } = readFilter(request.url);
  const [boardRes, res] = await Promise.all([
    api.boards[":slug"].$get({ param: { slug: params.slug } }),
    api.threads.$get({
      query: { board: params.slug, view, tag: tag ?? undefined, cursor: cursor ?? undefined },
    }),
  ]);
  if (!boardRes.ok) throw data("版块不存在", { status: 404 });
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return {
    board: await boardRes.json(),
    view,
    tag,
    threads: page.items,
    next_cursor: page.next_cursor,
    now: unixNow(),
  };
}

export default function Board({ loaderData }: Route.ComponentProps) {
  const { board } = loaderData;
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
            {board.thread_count.toLocaleString()} 个主题
          </p>
        </div>
      </header>
      <ThreadFeed {...loaderData} />
    </>
  );
}
