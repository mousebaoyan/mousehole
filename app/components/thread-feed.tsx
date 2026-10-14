import { useRef } from "react";
import { Link, useFetcher, useLocation } from "react-router";
import { cn } from "cn";
import type { Api, ThreadItem } from "~/api-types";
import { NewThreadButton } from "~/components/composer";
import { Dot, FilterMenu } from "~/components/filter-menu";
import { ThreadList, ThreadRows } from "~/components/thread-list";
import { useBoards, useTags, type Board } from "~/forum";
import { useNearView } from "~/near-view";

// New and unread are the reader's own (design §8.9): only for someone signed in, with how many.
const VIEWS = [
  { view: "latest", label: "最新", own: false },
  { view: "new", label: "新", own: true },
  { view: "unread", label: "未读", own: true },
  { view: "hot", label: "热门", own: false },
  { view: "unsolved", label: "待解答", own: false },
] as const;

export type ThreadView = (typeof VIEWS)[number]["view"];

// The list filters in a page URL: ?view=hot&tag=夏令营&cursor=…
export function readFilter(url: string) {
  const params = new URL(url).searchParams;
  return {
    view: VIEWS.find((v) => v.view === params.get("view"))?.view ?? "latest",
    tag: params.get("tag"),
    cursor: params.get("cursor"),
  };
}

// For the first page of a list: the counts beside new and unread, null for guests.
export async function readCounts(
  api: Api,
  scope: { board?: string; tag?: string },
  cursor: string | null,
) {
  if (cursor !== null) return null;
  const res = await api.threads.counts.$get({ query: scope });
  return res.ok ? res.json() : null;
}

const KINDS = [
  { kind: "topic", label: "话题" },
  { kind: "school", label: "院校" },
  { kind: "major", label: "方向" },
];

// The tags as filter choices, grouped by kind; the lists and search both offer them.
export function tagChoices(
  tags: { id: number; name: string; kind: string }[],
  chosen: string | null,
  to: (name: string) => string,
) {
  return KINDS.flatMap((k) =>
    tags
      .filter((t) => t.kind === k.kind)
      .map((t) => ({
        to: to(t.name),
        label: `#${t.name}`,
        chosen: t.name === chosen,
        group: k.label,
      })),
  );
}

// Board in the path, the rest in the query; defaults are left out.
function listUrl(board: string | null, tag: string | null, view: ThreadView) {
  const params = new URLSearchParams();
  if (view !== "latest") params.set("view", view);
  if (tag !== null) params.set("tag", tag);
  return `${board === null ? "/" : `/b/${board}`}${params.size > 0 ? `?${params}` : ""}`;
}

type Page = { threads: ThreadItem[]; next_cursor: string | null; now: number };

export type Counts = { new: number; unread: number };

// The board and tag filters stack, and both keep the current view. `counts` is null for guests.
export function ThreadFeed({
  threads,
  next_cursor,
  now,
  view,
  tag,
  board,
  counts,
}: Page & { view: ThreadView; tag: string | null; board: Board | null; counts: Counts | null }) {
  const boards = useBoards();
  const tags = useTags();
  const slug = board === null ? null : board.slug;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <div className="flex gap-2 max-sm:w-full">
          <FilterMenu
            label="按版块筛选"
            trigger={
              <>
                {board && <Dot color={board.color} />}
                {board ? board.name : "全部版块"}
              </>
            }
            choices={[
              { to: listUrl(null, tag, view), label: "全部版块", chosen: board === null },
              ...boards.map((b) => ({
                to: listUrl(b.slug, tag, view),
                label: (
                  <>
                    <Dot color={b.color} />
                    {b.name}
                  </>
                ),
                chosen: b.slug === slug,
              })),
            ]}
          />
          <FilterMenu
            label="按标签筛选"
            trigger={tag === null ? "全部标签" : `#${tag}`}
            choices={[
              { to: listUrl(slug, null, view), label: "全部标签", chosen: tag === null },
              ...tagChoices(tags, tag, (name) => listUrl(slug, name, view)),
            ]}
          />
          {/* Wider screens have this in the header. */}
          <NewThreadButton board={slug} size="sm" className="ml-auto h-8 sm:hidden" />
        </div>
        <nav
          aria-label="帖子列表"
          className="-mx-1 flex overflow-x-auto px-1 [scrollbar-width:none] max-sm:w-full"
        >
          {VIEWS.filter((v) => !v.own || counts).map((v) => {
            const count = v.view === "new" || v.view === "unread" ? counts?.[v.view] : undefined;
            return (
              <Link
                key={v.view}
                to={listUrl(slug, tag, v.view)}
                aria-current={v.view === view ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground",
                  v.view === view && "bg-secondary font-medium text-foreground",
                )}
              >
                {v.label}
                {count !== undefined && count > 0 && (
                  <span className="ml-1 text-primary tabular-nums">{count}</span>
                )}
              </Link>
            );
          })}
        </nav>
      </div>
      {threads.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">还没有帖子</p>
      ) : (
        <ThreadList threads={threads} now={now} showBoard={board === null}>
          {next_cursor !== null && <More cursor={next_cursor} showBoard={board === null} />}
        </ThreadList>
      )}
    </section>
  );
}

// The next page loads when its link comes near the screen; without JavaScript the link opens it.
// Each page brings the link to the one after it.
export function More({ cursor, showBoard }: { cursor: string; showBoard: boolean }) {
  const { load, state, data } = useFetcher<Page>();
  const link = useRef<HTMLAnchorElement>(null);
  const { pathname, search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("cursor", cursor);
  const href = `${pathname}?${params}`;
  // The home page is an index route, which fetchers reach only with ?index.
  const url = pathname === "/" ? `/?index&${params}` : href;
  useNearView(link, state === "idle" && !data, () => void load(url));

  if (!data) {
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
      <ThreadRows threads={data.threads} now={data.now} showBoard={showBoard} />
      {data.next_cursor !== null && <More cursor={data.next_cursor} showBoard={showBoard} />}
    </>
  );
}
