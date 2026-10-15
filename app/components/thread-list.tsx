import { ChartBar, CircleCheck, Gift, MessageSquare, Pin, Sparkles } from "lucide-react";
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

// Threads published this recently and never opened are new; see design §8.9.
const NEW_SECONDS = 7 * 86_400;

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
        <span>帖子</span>
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
  // Members' reading is tracked; guests have the browser's history of visited links.
  const lastRead = thread.last_read_floor;
  // The first floor not read yet, past the highest one read.
  const next =
    lastRead !== undefined && lastRead > 0 && lastRead < thread.floor_count ? lastRead + 1 : null;
  const unread = next === null ? 0 : thread.floor_count - next + 1;
  const fresh = lastRead === 0 && now - thread.created_at < NEW_SECONDS;
  return (
    <li
      className={cn(
        COLUMNS,
        "relative items-center rounded-xl py-3.5 text-xs text-muted-foreground before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden transition-colors hover:bg-accent/60 lg:py-4",
      )}
    >
      <div className="min-w-0">
        <Link
          to={next === null ? `/t/${thread.id}` : `/t/${thread.id}?floor=${next}`}
          className={cn(
            "text-body leading-snug font-medium text-foreground after:absolute after:inset-0 lg:text-base",
            lastRead === undefined
              ? "visited:text-foreground/65"
              : lastRead >= thread.floor_count && "text-foreground/65",
          )}
        >
          {thread.pinned > 0 && (
            <Pin
              aria-label="置顶"
              className="mr-1 -mt-0.5 inline size-4 rotate-45 text-brand-strong"
            />
          )}
          {thread.title}
          {thread.kind === "poll" && (
            <ChartBar
              aria-label="投票"
              className="ml-1.5 -mt-0.5 inline size-4 text-muted-foreground"
            />
          )}
          {thread.kind === "lottery" && (
            <Gift
              aria-label="抽奖"
              className="ml-1.5 -mt-0.5 inline size-4 text-muted-foreground"
            />
          )}
          {thread.solved_post_id !== null && (
            <CircleCheck
              aria-label="已解决"
              className="ml-1.5 -mt-0.5 inline size-4 text-success"
            />
          )}
          {thread.featured && (
            <Sparkles aria-label="精华" className="ml-1.5 -mt-0.5 inline size-4 text-warning" />
          )}
          {fresh && (
            <span className="ml-2 inline-block size-2 rounded-full bg-primary align-middle">
              <span className="sr-only">新帖子</span>
            </span>
          )}
          {unread > 0 && (
            <span className="ml-2 inline-block rounded-full bg-primary px-1.5 align-middle text-2xs font-semibold text-primary-foreground tabular-nums">
              {unread}
              <span className="sr-only">层没读过</span>
            </span>
          )}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {showBoard && <BoardBadge board={thread.board} />}
          {thread.tags.map((t) => (
            <span key={t}>#{t}</span>
          ))}
        </div>
      </div>
      {/* The avatars sit above the title's link, which covers the row; this wrapper doesn't, so
          the space beside them opens the thread as well. */}
      <div className="flex gap-0.5 max-md:hidden">
        {"anonymous" in thread.author && (
          <span title={thread.author.display_name} className="relative rounded-full">
            <UserAvatar user={thread.author} thread={thread.id} className="size-7" />
          </span>
        )}
        {[thread.author, ...thread.posters].map(
          (p) =>
            !("anonymous" in p) && (
              <Link
                key={p.id}
                to={`/u/${p.id}`}
                title={p.display_name}
                className="relative rounded-full"
              >
                <UserAvatar user={p} className="size-7" />
              </Link>
            ),
        )}
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
