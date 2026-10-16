import { Link, redirect } from "react-router";
import { cn } from "cn";
import { apiContext } from "../api.server.ts";
import { Sparkles } from "~/components/icons";
import { buttonVariants } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { pageTitle } from "~/share-meta";
import type { Route } from "./+types/coins.ts";
import {
  ACCEPTED,
  CHECK_IN,
  PER_LIKER,
  PERIODS,
  QUESTION_COST,
} from "../../server/modules/coins/rules.ts";
import {
  BACKGROUND_PRESETS,
  BACKGROUNDS,
  FRAME_LOOKS,
  FRAMES,
} from "../../server/modules/users/customization.ts";

// The coins page (design §8.17): what one has and how it came and went, which only they see, and
// who earned the most.

export function meta() {
  return [{ title: pageTitle("鼠币") }];
}

// ?period= picks the leaderboard, ?cursor= an older page of the ledger.
export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const search = new URL(request.url).searchParams;
  const period = PERIODS.find((p) => p === search.get("period")) ?? "week";
  const [ledger, board] = await Promise.all([
    api.me.coins.$get({ query: { cursor: search.get("cursor") ?? undefined } }),
    api.coins.leaderboard.$get({ query: { period } }),
  ]);
  if (!ledger.ok) return redirect("/login");
  return {
    period,
    ledger: await ledger.json(),
    // Members only: a frozen account has none.
    leaders: board.ok ? (await board.json()).items : null,
    year: new Date(Date.now() + 8 * 3600_000).getUTCFullYear(),
  };
}

const PERIOD_TABS = [
  { period: "week", label: "本周" },
  { period: "month", label: "本月" },
  { period: "all", label: "总榜" },
] as const;

type Loaded = Exclude<Awaited<ReturnType<typeof loader>>, Response>;
type Entry = Loaded["ledger"]["items"][number];

export default function Coins({ loaderData }: Route.ComponentProps) {
  const { period, ledger, leaders, year } = loaderData;
  return (
    <section className="flex flex-col gap-4">
      <header className="px-1">
        <h1 className="text-xl font-semibold">鼠币</h1>
        <p className="mt-1 text-meta text-muted-foreground">
          被别人认可就能攒鼠币，用来兑换装扮的动态版。鼠币只在自己账上，不能转给别人。
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="flex flex-col items-start rounded-2xl border bg-card p-5">
          <p className="text-meta text-muted-foreground">我的鼠币</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{ledger.coins}</p>
          <Link
            to="/settings#customize"
            className={buttonVariants({ variant: "outline", size: "sm", className: "mt-auto" })}
          >
            <Sparkles /> 兑换动态版
          </Link>
        </div>
        <div className="rounded-2xl border bg-card p-5 text-sm">
          <h2 className="font-medium">怎么挣</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            <Rule amount={`+${CHECK_IN}`}>签到：每天打开论坛，或者在群里发过言</Rule>
            <Rule amount={`每人 +${PER_LIKER}`}>获赞：一个人一天只算一次</Rule>
            <Rule amount={`+${ACCEPTED}`}>回复被采纳：每天最多一次</Rule>
          </ul>
          <p className="mt-2 text-meta text-muted-foreground">
            获赞和采纳在第二天凌晨结算，匿名的、删掉的楼层不算；发帖和回复不给鼠币。
          </p>
          <h2 className="mt-4 font-medium">怎么花</h2>
          <ul className="mt-2 flex flex-col gap-1.5">
            <Rule amount="">兑换背景和头像框的动态版，在设置的个性化里</Rule>
            <Rule amount={`−${QUESTION_COST}`}>发问答帖</Rule>
          </ul>
        </div>
      </div>
      <Leaders period={period} leaders={leaders} />
      <Ledger
        items={ledger.items}
        next={ledger.next_cursor && `?period=${period}&cursor=${ledger.next_cursor}`}
        year={year}
      />
    </section>
  );
}

function Rule({ amount, children }: { amount: string; children: string }) {
  return (
    <li className="flex items-baseline gap-3">
      <span className="min-w-0 flex-1">{children}</span>
      <span className="shrink-0 font-semibold text-primary tabular-nums">{amount}</span>
    </li>
  );
}

function Leaders({ period, leaders }: { period: string; leaders: Loaded["leaders"] }) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-semibold">排行榜</h2>
        <nav aria-label="排行榜" className="flex gap-1">
          {PERIOD_TABS.map((t) => (
            <Link
              key={t.period}
              to={`?period=${t.period}`}
              preventScrollReset
              aria-current={t.period === period ? "page" : undefined}
              className={cn(
                "rounded-full px-3 py-1 text-sm text-muted-foreground hover:text-foreground",
                t.period === period && "bg-secondary font-medium text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      <p className="mt-1 text-meta text-muted-foreground">按这段时间挣到的鼠币排，花掉的不扣</p>
      {leaders === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">排行榜只给成员看</p>
      ) : leaders.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">还没有人挣到鼠币</p>
      ) : (
        <ol className="mt-2 -mx-2">
          {leaders.map((l, i) => (
            <li key={l.user.id}>
              <Link
                to={`/u/${l.user.id}`}
                className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-accent/60"
              >
                <span
                  className={cn(
                    "w-6 shrink-0 text-right text-sm tabular-nums",
                    i < 3 ? "font-semibold text-brand-strong" : "text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                <UserAvatar user={l.user} className="size-8" />
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate font-medium">{l.user.display_name}</span>
                  <UserBadges user={l.user} />
                </span>
                <span className="shrink-0 font-semibold tabular-nums">{l.earned}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// The day an entry is for, the year only when not this one.
function dayOf(day: string, year: number) {
  const [y, m, d] = day.split("-").map(Number);
  return `${y === year ? "" : `${y}年`}${m}月${d}日`;
}

function lookName({ kind, key }: { kind: string; key: string }) {
  if (key === "custom") return "上传动图";
  const frame = FRAMES.find((f) => f === key);
  const preset = BACKGROUNDS.find((b) => b === key);
  if (kind === "frame" && frame) return `头像框「${FRAME_LOOKS[frame].name}」的动态版`;
  return preset ? `背景「${BACKGROUND_PRESETS[preset].name}」的动态版` : "动态版";
}

function what(e: Entry) {
  switch (e.reason) {
    case "check_in":
      return "签到";
    case "liked":
      return `获赞，${e.amount} 人`;
    case "accepted":
      return "回复被采纳";
    case "question":
      return e.thread ? (
        <>
          发问答帖{" "}
          <Link to={`/t/${e.thread.id}`} className="text-link hover:underline">
            {e.thread.title}
          </Link>
        </>
      ) : (
        "发问答帖"
      );
    default:
      return e.look ? `兑换${lookName(e.look)}` : "兑换";
  }
}

function Ledger({ items, next, year }: { items: Entry[]; next: string | null; year: number }) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <h2 className="font-semibold">明细</h2>
      <p className="mt-1 text-meta text-muted-foreground">只有你自己看得到</p>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">还没有记录</p>
      ) : (
        <ul className="mt-2 divide-y">
          {items.map((e, i) => (
            <li key={i} className="flex items-baseline gap-3 py-2 text-sm">
              <span className="w-20 shrink-0 text-meta text-muted-foreground tabular-nums">
                {dayOf(e.day, year)}
              </span>
              <span className="min-w-0 flex-1 truncate">{what(e)}</span>
              <span
                className={cn(
                  "shrink-0 font-semibold tabular-nums",
                  e.amount > 0 ? "text-primary" : "text-muted-foreground",
                )}
              >
                {e.amount > 0 ? `+${e.amount}` : `−${-e.amount}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <Link
          to={next}
          className="mt-2 block text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更早的
        </Link>
      )}
    </div>
  );
}
