import { cn } from "cn";
import type { Writer } from "~/api-types";
import { levelName } from "../../server/platform/site.ts";

// The higher the level, the more it stands out (design §6.6).
const LEVEL_STYLES = [
  "border text-muted-foreground",
  "border text-muted-foreground",
  "bg-secondary text-secondary-foreground",
  "bg-success/12 text-success",
  "bg-brand/18 text-brand-strong",
  "bg-warning/18 text-warning font-semibold",
];

export function LevelBadge({ level }: { level: number }) {
  return (
    <span className={cn("rounded px-1.5 py-px text-2xs whitespace-nowrap", LEVEL_STYLES[level])}>
      {levelName(level)}
    </span>
  );
}

// The level and the custom title, the same as what members see in the QQ group; someone
// anonymous has neither. `mine` marks the reader's own anonymous floors, which only they see as
// theirs.
export function UserBadges({ user, op, mine }: { user: Writer; op?: boolean; mine?: boolean }) {
  return (
    <>
      {"anonymous" in user ? (
        mine && (
          <span className="rounded bg-secondary px-1.5 py-px text-2xs text-muted-foreground">
            我
          </span>
        )
      ) : (
        <>
          <LevelBadge level={user.level} />
          {user.title && (
            <span className="rounded border px-1.5 py-px text-2xs text-muted-foreground">
              {user.title}
            </span>
          )}
        </>
      )}
      {op && (
        <span className="rounded bg-primary px-1.5 py-px text-2xs font-medium text-primary-foreground">
          楼主
        </span>
      )}
    </>
  );
}
