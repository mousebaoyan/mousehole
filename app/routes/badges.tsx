import { Award, Check } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { Link } from "react-router";
import { cn } from "cn";
import { apiContext } from "../api.server.ts";
import { TIER_STYLES } from "~/components/badge-chip";
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
  { key: "likes", label: "获赞" },
  { key: "answers", label: "回答" },
  { key: "persistence", label: "坚持" },
  { key: "limited", label: "绝版" },
];

export default function Badges({ loaderData: { badges } }: Route.ComponentProps) {
  return (
    <section className="flex flex-col gap-6">
      <header className="px-1">
        <h1 className="text-xl font-semibold">徽章</h1>
        <p className="mt-1 text-meta text-muted-foreground">
          参与讨论、帮助别人就能获得徽章，群里被收录的发言也算。金徽章和银徽章可以在设置里设为头衔。
        </p>
      </header>
      {GROUPS.map((group) => {
        const shown = badges.filter((b) => b.grouping === group.key);
        if (shown.length === 0) return null;
        return (
          <div key={group.key}>
            <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">{group.label}</h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {shown.map((b) => (
                <li key={b.id}>
                  <Link
                    to={`/badges/${b.id}`}
                    className={cn(
                      "flex h-full items-start gap-3 rounded-2xl border bg-card px-4 py-3 transition-colors hover:bg-accent/60",
                      b.granted > 0 && "border-primary/40",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
                        TIER_STYLES[b.tier],
                      )}
                    >
                      <Award className="size-5" aria-label={`${TIER_NAMES[b.tier]}徽章`} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 font-medium">
                        {b.name}
                        {b.granted > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-xs font-normal text-primary">
                            <Check className="size-3.5" />
                            {b.granted > 1 ? `已获得 ${b.granted} 次` : "已获得"}
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-meta text-muted-foreground">
                        {b.description}
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
                        {b.granted_count} 人获得
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
