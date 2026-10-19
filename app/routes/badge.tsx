import { type Loaded, Pages } from "~/components/pages";
import { Award, Lock } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { data, Link } from "react-router";
import { cn } from "cn";
import { apiContext } from "../api.server.ts";
import { holdersText, TIER_STYLES } from "~/components/badge-chip";
import { ProgressBar } from "~/components/progress-bar";
import { TIER_NAMES } from "../../server/platform/site.ts";
import { UserAvatar } from "~/components/user-avatar";
import { ago, unixNow } from "~/time";
import type { Route } from "./+types/badge.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: pageTitle(loaderData.badge.name, "徽章") }];
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  const res = await context
    .get(apiContext)
    .badges[":id"].$get({ param: { id: params.id }, query: { cursor } });
  if (!res.ok) throw data("徽章不存在", { status: 404 });
  return { ...(await res.json()), now: unixNow() };
}

type Holder = Route.ComponentProps["loaderData"]["items"][number];

// The pages of holders each entry of the history showed (components/pages.tsx).
const kept = new Map<string, Loaded<typeof loader>[]>();

export default function Badge({ loaderData }: Route.ComponentProps) {
  const { badge, items } = loaderData;
  const secret = badge.hidden && badge.granted === 0;
  return (
    <section className="flex flex-col gap-5">
      <Link to="/badges" className="px-1 text-meta text-muted-foreground hover:text-foreground">
        全部徽章
      </Link>
      <header
        className={cn(
          "flex items-center gap-4 rounded-2xl border bg-card px-4 py-4",
          secret && "border-dashed",
        )}
      >
        <span
          className={cn(
            "flex size-14 shrink-0 items-center justify-center rounded-full",
            secret ? "bg-secondary text-muted-foreground" : TIER_STYLES[badge.tier],
          )}
        >
          {secret ? (
            <Lock className="size-7" aria-hidden />
          ) : (
            <Award className="size-8" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{badge.name}</h1>
          <p className="mt-0.5 text-body text-muted-foreground">{badge.description}</p>
          {badge.progress && (
            <div className="mt-2 flex items-center gap-2">
              <ProgressBar
                have={badge.progress.have}
                need={badge.progress.need}
                className="flex-1"
              />
              <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                {Math.min(badge.progress.have, badge.progress.need)} / {badge.progress.need}
              </span>
            </div>
          )}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {TIER_NAMES[badge.tier]}徽章 · {holdersText(badge.granted_count, badge.granted_rate)}
            {badge.hidden && " · 隐藏徽章"}
            {badge.multiple && " · 可多次获得"}
            {badge.granted > 0 && <span className="text-primary"> · 你已获得</span>}
          </p>
        </div>
      </header>
      {items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">暂无人获得</p>
      ) : (
        <ul className="stagger">
          <Pages<typeof loader> kept={kept} first={loaderData} next={(page) => page.next}>
            {(page) => <Holders items={page.items} now={page.now} />}
          </Pages>
        </ul>
      )}
    </section>
  );
}

function Holders({ items, now }: { items: Holder[]; now: number }) {
  return items.map((h) => (
    <li key={h.user.id}>
      <Link
        to={`/u/${h.user.id}`}
        className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-accent/60 sm:px-4"
      >
        <UserAvatar user={h.user} className="size-9" />
        <span className="min-w-0 flex-1 truncate font-medium">{h.user.display_name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{ago(h.granted_at, now)}</span>
      </Link>
    </li>
  ));
}
