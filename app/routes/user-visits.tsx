import { Link } from "react-router";
import type { InferResponseType } from "hono/client";
import type { Api } from "~/api-types";
import { Pages, type Loaded } from "~/components/pages";
import { UserAvatar } from "~/components/user-avatar";

type Visits = InferResponseType<Api["users"][":user"]["visits"]["$get"], 200>;
// A page of the visits tab, as the profile's loader gives it.
type VisitsPage = { visits: Visits | null; next_cursor: string | null; now: number };

const kept = new Map<string, Loaded<VisitsPage>[]>();

// "2026-10-19" as "10月19日", with the year when it isn't this one.
function dayLabel(day: string, now: number) {
  const [year, month, date] = day.split("-");
  const thisYear = new Date((now + 8 * 3600) * 1000).getUTCFullYear();
  return `${Number(year) === thisYear ? "" : `${year}年`}${Number(month)}月${Number(date)}日`;
}

// Where and on what someone opened the forum each day, and who else came from those addresses
// (design §10.1): for the owner to tell whether an account is used by someone else.
export function VisitRecords({ first }: { first: VisitsPage & { visits: Visits } }) {
  const { items, others } = first.visits;
  return (
    <div className="flex flex-col gap-6">
      <p className="px-1 text-meta text-muted-foreground">
        仅站长可见。每天按 IP 和浏览器分别记录，保留 400 天
      </p>
      <div>
        <h2 className="px-1 text-sm font-medium">这些 IP 上的其他账号</h2>
        {others.length === 0 ? (
          <p className="px-1 py-4 text-meta text-muted-foreground">暂无</p>
        ) : (
          <ul className="mt-1">
            {others.map((o) => (
              <li key={o.user.id}>
                <Link
                  to={`/u/${o.user.id}?tab=visits`}
                  className="flex items-center gap-3 rounded-xl px-1 py-1.5 hover:bg-accent/60"
                >
                  <UserAvatar user={o.user} className="size-7" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{o.user.display_name}</span>
                    <span className="block text-xs break-all text-muted-foreground">
                      {o.ips.join("、")}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h2 className="px-1 text-sm font-medium">每天的访问</h2>
        {items.length === 0 ? (
          <p className="px-1 py-4 text-meta text-muted-foreground">暂无记录</p>
        ) : (
          <ul className="mt-1 divide-y">
            <Pages<VisitsPage> kept={kept} first={first} next={(page) => page.next_cursor}>
              {(page) =>
                page.visits?.items.map((v) => (
                  <li key={`${v.day} ${v.ip} ${v.user_agent}`} className="flex gap-3 px-1 py-2">
                    <span className="w-18 shrink-0 text-sm tabular-nums">
                      {dayLabel(v.day, page.now)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm break-all tabular-nums">{v.ip}</span>
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        title={v.user_agent}
                      >
                        {v.device}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      浏览 {v.views}
                    </span>
                  </li>
                ))
              }
            </Pages>
          </ul>
        )}
      </div>
    </div>
  );
}
