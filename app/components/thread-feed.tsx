import { Check, ChevronDown, PenSquare } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { cn } from "cn";
import { Dropdown, menuItem } from "~/components/disclosure";
import { ThreadList } from "~/components/thread-list";
import { boards, tags, type Board, type Thread, type ThreadView } from "~/draft-data";
import { useMe } from "~/me";

// New and unread depend on what the reader has read, so only members see them.
const VIEWS: { view: ThreadView; label: string; mine?: boolean }[] = [
  { view: "latest", label: "最新" },
  { view: "new", label: "新", mine: true },
  { view: "unread", label: "未读", mine: true },
  { view: "hot", label: "热门" },
  { view: "unsolved", label: "待解答" },
];

const FILTER =
  "inline-flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 text-sm hover:bg-accent";

// Board in the path, the rest in the query; defaults are left out.
function listUrl(board: string | null, tag: string | null, view: ThreadView) {
  const params = new URLSearchParams();
  if (view !== "latest") params.set("view", view);
  if (tag !== null) params.set("tag", tag);
  return `${board === null ? "/" : `/b/${board}`}${params.size > 0 ? `?${params}` : ""}`;
}

// The board and tag filters stack, and both keep the current view.
export function ThreadFeed({
  threads,
  counts,
  view,
  tag,
  board,
}: {
  threads: Thread[];
  counts: { new: number; unread: number };
  view: ThreadView;
  tag: string | null;
  board: Board | null;
}) {
  const me = useMe();
  const { key } = useLocation();
  const slug = board === null ? null : board.slug;
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-1">
        <div className="flex gap-2">
          <Dropdown
            key={`board-${key}`}
            label="按版块筛选"
            align="start"
            triggerClassName={FILTER}
            trigger={
              <>
                {board && <Dot color={board.color} />}
                {board ? board.name : "全部版块"}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </>
            }
          >
            {() => (
              <>
                <Choice to={listUrl(null, tag, view)} chosen={board === null}>
                  全部版块
                </Choice>
                {boards.map((b) => (
                  <Choice key={b.slug} to={listUrl(b.slug, tag, view)} chosen={b.slug === slug}>
                    <Dot color={b.color} />
                    {b.name}
                  </Choice>
                ))}
              </>
            )}
          </Dropdown>
          <Dropdown
            key={`tag-${key}`}
            label="按标签筛选"
            align="start"
            triggerClassName={FILTER}
            trigger={
              <>
                {tag === null ? "全部标签" : `#${tag}`}
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </>
            }
          >
            {() => (
              <>
                <Choice to={listUrl(slug, null, view)} chosen={tag === null}>
                  全部标签
                </Choice>
                {tags.map((t) => (
                  <Choice key={t} to={listUrl(slug, t, view)} chosen={t === tag}>
                    #{t}
                  </Choice>
                ))}
              </>
            )}
          </Dropdown>
        </div>
        <nav
          aria-label="主题列表"
          className="-mx-1 flex overflow-x-auto px-1 [scrollbar-width:none] max-sm:w-full"
        >
          {VIEWS.filter((v) => !v.mine || me).map((v) => {
            const count = v.view === "new" ? counts.new : v.view === "unread" ? counts.unread : 0;
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
                {count > 0 && <span className="ml-1 text-primary tabular-nums">{count}</span>}
              </Link>
            );
          })}
        </nav>
      </div>
      <ThreadList threads={threads} showBoard={board === null} />
      <Link
        to="/new"
        aria-label="发帖"
        className="fixed right-5 bottom-6 z-30 flex size-13 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg sm:hidden"
      >
        <PenSquare className="size-5" />
      </Link>
    </section>
  );
}

function Dot({ color }: { color: string }) {
  return <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

function Choice({ to, chosen, children }: { to: string; chosen: boolean; children: ReactNode }) {
  return (
    <Link to={to} className={cn(menuItem, chosen && "font-medium")}>
      {children}
      {chosen && <Check className="ml-auto" />}
    </Link>
  );
}
