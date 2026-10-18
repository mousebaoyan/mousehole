import { useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { cn } from "cn";
import type { UserBrief } from "~/api-types";
import { useDismiss } from "~/components/disclosure";
import { UserAvatar } from "~/components/user-avatar";

export type Person = { user: UserBrief; note: string | null };

// A count that opens the list of people behind it, loaded from `source` the first time; the list
// lines up with the count's right edge, or its left one where it starts a row.
export function PeoplePopover({
  source,
  label,
  title,
  align = "right",
}: {
  source: string;
  label: string;
  title: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const list = useFetcher<{ items: Person[] }>();
  useDismiss(open, () => setOpen(false), root);
  return (
    <span ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={title}
        onClick={() => {
          if (!open && list.state === "idle") void list.load(source);
          setOpen(!open);
        }}
        className="underline-offset-2 hover:text-foreground hover:underline"
      >
        {label}
      </button>
      {open && (
        <ul
          className={cn(
            "absolute top-full z-30 mt-2 max-h-72 w-[min(18rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-xl border bg-popover py-1 text-sm text-popover-foreground shadow-lg animate-in fade-in zoom-in-95",
            align === "left" ? "left-0" : "right-0",
          )}
        >
          {!list.data && <li className="px-3 py-2 animate-pulse text-muted-foreground">加载中…</li>}
          {list.data?.items.map(({ user, note }) => (
            <li key={user.id}>
              <Link
                to={`/u/${user.id}`}
                className="flex items-center gap-3 px-3 py-2 hover:bg-accent"
              >
                <UserAvatar user={user} className="size-7" />
                <span className="min-w-0 truncate font-medium">{user.display_name}</span>
                {note && (
                  <span className="ml-auto shrink-0 text-meta text-muted-foreground">{note}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
