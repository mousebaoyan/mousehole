import type { ReactNode } from "react";
import { ArrowRight } from "~/components/icons";
import { BoardBadge } from "~/components/board-badge";
import { UserAvatar } from "~/components/user-avatar";
import type { ThreadDetail } from "~/api-types";

type Suggestion = NonNullable<ThreadDetail["suggestions"]>[number];
type Board = ThreadDetail["board"];

// Who suggested what, beside how the thread is now (design §6.6): the old title struck through
// above the new one, the board it would move to, and the tags it would gain or lose.
export function SuggestionChanges({
  suggestion: s,
  current,
  when,
}: {
  suggestion: Suggestion;
  current: { title: string; board: Board; tags: string[] };
  when: ReactNode;
}) {
  const tags = s.tags;
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-meta text-muted-foreground">
        <UserAvatar user={s.user} className="size-5 shrink-0 text-2xs" />
        <span className="min-w-0 truncate font-medium text-foreground">{s.user.display_name}</span>
        <span className="shrink-0">建议修改</span>
        <span className="ml-auto shrink-0 pl-2">{when}</span>
      </p>
      <dl className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-sm">
        {s.title !== null && (
          <>
            <dt className="text-meta text-muted-foreground">标题</dt>
            <dd className="text-pretty">
              <del className="text-muted-foreground decoration-muted-foreground/60">
                {current.title}
              </del>
              <ins className="mt-0.5 block font-medium no-underline">{s.title}</ins>
            </dd>
          </>
        )}
        {s.board && (
          <>
            <dt className="text-meta text-muted-foreground">版块</dt>
            <dd className="flex flex-wrap items-center gap-1.5">
              <BoardBadge board={current.board} />
              <ArrowRight aria-label="改为" className="size-3.5 text-muted-foreground" />
              <BoardBadge board={s.board} />
            </dd>
          </>
        )}
        {tags && (
          <>
            <dt className="text-meta text-muted-foreground">标签</dt>
            <dd className="flex flex-wrap gap-x-2 gap-y-1">
              {[...new Set([...current.tags, ...tags])].map((tag) =>
                !tags.includes(tag) ? (
                  <del key={tag} className="text-muted-foreground decoration-muted-foreground/60">
                    #{tag}
                  </del>
                ) : current.tags.includes(tag) ? (
                  <span key={tag}>#{tag}</span>
                ) : (
                  <ins key={tag} className="font-medium text-brand-strong no-underline">
                    #{tag}
                  </ins>
                ),
              )}
            </dd>
          </>
        )}
      </dl>
      {s.reason && <p className="mt-2 text-sm text-muted-foreground">理由：{s.reason}</p>}
    </div>
  );
}
