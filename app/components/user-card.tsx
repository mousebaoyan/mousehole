import { useRef, useState, type ReactNode } from "react";
import { Link, useFetcher } from "react-router";
import { cn } from "cn";
import { useDismiss } from "~/components/disclosure";
import { buttonVariants } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import type { loader } from "~/routes/user-card";

// Wraps a person's avatar or name so that it opens their profile card, fetched when it opens; see
// design §9. `align` is the edge of the trigger the card lines up with.
export function UserCard({
  user,
  align = "start",
  className,
  children,
}: {
  user: { id: number; display_name: string };
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const card = useFetcher<typeof loader>();
  useDismiss(open, () => setOpen(false), root);
  const profile = card.data;

  return (
    <span ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${user.display_name} 的资料卡`}
        onClick={() => {
          if (profile === undefined && card.state === "idle") void card.load(`/u/${user.id}/card`);
          setOpen(!open);
        }}
        className={cn("cursor-pointer", className)}
      >
        {children}
      </button>
      {open && (
        <div
          className={cn(
            "absolute top-full z-40 mt-2 w-72 rounded-2xl border bg-popover p-4 text-left text-sm text-popover-foreground shadow-lg animate-in fade-in zoom-in-95",
            align === "start" ? "left-0" : "right-0",
          )}
        >
          {profile ? (
            <>
              <div className="flex items-center gap-3">
                <UserAvatar user={profile} className="size-14 text-xl" />
                <div className="min-w-0">
                  <p className="truncate font-semibold">{profile.display_name}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <UserBadges user={profile} />
                  </div>
                </div>
              </div>
              {profile.bio && <p className="mt-3 line-clamp-3 text-meta">{profile.bio}</p>}
              <dl className="mt-3 flex gap-4 text-meta">
                {[
                  { label: "主题", value: profile.stats.threads },
                  { label: "回复", value: profile.stats.posts },
                  { label: "获赞", value: profile.stats.likes },
                ].map((n) => (
                  <div key={n.label} className="flex items-baseline gap-1">
                    <dd className="font-semibold tabular-nums">{n.value}</dd>
                    <dt className="text-muted-foreground">{n.label}</dt>
                  </div>
                ))}
              </dl>
              <Link
                to={`/u/${profile.id}`}
                className={buttonVariants({ variant: "outline", className: "mt-4 w-full" })}
              >
                查看主页
              </Link>
            </>
          ) : (
            <p className="py-6 text-center text-meta text-muted-foreground">
              {profile === null ? "这个账号已注销" : "加载中…"}
            </p>
          )}
        </div>
      )}
    </span>
  );
}
