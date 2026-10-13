import { cn } from "cn";
import type { UserBrief } from "~/api-types";

// QQ group levels run to 100; every 20 levels a warmer tint.
const levelTints = [
  "bg-stone-100 text-stone-600 dark:bg-stone-500/20 dark:text-stone-300",
  "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  "bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300",
  "bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300",
  "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
];

// Group level and custom title, the same as what members see in the QQ group.
export function UserBadges({ user, op }: { user: UserBrief; op?: boolean }) {
  return (
    <>
      {user.level !== null && (
        <span
          className={cn(
            "rounded px-1.5 py-px text-2xs font-medium",
            levelTints[Math.min(Math.max(Math.floor((user.level - 1) / 20), 0), 4)],
          )}
        >
          LV{user.level}
        </span>
      )}
      {user.title && (
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
