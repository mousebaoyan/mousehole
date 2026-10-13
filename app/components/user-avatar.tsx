import { cn } from "cn";

const tints = [
  "bg-orange-100 text-orange-800 dark:bg-orange-400/20 dark:text-orange-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-400/20 dark:text-amber-200",
  "bg-teal-100 text-teal-800 dark:bg-teal-400/20 dark:text-teal-200",
  "bg-rose-100 text-rose-800 dark:bg-rose-400/20 dark:text-rose-200",
  "bg-stone-200 text-stone-700 dark:bg-stone-400/25 dark:text-stone-200",
];

// The copy of the QQ avatar. Until there is one, the first letter on a tint picked by user id;
// letters rather than characters, as group cards often start with a year: "26-南京大学-CV".
export function UserAvatar({
  user,
  className,
}: {
  user: { id: number; display_name: string; avatar_url: string | null };
  className?: string;
}) {
  if (user.avatar_url !== null) {
    return (
      <img
        src={user.avatar_url}
        alt=""
        loading="lazy"
        decoding="async"
        className={cn("size-9 shrink-0 rounded-full bg-muted object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-full text-[0.8em] font-medium select-none",
        tints[user.id % tints.length],
        className,
      )}
    >
      {/\p{L}/u.exec(user.display_name)?.[0] ?? user.display_name.slice(0, 1)}
    </span>
  );
}
