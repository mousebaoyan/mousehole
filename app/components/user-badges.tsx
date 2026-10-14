import type { Writer } from "~/api-types";

// The custom title, the same as what members see in the QQ group; someone anonymous has none.
// `mine` marks the reader's own anonymous floors, which only they see as theirs.
export function UserBadges({ user, op, mine }: { user: Writer; op?: boolean; mine?: boolean }) {
  return (
    <>
      {"anonymous" in user
        ? mine && (
            <span className="rounded bg-secondary px-1.5 py-px text-2xs text-muted-foreground">
              我
            </span>
          )
        : user.title && (
            <span className="rounded border px-1.5 py-px text-2xs text-muted-foreground">
              {user.title}
            </span>
          )}
      {op && (
        <span className="rounded bg-primary px-1.5 py-px text-2xs font-medium text-primary-foreground">
          楼主
        </span>
      )}
    </>
  );
}
