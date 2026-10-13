import { CircleCheck, MessageSquare, Pin, Sparkles } from "lucide-react";
import { Link } from "react-router";
import { cn } from "cn";
import { BoardBadge } from "~/components/board-badge";
import { UserAvatar } from "~/components/user-avatar";
import { boards, type Thread } from "~/draft-data";

// Phones stack the reply count over the time beside the title; wider screens line the numbers up
// under a header.
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 px-3 sm:px-4 md:grid-cols-[minmax(0,1fr)_9.25rem_3rem_3rem_5rem]";

const COUNT = new Intl.NumberFormat("zh-CN", { notation: "compact" });

export function ThreadList({
  threads,
  showBoard = true,
}: {
  threads: Thread[];
  showBoard?: boolean;
}) {
  return (
    <>
      <div
        aria-hidden="true"
        className={cn(COLUMNS, "border-b pb-2 text-xs text-muted-foreground max-md:hidden")}
      >
        <span>话题</span>
        <span />
        <span className="text-center">回复</span>
        <span className="text-center">浏览</span>
        <span className="text-center">活动</span>
      </div>
      <ul>
        {threads.map((t) => (
          <ThreadRow key={t.id} thread={t} showBoard={showBoard} />
        ))}
      </ul>
    </>
  );
}

function ThreadRow({ thread, showBoard }: { thread: Thread; showBoard: boolean }) {
  const board = boards.find((b) => b.slug === thread.board);
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
          className="text-body leading-snug font-medium text-foreground visited:text-foreground/70 after:absolute after:inset-0 lg:text-base"
        >
          {thread.pinned && (
            <Pin
              aria-label="置顶"
              className="mr-1 -mt-0.5 inline size-4 rotate-45 text-brand-strong"
            />
          )}
          {thread.title}
          {thread.solved && (
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
          {showBoard && board && <BoardBadge board={board} />}
          {thread.tags.map((t) => (
            <span key={t}>#{t}</span>
          ))}
        </div>
      </div>
      <div className="relative flex gap-0.5 max-md:hidden">
        {thread.participants.map((p) => (
          <span key={p.id} title={p.name}>
            <UserAvatar user={p} className="size-7" />
          </span>
        ))}
      </div>
      <div className="flex flex-col items-end gap-1 md:items-center">
        <span className="flex items-center gap-1 font-medium tabular-nums">
          <MessageSquare className="size-3.5 md:hidden" />
          {thread.replies}
          <span className="sr-only">条回复</span>
        </span>
        <span className="md:hidden">{thread.lastActive}</span>
      </div>
      <span className="text-center tabular-nums max-md:hidden">
        {COUNT.format(thread.views)}
        <span className="sr-only">次浏览</span>
      </span>
      <span className="text-center max-md:hidden">{thread.lastActive}</span>
    </li>
  );
}
