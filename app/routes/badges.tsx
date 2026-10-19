import { Award, Check, Lock } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { Link } from "react-router";
import { cn } from "cn";
import { apiContext } from "../api.server.ts";
import { holdersText, TIER_STYLES } from "~/components/badge-chip";
import { ProgressBar } from "~/components/progress-bar";
import { useMe } from "~/forum";
import { TIER_NAMES } from "../../server/platform/site.ts";
import type { Route } from "./+types/badges.ts";

export function meta() {
  return [{ title: pageTitle("徽章") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).badges.$get();
  return { badges: (await res.json()).items };
}

// The groups the badges page shows them in (design §8.8).
const GROUPS = [
  { key: "start", label: "入门" },
  { key: "likes", label: "人气" },
  { key: "answers", label: "回答" },
  { key: "activity", label: "勤快" },
  { key: "persistence", label: "坚持" },
  { key: "social", label: "交际" },
  { key: "community", label: "共建" },
  { key: "coins", label: "鼠币" },
  { key: "fun", label: "趣味" },
  { key: "limited", label: "绝版" },
];

type Badge = Route.ComponentProps["loaderData"]["badges"][number];

export default function Badges({ loaderData: { badges } }: Route.ComponentProps) {
  const me = useMe();
  const groups = GROUPS.map((group) => ({
    ...group,
    badges: badges.filter((b) => b.grouping === group.key),
  })).filter((group) => group.badges.length > 0);
  const earned = badges.filter((b) => b.granted > 0).length;
  return (
    <section className="flex flex-col gap-5">
      <header className="px-1">
        <h1 className="text-xl font-semibold">徽章</h1>
        <p className="mt-1 text-meta text-muted-foreground">
          参与讨论、帮助他人即可获得徽章，群里被收录的发言也计入。金徽章和银徽章可以在设置里设为头衔，隐藏徽章获得后才揭晓条件。
        </p>
        {me && (
          <div className="mt-3 flex items-center gap-3">
            <ProgressBar have={earned} need={badges.length} className="flex-1" />
            <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
              已获得 {earned} / {badges.length}
            </span>
          </div>
        )}
      </header>
      <nav
        aria-label="徽章分组"
        className="sticky top-14 z-10 -mx-2 flex gap-2 overflow-x-auto overscroll-x-contain bg-background/90 px-2 py-2 backdrop-blur [scrollbar-width:none] sm:mx-0 sm:px-0"
      >
        {groups.map((group) => (
          <a
            key={group.key}
            href={`#group-${group.key}`}
            className="shrink-0 rounded-full border px-3 py-1 text-meta text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            {group.label}
          </a>
        ))}
      </nav>
      {groups.map((group) => (
        <div key={group.key} id={`group-${group.key}`} className="scroll-mt-28">
          <h2 className="mb-2 flex items-baseline justify-between gap-2 px-1 text-sm font-medium text-muted-foreground">
            {group.label}
            {me && (
              <span className="text-xs font-normal tabular-nums">
                {group.badges.filter((b) => b.granted > 0).length} / {group.badges.length}
              </span>
            )}
          </h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {group.badges.map((b) => (
              <li key={b.id}>
                <BadgeCard badge={b} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function BadgeCard({ badge: b }: { badge: Badge }) {
  // A hidden badge shows only its name until it is theirs.
  const secret = b.hidden && b.granted === 0;
  return (
    <Link
      to={`/badges/${b.id}`}
      className={cn(
        "flex h-full items-start gap-3 rounded-2xl border bg-card px-4 py-3 transition-colors hover:bg-accent/60",
        b.granted > 0 && "border-primary/40",
        secret && "border-dashed",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
          secret ? "bg-secondary text-muted-foreground" : TIER_STYLES[b.tier],
        )}
      >
        {secret ? (
          <Lock className="size-4.5" aria-label="隐藏徽章" />
        ) : (
          <Award className="size-5" aria-label={`${TIER_NAMES[b.tier]}徽章`} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium">
          {b.name}
          {b.hidden && !secret && (
            <span className="rounded border px-1 text-2xs font-normal text-muted-foreground">
              隐藏
            </span>
          )}
          {b.granted > 0 && (
            <span className="inline-flex items-center gap-0.5 text-xs font-normal text-primary">
              <Check className="size-3.5" />
              {b.granted > 1 ? `已获得 ${b.granted} 次` : "已获得"}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-meta text-muted-foreground">{b.description}</p>
        {/* A bar at nothing says no more than the description does. */}
        {b.progress && b.progress.have > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <ProgressBar have={b.progress.have} need={b.progress.need} className="flex-1" />
            <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {Math.min(b.progress.have, b.progress.need)} / {b.progress.need}
            </span>
          </div>
        )}
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">
          {holdersText(b.granted_count, b.granted_rate)}
        </p>
      </div>
    </Link>
  );
}
