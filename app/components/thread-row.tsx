import {
  CircleCheck,
  CircleHelp,
  MessageSquare,
  MessagesSquare,
  Pin,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router";
import { BoardBadge } from "~/components/board-badge";
import { UserAvatar } from "~/components/user-avatar";
import { boards, type Thread } from "~/draft-data";

export function ThreadRow({ thread, showBoard = true }: { thread: Thread; showBoard?: boolean }) {
  const board = boards.find((b) => b.slug === thread.board);
  return (
    <li className="relative flex gap-3.5 rounded-xl px-3 py-3.5 before:absolute before:right-3 before:bottom-0 before:left-[3.9rem] before:h-px before:bg-border/60 last:before:hidden hover:bg-accent/60 sm:px-4 sm:before:left-[4.4rem]">
      <UserAvatar user={thread.author} className="mt-0.5 size-10 max-sm:size-9" />
      <div className="min-w-0 flex-1">
        <Link
          to={`/t/${thread.id}`}
          className="text-[15px] leading-snug font-medium text-foreground visited:text-foreground/70 after:absolute after:inset-0"
        >
          {thread.pinned && <Pin className="mr-1 -mt-0.5 inline size-4 rotate-45 text-primary" />}
          {thread.title}
        </Link>
        <div className="relative mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px] text-muted-foreground">
          {showBoard && board && <BoardBadge board={board} />}
          {thread.kind === "question" &&
            (thread.solved ? (
              <span className="inline-flex items-center gap-1 text-success">
                <CircleCheck className="size-3.5" /> 已解决
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-warning">
                <CircleHelp className="size-3.5" /> 待解答
              </span>
            ))}
          {thread.featured && (
            <span className="inline-flex items-center gap-1 text-warning">
              <Sparkles className="size-3.5" /> 精华
            </span>
          )}
          {thread.fromQQ && (
            <span className="inline-flex items-center gap-1" title="从群聊转到论坛">
              <MessagesSquare className="size-3.5" /> 群聊
            </span>
          )}
          {thread.tags.map((t) => (
            <span key={t}>#{t}</span>
          ))}
          <span className="max-sm:basis-full">
            {thread.lastPoster.name} · {thread.lastActive}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-start gap-5 pt-0.5">
        <div className="hidden -space-x-2 md:flex">
          {thread.participants.slice(0, 4).map((p) => (
            <UserAvatar key={p.id} user={p} className="size-7 ring-2 ring-background" />
          ))}
        </div>
        <span className="flex min-w-10 items-center justify-end gap-1 text-[13px] text-muted-foreground tabular-nums">
          <MessageSquare className="size-3.5" />
          {thread.replies}
        </span>
      </div>
    </li>
  );
}
