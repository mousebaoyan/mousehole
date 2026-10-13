import { cn } from "cn";

const tints = [
  "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
  "bg-slate-200 text-slate-700 dark:bg-slate-500/25 dark:text-slate-300",
];

// Until avatars are cached from QQ, show the first character on a tint picked by user id.
export function UserAvatar({
  user,
  className,
}: {
  user: { id: number; name: string };
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full text-[0.8em] font-medium select-none",
        tints[user.id % tints.length],
        className,
      )}
    >
      {user.name.slice(0, 1)}
    </span>
  );
}
