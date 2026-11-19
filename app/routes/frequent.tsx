import type { ReactNode } from "react";
import { data, Link } from "react-router";
import { cn } from "~/cn";
import { CalendarCheck, Sparkle } from "~/components/icons";
import { Pages, type Loaded } from "~/components/pages";
import { ThreadList, ThreadRow } from "~/components/thread-list";
import { shareMeta } from "~/share-meta";
import { unixNow } from "~/time";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/frequent.ts";

const DESCRIPTION =
  "近 90 天里有 3 天以上有人讨论的问答帖，群里收录的提问也算。提问前可以先在这里查找";

export function meta({ loaderData }: Route.MetaArgs) {
  const { tag } = loaderData;
  return shareMeta([...(tag === null ? [] : [`#${tag}`]), "高频问题"], DESCRIPTION);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const tag = params.get("tag");
  const res = await context.get(apiContext).threads.frequent.$get({
    query: { tag: tag ?? undefined, cursor: params.get("cursor") ?? undefined },
  });
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return { tag, ...page, now: unixNow() };
}

// The pages each entry of the history showed (components/pages.tsx).
const kept = new Map<string, Loaded<typeof loader>[]>();

function TopicLink({
  tag,
  chosen,
  children,
}: {
  tag: string | null;
  chosen: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to={tag === null ? "/frequent" : `/frequent?tag=${encodeURIComponent(tag)}`}
      aria-current={chosen ? "page" : undefined}
      className={cn(
        "rounded-full px-3 py-1 text-meta text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
        chosen && "bg-secondary font-medium text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

export default function Frequent({ loaderData }: Route.ComponentProps) {
  const { tag, topics, items } = loaderData;
  return (
    <section className="flex flex-col gap-4">
      <header className="px-1">
        <h1 className="text-xl font-semibold">高频问题</h1>
        <p className="mt-1 text-meta text-muted-foreground">{DESCRIPTION}</p>
      </header>
      {topics.length > 0 && (
        <nav aria-label="按话题筛选" className="flex flex-wrap gap-1.5">
          <TopicLink tag={null} chosen={tag === null}>
            全部
          </TopicLink>
          {topics.map((t) => (
            <TopicLink key={t.name} tag={t.name} chosen={t.name === tag}>
              #{t.name}
              <span className="ml-1 text-muted-foreground tabular-nums">{t.count}</span>
            </TopicLink>
          ))}
        </nav>
      )}
      {items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">暂无高频问题</p>
      ) : (
        <ThreadList>
          <Pages<typeof loader> kept={kept} first={loaderData} next={(page) => page.next_cursor}>
            {(page) =>
              page.items.map(({ thread, days, lead }) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  now={page.now}
                  showBoard
                  meta={
                    <span className="flex items-center gap-1 font-medium text-primary">
                      <CalendarCheck className="size-3.5" />
                      {days} 天有人讨论
                    </span>
                  }
                >
                  {lead !== null && (
                    <p className="mt-1.5 flex gap-1.5 text-meta text-muted-foreground">
                      <Sparkle
                        aria-label="AI 总结"
                        className="mt-0.5 size-3.5 shrink-0 text-brand-strong"
                      />
                      <span className="line-clamp-2">{lead}</span>
                    </p>
                  )}
                </ThreadRow>
              ))
            }
          </Pages>
        </ThreadList>
      )}
    </section>
  );
}
