import { CircleCheck, MessageSquare, Pin, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "cn";
import type { ThreadItem } from "~/api-types";
import { BoardBadge } from "~/components/board-badge";
import { UserAvatar } from "~/components/user-avatar";
import { ago } from "~/time";

// Phones stack the reply count over the time beside the title; wider screens line the numbers up
// under a header.
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-3 sm:px-4 md:grid-cols-[minmax(0,1fr)_9.25rem_3rem_3rem_5rem]";

const COUNT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

// 1.5k rather than 1,520.
function count(n: number) {
  return COUNT.format(n).toLowerCase();
}

// Hotter colors for bigger numbers: one, two, three, then four or more digits.
const HEAT = ["", "text-link", "text-warning", "font-semibold text-destructive"];

function heat(n: number) {
  return HEAT[Math.min(String(n).length, HEAT.length) - 1];
}

// `children` are more rows, for lists that grow as they are scrolled.
export function ThreadList({
  threads,
  now,
  showBoard = true,
  children,
}: {
  threads: ThreadItem[];
  now: number;
  showBoard?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        className={cn(COLUMNS, "border-b pb-2 text-xs text-muted-foreground max-md:hidden")}
      >
        <span>主题</span>
        <span />
        <span className="text-center">回复</span>
        <span className="text-center">浏览</span>
        <span className="text-center">活动</span>
      </div>
      <ul>
        <ThreadRows threads={threads} now={now} showBoard={showBoard} />
        {children}
      </ul>
    </>
  );
}

export function ThreadRows({
  threads,
  now,
  showBoard,
}: {
  threads: ThreadItem[];
  now: number;
  showBoard: boolean;
}) {
  return threads.map((t) => <ThreadRow key={t.id} thread={t} now={now} showBoard={showBoard} />);
}

function ThreadRow({
  thread,
  now,
  showBoard,
}: {
  thread: ThreadItem;
  now: number;
  showBoard: boolean;
}) {
  const active = ago(thread.last_post_at, now);
  return (
    <li
      className={cn(
        COLUMNS,
        "relative items-center rounded-xl py-3.5 text-xs text-muted-foreground before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden hover:bg-accent/60 lg:py-4",
      )}
    >
      <div className="min-w-0">
        <Link
          to={`/t/${thread.id}`}
          className="text-body leading-snug font-medium text-foreground after:absolute after:inset-0 visited:text-foreground/65 lg:text-base"
        >
          {thread.pinned > 0 && (
            <Pin
              aria-label="置顶"
              className="mr-1 -mt-0.5 inline size-4 rotate-45 text-brand-strong"
            />
          )}
          {thread.title}
          {thread.solved_post_id !== null && (
            <CircleCheck
              aria-label="已解决"
              className="ml-1.5 -mt-0.5 inline size-4 text-success"
            />
          )}
          {thread.featured && (
            <Sparkles aria-label="精华" className="ml-1.5 -mt-0.5 inline size-4 text-warning" />
          )}
        </Link>
        <div className="relative mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {showBoard && <BoardBadge board={thread.board} />}
          {thread.tags.map((t) => (
            <span key={t}>#{t}</span>
          ))}
        </div>
      </div>
      <div className="relative flex gap-0.5 max-md:hidden">
        {[thread.author, ...thread.posters].map((p) => (
          <span key={p.id} title={p.display_name}>
            <UserAvatar user={p} className="size-7" />
          </span>
        ))}
      </div>
      <div className="flex flex-col items-end gap-1 md:items-center">
        <span
          className={cn(
            "flex items-center gap-1 font-medium tabular-nums",
            heat(thread.reply_count),
          )}
        >
          <MessageSquare className="size-3.5 md:hidden" />
          {count(thread.reply_count)}
          <span className="sr-only">条回复</span>
        </span>
        <span className="md:hidden">{active}</span>
      </div>
      <span className={cn("text-center tabular-nums max-md:hidden", heat(thread.view_count))}>
        {count(thread.view_count)}
        <span className="sr-only">次浏览</span>
      </span>
      <span className="text-center max-md:hidden">{active}</span>
    </li>
  );
}
