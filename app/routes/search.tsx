import { Search as SearchIcon } from "lucide-react";
import { Fragment, useRef } from "react";
import { data, Form, Link, useFetcher, useLocation } from "react-router";
import { apiContext } from "../api.server.ts";
import { BoardBadge } from "~/components/board-badge";
import { UserAvatar } from "~/components/user-avatar";
import { useNearView } from "~/near-view";
import { ago, unixNow } from "~/time";
import type { Route } from "./+types/search.ts";
import { SITE_NAME } from "../../server/platform/site.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: loaderData.q ? `${loaderData.q} · 搜索 · ${SITE_NAME}` : `搜索 · ${SITE_NAME}` },
  ];
}

// Threads and replies for ?q=, a page at a time; on the first page, also members by name for
// those signed in.
export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const search = new URL(request.url).searchParams;
  const q = search.get("q")?.trim().slice(0, 100) ?? "";
  const cursor = search.get("cursor") ?? undefined;
  if (q === "") return { q, results: [], users: [], next_cursor: null, now: unixNow() };
  const [res, people] = await Promise.all([
    api.search.$get({ query: { q, cursor } }),
    cursor === undefined ? api.users.$get({ query: { q: q.slice(0, 20) } }) : null,
  ]);
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return {
    q,
    results: page.items,
    users: people?.ok ? (await people.json()).items : [],
    next_cursor: page.next_cursor,
    now: unixNow(),
  };
}

type Result = Route.ComponentProps["loaderData"]["results"][number];

export default function Search({ loaderData }: Route.ComponentProps) {
  const { q, results, users, next_cursor, now } = loaderData;
  return (
    <section>
      <Form className="mb-5 flex h-11 items-center gap-2 rounded-full bg-secondary px-4 focus-within:ring-2 focus-within:ring-ring/40">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          type="search"
          name="q"
          defaultValue={q}
          key={q}
          aria-label="搜索"
          placeholder="搜索帖子、回复、用户"
          maxLength={100}
          className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </Form>
      {users.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 px-1">
          {users.map((u) => (
            <Link
              key={u.id}
              to={`/u/${u.id}`}
              className="inline-flex items-center gap-1.5 rounded-full border bg-card py-1 pr-3 pl-1 text-sm hover:bg-accent"
            >
              <UserAvatar user={u} className="size-6 text-2xs" />
              {u.display_name}
            </Link>
          ))}
        </div>
      )}
      {q !== "" && results.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">没有找到相关的内容</p>
      )}
      <ul>
        <Results results={results} q={q} now={now} />
        {next_cursor !== null && <More cursor={next_cursor} />}
      </ul>
    </section>
  );
}

function Results({ results, q, now }: { results: Result[]; q: string; now: number }) {
  return results.map((r) => (
    <li
      key={r.thread.id}
      className="relative rounded-xl px-3 py-3.5 before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden hover:bg-accent/60 sm:px-4"
    >
      <Link
        to={r.post.floor > 1 ? `/t/${r.thread.id}?floor=${r.post.floor}` : `/t/${r.thread.id}`}
        className="font-medium after:absolute after:inset-0"
      >
        <Marked text={r.thread.title} q={q} />
      </Link>
      <p className="mt-1 line-clamp-2 text-meta text-foreground/80">
        <Marked text={r.snippet} q={q} />
      </p>
      <p className="relative mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <BoardBadge board={r.thread.board} />
        {r.post.floor > 1 && <span>#{r.post.floor}</span>}
        <span>{r.thread.reply_count} 条回复</span>
        <span>{ago(r.thread.last_post_at, now)}</span>
      </p>
    </li>
  ));
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

// The words of the query marked where they appear, ignoring case.
function Marked({ text, q }: { text: string; q: string }) {
  const words = q.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map((w) => w.replaceAll(ESCAPE, "\\$&")).join("|")})`, "gi");
  return text
    .split(pattern)
    .map((part, i) => (
      <Fragment key={i}>
        {i % 2 === 1 ? <mark className="rounded-sm bg-brand/20 text-inherit">{part}</mark> : part}
      </Fragment>
    ));
}

// The next page loads when its link comes near the screen, as the thread lists do.
function More({ cursor }: { cursor: string }) {
  const { load, state, data: page } = useFetcher<typeof loader>();
  const link = useRef<HTMLAnchorElement>(null);
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("cursor", cursor);
  const href = `/search?${params}`;
  useNearView(link, state === "idle" && !page, () => void load(href));
  if (!page) {
    return (
      <li className="py-4 text-center text-meta">
        <a ref={link} href={href} className="text-muted-foreground hover:text-foreground">
          {state === "loading" ? "加载中…" : "加载更多"}
        </a>
      </li>
    );
  }
  return (
    <>
      <Results results={page.results} q={page.q} now={page.now} />
      {page.next_cursor !== null && <More cursor={page.next_cursor} />}
    </>
  );
}
