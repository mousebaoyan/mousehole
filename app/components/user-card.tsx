import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link, useFetcher, useNavigate } from "react-router";
import { cn } from "cn";
import { Award, UserCheck, UserPlus } from "~/components/icons";
import { useDismiss } from "~/components/disclosure";
import { Button, buttonVariants } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { BadgeChip } from "~/components/badge-chip";
import { UserBadges } from "~/components/user-badges";
import { useMe } from "~/forum";
import type { Writer } from "~/api-types";
import type { loader } from "~/routes/user-card";
import { useSavedValue } from "~/saved-value";

type Relatable = {
  id: number;
  followed?: boolean;
  endorsed?: boolean;
  stats: { followers: number; following: number; endorsements: number };
};

// Following someone and 认可 (design §8.7), saved through the user page's action; the counts
// follow the reader's own changes at once.
export function useRelations(user: Relatable) {
  const me = useMe();
  const navigate = useNavigate();
  const action = `/u/${user.id}`;
  const was = { followed: user.followed ?? false, endorsed: user.endorsed ?? false };
  const followed = useSavedValue(was.followed, action, "followed", (raw) => raw === "true");
  const endorsed = useSavedValue(was.endorsed, action, "endorsed", (raw) => raw === "true");
  return {
    self: me?.id === user.id,
    followed: followed.value,
    endorsed: endorsed.value,
    followers: user.stats.followers + Number(followed.value) - Number(was.followed),
    following: user.stats.following,
    endorsements: user.stats.endorsements + Number(endorsed.value) - Number(was.endorsed),
    follow: () => {
      if (me) followed.save({ intent: "follow", followed: String(!followed.value) });
      else void navigate("/login");
    },
    endorse: () => {
      if (me) endorsed.save({ intent: "endorse", endorsed: String(!endorsed.value) });
      else void navigate("/login");
    },
  };
}

export type Relations = ReturnType<typeof useRelations>;

// Not on one's own card or page.
export function RelationButtons({
  relations,
  className,
}: {
  relations: Relations;
  className?: string;
}) {
  if (relations.self) return null;
  return (
    <div className={cn("flex gap-2", className)}>
      <Button
        variant={relations.followed ? "outline" : "default"}
        aria-pressed={relations.followed}
        onClick={relations.follow}
        className="flex-1"
      >
        {relations.followed ? <UserCheck /> : <UserPlus />}
        {relations.followed ? "已关注" : "关注"}
      </Button>
      <Button
        variant="outline"
        aria-pressed={relations.endorsed}
        onClick={relations.endorse}
        title="认可 TA 的帮助"
        className="flex-1"
      >
        <Award className={cn(relations.endorsed && "text-brand")} />
        {relations.endorsed ? "已认可" : "认可"}
      </Button>
    </div>
  );
}

// Wraps a person's avatar or name so that it opens their profile card, fetched when it opens; see
// design §9. `align` is the edge of the trigger the card lines up with. Someone anonymous has no
// card to open.
export function UserCard(props: {
  user: Writer | { id: number; display_name: string };
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  const { user, className, children } = props;
  if ("anonymous" in user) return <span className={className}>{children}</span>;
  return <PersonCard {...props} user={user} />;
}

function PersonCard({
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
  useDismiss(open, () => setOpen(false), root);

  return (
    <span ref={root} className="relative min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${user.display_name} 的资料卡`}
        onClick={() => setOpen(!open)}
        className={cn("cursor-pointer", className)}
      >
        {children}
      </button>
      {open && (
        <CardPanel
          id={user.id}
          className={cn("absolute top-full mt-2", align === "start" ? "left-0" : "right-0")}
        />
      )}
    </span>
  );
}

// The card itself, placed by the caller, loaded as it first opens. Keyed by the person, so it
// opens with what was loaded before, wherever they are clicked on the page.
export function CardPanel({
  id,
  className,
  style,
}: {
  id: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { data, load } = useFetcher<typeof loader>({ key: `user-card:${id}` });
  useEffect(() => {
    if (data === undefined) void load(`/u/${id}/card`);
  }, [data, id, load]);
  return (
    <div
      className={cn(
        "z-50 w-72 rounded-2xl border bg-popover p-4 text-left text-sm text-popover-foreground shadow-lg animate-in fade-in zoom-in-95",
        className,
      )}
      style={style}
    >
      {data ? (
        <CardBody profile={data} />
      ) : (
        <p className="py-6 text-center text-meta animate-pulse text-muted-foreground">加载中…</p>
      )}
    </div>
  );
}

// What the card loaded, the API's user.
type Profile = NonNullable<ReturnType<typeof useFetcher<typeof loader>>["data"]>;

function CardBody({ profile }: { profile: Profile }) {
  if (!profile.members_only) return <FullCard profile={profile} />;
  return (
    <>
      <div className="flex items-center gap-3">
        <UserAvatar user={profile} className="size-14 text-xl" />
        <p className="min-w-0 truncate font-semibold">{profile.display_name}</p>
      </div>
      <p className="mt-3 text-meta text-muted-foreground">TA 的资料和发言仅成员可见</p>
    </>
  );
}

function FullCard({ profile }: { profile: Extract<Profile, { members_only: false }> }) {
  const relations = useRelations(profile);
  const numbers = [
    { label: "帖子", value: profile.stats.threads },
    { label: "回复", value: profile.stats.posts },
    { label: "获赞", value: profile.stats.likes },
    { label: "认可", value: relations.endorsements },
  ];
  return (
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
      {profile.badges.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {profile.badges.map((b) => (
            <BadgeChip key={b.id} badge={b} />
          ))}
        </div>
      )}
      <dl className="mt-3 flex gap-4 text-meta">
        {numbers.map((n) => (
          <div key={n.label} className="flex items-baseline gap-1">
            <dd className="font-semibold tabular-nums">{n.value}</dd>
            <dt className="text-muted-foreground">{n.label}</dt>
          </div>
        ))}
      </dl>
      <RelationButtons relations={relations} className="mt-4" />
      <Link
        to={`/u/${profile.id}`}
        className={buttonVariants({ variant: "ghost", className: "mt-2 w-full" })}
      >
        查看主页
      </Link>
    </>
  );
}
