import { cn } from "cn";
import type { User } from "~/draft-data";

const levelTints = [
  "bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300",
  "bg-slate-100 text-slate-600 dark:bg-slate-500/20 dark:text-slate-300",
  "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
];

// Group level and custom title, the same as what members see in the QQ group.
export function UserBadges({ user, op }: { user: User; op?: boolean }) {
  return (
    <>
      <span
        className={cn("rounded px-1.5 py-px text-[11px] font-medium", levelTints[user.level - 1])}
      >
        LV{user.level} {user.levelName}
      </span>
      {user.title && (
        <span className="rounded border px-1.5 py-px text-[11px] text-muted-foreground">
          {user.title}
        </span>
      )}
      {op && (
        <span className="rounded bg-primary px-1.5 py-px text-[11px] font-medium text-primary-foreground">
          楼主
        </span>
      )}
    </>
  );
}
