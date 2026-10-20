import { Link, redirect } from "react-router";
import { cn } from "~/cn";
import { apiContext } from "../api.server.ts";
import type { ReactNode } from "react";
import {
  CalendarCheck,
  ChevronRight,
  CircleCheck,
  CircleQuestionMark,
  Coins as CoinsIcon,
  HandCoins,
  Heart,
  Sparkles,
  type LucideIcon,
} from "~/components/icons";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { pageTitle } from "~/share-meta";
import type { Route } from "./+types/coins.ts";
import {
  ACCEPTED,
  BOUNTY_ANSWER,
  BOUNTY_REPLY,
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
          发言获得认可即可积累鼠币，用于兑换装扮的动态版和发布问答帖。鼠币不可转赠。
        </p>
      </header>
      <div className="rounded-2xl border bg-card p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <CoinsIcon className="size-5.5" />
          </span>
          <div>
            <p className="text-meta text-muted-foreground">我的鼠币</p>
            <p className="text-2xl leading-tight font-semibold tabular-nums">{ledger.coins}</p>
          </div>
        </div>
        <div className="mt-4 grid gap-x-8 gap-y-4 border-t pt-4 sm:grid-cols-2">
          <div>
            <h2 className="text-meta text-muted-foreground">获得</h2>
            <ul className="mt-1">
              <Rule icon={CalendarCheck} title="每日签到" hint="访问论坛或在群里发言">
                +{CHECK_IN}
              </Rule>
              <Rule icon={Heart} title="楼层获赞" hint="每位成员每天计一次">
                +{PER_LIKER}/人
              </Rule>
              <Rule icon={CircleCheck} title="回复被采纳" hint="每天最多计一次">
                +{ACCEPTED}
              </Rule>
              <Rule
                icon={HandCoins}
                title="回答悬赏的问题"
                hint={`被采纳再得 ${BOUNTY_ANSWER}，每天最多计一次`}
              >
                +{BOUNTY_REPLY}
              </Rule>
            </ul>
            <p className="mt-1 text-meta text-muted-foreground">
              获赞、采纳和悬赏次日到账，匿名楼层和已删除的楼层不计入。
            </p>
          </div>
          <div>
            <h2 className="text-meta text-muted-foreground">使用</h2>
            <ul className="mt-1">
              <Rule icon={CircleQuestionMark} title="发布问答帖" hint="提问并采纳最佳回答">
                −{QUESTION_COST}
              </Rule>
              <li>
                <Link
                  to="/settings#customize"
                  className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-accent/60"
                >
                  <RuleIcon icon={Sparkles} />
                  <RuleText title="兑换动态版" hint="前往个性化设置兑换背景和头像框" />
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            </ul>
          </div>
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

function RuleIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
      <Icon className="size-4" />
    </span>
  );
}

function RuleText({ title, hint }: { title: string; hint: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-meta text-muted-foreground">{hint}</span>
    </span>
  );
}

function Rule({
  icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 py-2">
      <RuleIcon icon={icon} />
      <RuleText title={title} hint={hint} />
      <span className="shrink-0 font-semibold text-primary tabular-nums">{children}</span>
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
      <p className="mt-1 text-meta text-muted-foreground">按期间内获得的鼠币排名</p>
      {leaders === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">排行榜仅对成员开放</p>
      ) : leaders.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">暂无成员获得鼠币</p>
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
  if (kind === "avatar") return "动态头像";
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
      return `获赞（${e.amount} 人）`;
    case "accepted":
      return "回复被采纳";
    case "bounty":
      return e.thread ? (
        <>
          回答悬赏{" "}
          <Link to={`/t/${e.thread.id}`} className="text-link hover:underline">
            {e.thread.title}
          </Link>
        </>
      ) : (
        "回答悬赏"
      );
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
      <p className="mt-1 text-meta text-muted-foreground">仅自己可见</p>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">暂无记录</p>
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
          更早的记录
        </Link>
      )}
    </div>
  );
}
