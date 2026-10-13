import { cn } from "cn";

const tints = [
  "bg-orange-100 text-orange-800 dark:bg-orange-400/20 dark:text-orange-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-400/20 dark:text-amber-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-400/20 dark:text-teal-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-400/20 dark:text-rose-200",
  "bg-stone-200 text-stone-700 dark:bg-stone-400/25 dark:text-stone-200",
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
