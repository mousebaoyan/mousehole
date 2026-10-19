import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "cn";
import { apiContext } from "../../api.server.ts";
import { ArrowDown, ArrowUp } from "~/components/icons";
import { Section } from "~/components/form-parts";
import { pageTitle } from "~/share-meta";
import { NOTIFICATION_LABELS } from "../../../server/modules/notifications/types.ts";
import { BOT_NAME } from "../../../server/platform/site.ts";
import type { Route } from "./+types/stats.ts";
import { LineChart, monthDay } from "./stats-chart.tsx";

export function meta() {
  return [{ title: pageTitle("数据", "管理后台") }];
}

const RANGES = [
  { range: "7", label: "7 天" },
  { range: "30", label: "30 天" },
  { range: "90", label: "90 天" },
  { range: "365", label: "一年" },
] as const;

export async function loader({ context, request }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const range = RANGES.find((r) => r.range === search.get("range"))?.range ?? "30";
  // The layout already checked that this is an admin.
  const res = await context.get(apiContext).admin.stats.$get({ query: { range } });
  if (!res.ok) throw new Error("Admin stats failed");
  return res.json();
}

type Stats = Route.ComponentProps["loaderData"];

const KINDS = [
  { kind: "site", label: "论坛", color: "var(--chart-1)" },
  { kind: "qq", label: "群里", color: "var(--chart-2)" },
  { kind: "total", label: "合起来", color: "var(--chart-3)" },
] as const;

// What the forum sends, as the bandwidth chart shows it, in this order.
const SENT = [
  { kind: "page", label: "页面", color: "var(--chart-1)" },
  { kind: "api", label: "接口", color: "var(--chart-2)" },
  { kind: "image", label: "图片", color: "var(--chart-3)" },
  { kind: "asset", label: "静态文件", color: "var(--chart-4)" },
] as const;

const number = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
const percent = (n: number) => `${number(n)}%`;
const hours = (seconds: number) => seconds / 3600;
const MB = 1024 ** 2;

type Day = Stats["days"][number];

// For figures recorded from some day on: from when, if that is within the range.
function recordedSince(days: Day[], recorded: (day: Day) => boolean, what: string) {
  const first = days.find(recorded);
  return first && first !== days[0] ? `${what}自 ${monthDay(first.day)}起记录` : undefined;
}

export default function Stats({ loaderData: stats }: Route.ComponentProps) {
  const { range, days, totals } = stats;
  const dates = days.map((d) => d.day);
  const period = RANGES.find((r) => r.range === String(range))?.label;
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="mr-auto text-xl font-semibold">数据</h1>
        <nav aria-label="时间范围" className="flex gap-1">
          {RANGES.map((r) => (
            <Link
              key={r.range}
              to={`?range=${r.range}`}
              preventScrollReset
              aria-current={r.range === String(range) ? "page" : undefined}
              className={cn(
                "rounded-full px-3 py-1 text-sm text-muted-foreground hover:text-foreground",
                r.range === String(range) && "bg-secondary font-medium text-foreground",
              )}
            >
              {r.label}
            </Link>
          ))}
        </nav>
      </div>
      <p className="mt-1 text-meta text-muted-foreground">
        按北京时间统计，箭头表示与之前 {period}相比的变化
      </p>

      <Section
        title="活跃"
        description={`论坛指打开过论坛的成员，群里指在群里发言、内容被收录或通过${BOT_NAME} 发帖的成员`}
      >
        <Active totals={totals} />
        <div className="mt-6">
          <LineChart
            title="日活"
            days={dates}
            series={KINDS.map((k) => ({
              label: k.label,
              color: k.color,
              values: days.map((d) => d.active[k.kind]),
            }))}
          />
        </div>
      </Section>

      <Members stats={stats} dates={dates} />

      <Section title="留存" description="按激活的那一周分组，之后各周来过论坛的人数占比">
        <Retention cohorts={stats.retention} />
      </Section>

      <Visits stats={stats} dates={dates} />

      <Content stats={stats} dates={dates} />

      <Section title="阅读">
        <div className="grid grid-cols-2 gap-3">
          <Figure
            label="阅读时长（小时）"
            value={hours(totals.now.read_seconds)}
            before={hours(totals.before.read_seconds)}
          />
          <Figure
            label="读过的楼层"
            value={totals.now.posts_read}
            before={totals.before.posts_read}
          />
        </div>
        <div className="mt-6">
          <LineChart
            title="每天的阅读时长（小时）"
            days={dates}
            series={[
              {
                label: "阅读时长",
                color: "var(--chart-1)",
                values: days.map((d) => hours(d.read_seconds)),
              },
            ]}
          />
        </div>
      </Section>

      <Logins stats={stats} dates={dates} />

      <Mail mail={stats.mail} />

      <Searches searches={stats.searches} />

      <Coins stats={stats} dates={dates} />

      <Bandwidth stats={stats} dates={dates} />

      <Top top={stats.top} />
    </>
  );
}

// Up or down from the period before, in percent; nothing when there was nothing to compare with.
// `neutral` for figures neither better nor worse when higher, such as bytes sent.
function Delta({
  now,
  before,
  neutral = false,
}: {
  now: number;
  before: number;
  neutral?: boolean;
}) {
  if (before === 0) return null;
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return <span className="text-meta text-muted-foreground">持平</span>;
  const Arrow = change > 0 ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-meta",
        neutral ? "text-muted-foreground" : change > 0 ? "text-success" : "text-destructive",
      )}
      title={`之前为 ${number(before)}`}
    >
      <Arrow className="size-3.5" aria-label={change > 0 ? "增加" : "减少"} />
      {Math.abs(change)}%
    </span>
  );
}

function Figure({
  label,
  value,
  before = null,
  format = number,
  note,
  neutral,
  className,
}: {
  label: string;
  value: number | null;
  before?: number | null;
  format?: (n: number) => string;
  note?: string;
  neutral?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border p-3", className)}>
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold">{value === null ? "—" : format(value)}</span>
        {value !== null && before !== null && (
          <Delta now={value} before={before} neutral={neutral} />
        )}
      </div>
      {note && <div className="text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

// Daily, weekly and monthly actives for each kind, and how many of the month's come on a day.
function Active({ totals: { now, before } }: { totals: Stats["totals"] }) {
  return (
    <div className="-mx-5 overflow-x-auto overscroll-x-contain">
      <table className="w-full text-sm whitespace-nowrap">
        <thead className="text-left text-meta text-muted-foreground">
          <tr>
            <th className="px-5 py-2 font-medium">
              <span className="sr-only">在哪里活跃</span>
            </th>
            <th className="px-2 py-2 font-medium sm:px-3">平均日活</th>
            <th className="px-2 py-2 font-medium sm:px-3">周活</th>
            <th className="px-2 py-2 font-medium sm:px-3">月活</th>
            <th className="py-2 pr-5 pl-2 font-medium sm:pl-3">黏性</th>
          </tr>
        </thead>
        <tbody className="divide-y border-t align-top">
          {KINDS.map(({ kind, label, color }) => (
            <tr key={kind}>
              <th className="py-2.5 pr-2 pl-5 text-left font-medium sm:pr-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded-full" style={{ background: color }} />
                  {label}
                </span>
              </th>
              {(["dau", "wau", "mau"] as const).map((key) => (
                <td key={key} className="px-2 py-2.5 sm:px-3">
                  <div className="font-semibold tabular-nums">{number(now[key][kind])}</div>
                  <Delta now={now[key][kind]} before={before[key][kind]} />
                </td>
              ))}
              <td className="py-2.5 pr-5 pl-2 font-semibold tabular-nums sm:pl-3">
                {now.mau[kind] === 0 ? "—" : percent((now.dau[kind] / now.mau[kind]) * 100)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 px-5 text-meta text-muted-foreground">
        平均日活不含今天。周活、月活为截至今天 7 天、30 天内来过的人数，黏性为平均日活占月活的比例。
      </p>
    </div>
  );
}

function Members({ stats, dates }: { stats: Stats; dates: string[] }) {
  const { days, totals } = stats;
  const latest = days.findLast((d) => d.members !== null);
  return (
    <Section
      title="成员"
      description={recordedSince(days, (d) => d.members !== null, "群成员数和已激活数")}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Figure label="群成员" value={latest?.members ?? null} />
        <Figure
          label="已激活"
          value={latest?.activated ?? null}
          note={
            latest?.members && latest.activated !== null
              ? `占群成员的 ${percent((latest.activated / latest.members) * 100)}`
              : undefined
          }
        />
        <Figure
          label="新激活"
          value={totals.now.new_activated}
          before={totals.before.new_activated}
        />
      </div>
      <div className="mt-6 grid gap-6">
        <LineChart
          title="激活率"
          days={dates}
          format={percent}
          series={[
            {
              label: "激活率",
              color: "var(--chart-1)",
              values: days.map((d) =>
                d.members && d.activated !== null ? (d.activated / d.members) * 100 : null,
              ),
            },
          ]}
        />
        <LineChart
          title="每天的新激活、进群和退群"
          days={dates}
          series={[
            { label: "新激活", color: "var(--chart-1)", values: days.map((d) => d.new_activated) },
            { label: "进群", color: "var(--chart-2)", values: days.map((d) => d.joined) },
            { label: "退群", color: "var(--chart-3)", values: days.map((d) => d.left) },
          ]}
        />
      </div>
    </Section>
  );
}

const WEEKS = ["第 1 周", "第 2 周", "第 4 周", "第 8 周"];

function Retention({ cohorts }: { cohorts: Stats["retention"] }) {
  if (cohorts.length === 0) {
    return <p className="text-sm text-muted-foreground">最近 12 周暂无新激活的成员</p>;
  }
  return (
    <div className="-mx-5 overflow-x-auto overscroll-x-contain">
      <table className="w-full text-sm whitespace-nowrap tabular-nums">
        <thead className="text-left text-meta text-muted-foreground">
          <tr>
            <th className="py-2 pr-2 pl-5 font-medium">激活的那周</th>
            <th className="px-2 py-2 text-right font-medium sm:px-3">人数</th>
            {WEEKS.map((w) => (
              <th key={w} className="px-2 py-2 text-right font-medium last:pr-5 sm:px-3">
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y border-t">
          {cohorts.map((c) => (
            <tr key={c.week}>
              <td className="py-2 pr-2 pl-5">{monthDay(c.week)}起</td>
              <td className="px-2 py-2 text-right sm:px-3">{number(c.size)}</td>
              {c.back.map((n, i) => {
                const share = n === null ? null : (n / c.size) * 100;
                return (
                  <td
                    key={WEEKS[i]}
                    className="px-2 py-2 text-right last:pr-5 sm:px-3"
                    style={
                      share === null
                        ? undefined
                        : {
                            background: `color-mix(in oklab, var(--chart-1) ${Math.round(share * 0.45)}%, transparent)`,
                          }
                    }
                    title={n === null ? undefined : `${n} 人`}
                  >
                    {share === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      `${Math.round(share)}%`
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 px-5 text-meta text-muted-foreground">
        尚未结束的那一周显示为 —，颜色越深占比越高
      </p>
    </div>
  );
}

function Visits({ stats, dates }: { stats: Stats; dates: string[] }) {
  const { range, days, totals, referrers, landings, devices } = stats;
  const { now, before } = totals;
  const since = recordedSince(days, (d) => d.guests !== null, "访问");
  return (
    <Section
      title="访问"
      description={`访客指未登录的 IP + User-Agent（不含爬虫），浏览量指打开页面的次数${since ? `。${since}` : ""}`}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Figure label="日均访客" value={now.guests} before={before.guests} />
        <Figure label="访客日均浏览" value={now.guest_views} before={before.guest_views} />
        <Figure label="成员日均浏览" value={now.member_views} before={before.member_views} />
      </div>
      <div className="mt-6 grid gap-6">
        <LineChart
          title="每天的访客"
          days={dates}
          series={[{ label: "访客", color: "var(--chart-1)", values: days.map((d) => d.guests) }]}
        />
        <LineChart
          title="每天的浏览量"
          days={dates}
          series={[
            { label: "访客", color: "var(--chart-1)", values: days.map((d) => d.guest_views) },
            { label: "成员", color: "var(--chart-2)", values: days.map((d) => d.member_views) },
          ]}
        />
      </div>
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <TopList
          title="访客的来源网站"
          items={referrers.map((r) => ({ key: r.host, label: r.host, count: r.visits }))}
        />
        <TopList
          title="访客的入口页面"
          items={landings.map((l) => ({
            key: l.path,
            label: (
              <Link to={l.path} title={l.path} className="hover:underline">
                {l.title ?? (l.path === "/" ? "首页" : l.path)}
              </Link>
            ),
            count: l.visits,
          }))}
        />
        {(["guests", "members"] as const).map((who) => (
          <TopList
            key={who}
            title={who === "guests" ? "访客的设备" : "成员的设备"}
            items={devices[who].map((d) => ({ key: d.device, label: d.device, count: d.visits }))}
          />
        ))}
      </div>
      <p className="mt-4 text-meta text-muted-foreground">
        以上列表按人次统计，每人每天算一次。
        {range > 90 && "访客的记录只保留 90 天，列表中的访客仅含最近 90 天。"}
      </p>
    </Section>
  );
}

// Where content came from, in this order.
const VIAS = [
  { via: "web", label: "网页", color: "var(--chart-1)" },
  { via: "bot", label: BOT_NAME, color: "var(--chart-2)" },
  { via: "qq", label: "群里收录", color: "var(--chart-3)" },
] as const;

const MADE = [
  { kind: "threads", label: "新帖" },
  { kind: "replies", label: "回复" },
  { kind: "reactions", label: "表情回应" },
] as const;

type Made = Stats["totals"]["now"]["content"];

function allSources(made: Made, kind: (typeof MADE)[number]["kind"]) {
  return made[kind].web + made[kind].bot + made[kind].qq;
}

// Minutes under an hour, hours under two days, then days.
function duration(seconds: number) {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} 分钟`;
  if (seconds < 48 * 3600) return `${number(seconds / 3600)} 小时`;
  return `${number(seconds / 86400)} 天`;
}

function Content({ stats, dates }: { stats: Stats; dates: string[] }) {
  const { days, totals } = stats;
  const { now, before } = totals;
  const { asked, solved, answered, wait } = now.questions;
  return (
    <Section
      title="内容"
      description={`公开的帖子、回复和表情回应，按来源分为网页、${BOT_NAME} 代发和群里收录。收录的按在群里发出的时间统计`}
    >
      <div className="-mx-5 overflow-x-auto overscroll-x-contain">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="text-left text-meta text-muted-foreground">
            <tr>
              <th className="px-5 py-2 font-medium">
                <span className="sr-only">来源</span>
              </th>
              {MADE.map((m) => (
                <th key={m.kind} className="px-2 py-2 font-medium last:pr-5 sm:px-3">
                  {m.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y border-t align-top">
            {VIAS.map(({ via, label, color }) => (
              <tr key={via}>
                <th className="py-2.5 pr-2 pl-5 text-left font-medium sm:pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-3 rounded-full" style={{ background: color }} />
                    {label}
                  </span>
                </th>
                {MADE.map(({ kind }) => (
                  <td key={kind} className="px-2 py-2.5 last:pr-5 sm:px-3">
                    <div className="font-semibold tabular-nums">
                      {number(now.content[kind][via])}
                    </div>
                    <Delta now={now.content[kind][via]} before={before.content[kind][via]} />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th className="py-2.5 pr-2 pl-5 text-left font-medium sm:pr-3">合计</th>
              {MADE.map(({ kind }) => (
                <td key={kind} className="px-2 py-2.5 last:pr-5 sm:px-3">
                  <div className="font-semibold tabular-nums">
                    {number(allSources(now.content, kind))}
                  </div>
                  <Delta
                    now={allSources(now.content, kind)}
                    before={allSources(before.content, kind)}
                  />
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Figure
          label="问答帖解决率"
          value={asked === 0 ? null : (solved / asked) * 100}
          format={percent}
          note={asked === 0 ? undefined : `共 ${number(asked)} 个问答帖`}
        />
        <Figure
          label="首条回复等待"
          value={wait}
          format={duration}
          note={asked > answered ? `${number(asked - answered)} 个暂无他人回复` : undefined}
        />
      </div>
      <p className="mt-2 text-meta text-muted-foreground">
        问答帖只统计在论坛上发的。等待时间指提问后第一条他人回复的时间，取中位数。
      </p>
      <div className="mt-6 grid gap-6">
        {MADE.map(({ kind, label }) => (
          <LineChart
            key={kind}
            title={`每天的${label}`}
            days={dates}
            series={VIAS.map((v) => ({
              label: v.label,
              color: v.color,
              values: days.map((d) => d.content[kind][v.via]),
            }))}
          />
        ))}
      </div>
    </Section>
  );
}

// The most frequent, each with a bar against the first; `detail` says what the count is made of.
function TopList({
  title,
  items,
}: {
  title: string;
  items: { key: string; label: ReactNode; count: number; detail?: string }[];
}) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-meta text-muted-foreground">暂无记录</p>
      ) : (
        <ol className="mt-2 space-y-2 text-sm">
          {items.map((item) => (
            <li key={item.key}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate">{item.label}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {item.detail ?? number(item.count)}
                </span>
              </div>
              <div
                className="mt-1 h-1 rounded-full"
                style={{
                  width: `${(item.count / items[0].count) * 100}%`,
                  background: "var(--chart-1)",
                }}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// A ranked thread, board or tag: the new replies and reactions it has.
function madeOf(m: { replies: number; reactions: number }) {
  return {
    count: m.replies + m.reactions,
    detail: `回复 ${number(m.replies)} · 表情 ${number(m.reactions)}`,
  };
}

// The most replied to and reacted to over the range.
function Top({ top }: { top: Stats["top"] }) {
  return (
    <Section title="排行" description="这段时间公开的新回复和表情回应合计最多的帖子、版块和标签">
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <TopList
            title="帖子"
            items={top.threads.map((t) => ({
              key: String(t.id),
              label: (
                <Link to={`/t/${t.id}`} title={t.title} className="hover:underline">
                  {t.title}
                </Link>
              ),
              ...madeOf(t),
            }))}
          />
        </div>
        <TopList
          title="版块"
          items={top.boards.map((b) => ({
            key: b.slug,
            label: (
              <Link to={`/b/${b.slug}`} className="hover:underline">
                {b.name}
              </Link>
            ),
            ...madeOf(b),
          }))}
        />
        <TopList
          title="标签"
          items={top.tags.map((t) => ({
            key: t.name,
            label: (
              <Link to={`/?tag=${encodeURIComponent(t.name)}`} className="hover:underline">
                {t.name}
              </Link>
            ),
            ...madeOf(t),
          }))}
        />
      </div>
    </Section>
  );
}

// The ways to log in, as the login page names them, in this order.
const LOGINS = [
  { method: "code", label: "口令", color: "var(--chart-1)" },
  { method: "link", label: "链接", color: "var(--chart-2)" },
  { method: "email", label: "QQ 邮箱", color: "var(--chart-3)" },
] as const;

function loginsInAll({ code, link, email }: Day["logins"]) {
  return code + link + email;
}

function Logins({ stats, dates }: { stats: Stats; dates: string[] }) {
  const { days, totals } = stats;
  const { now, before } = totals;
  return (
    <Section title="登录" description="按次统计，同一成员多次登录分别计算">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure
          label="合计"
          value={loginsInAll(now.logins)}
          before={loginsInAll(before.logins)}
          neutral
        />
        {LOGINS.map((l) => (
          <Figure
            key={l.method}
            label={l.label}
            value={now.logins[l.method]}
            before={before.logins[l.method]}
            neutral
          />
        ))}
      </div>
      <div className="mt-6">
        <LineChart
          title="每天的登录次数"
          days={dates}
          series={LOGINS.map((l) => ({
            label: l.label,
            color: l.color,
            values: days.map((d) => d.logins[l.method]),
          }))}
        />
      </div>
    </Section>
  );
}

// Each kind of mail as the settings call it.
const MAIL_KINDS: Partial<Record<string, string>> = {
  ...NOTIFICATION_LABELS,
  weekly: "每周来信",
  login: "登录验证码",
  test: "测试邮件",
};

function sum(kinds: Stats["mail"], key: "sent" | "dropped" | "opened" | "clicked") {
  return kinds.reduce((total, m) => total + (m[key] ?? 0), 0);
}

// In percent; null for mails that don't tell, or when none were sent.
function rate(n: number | null, of: number) {
  return n === null || of === 0 ? null : (n / of) * 100;
}

function Mail({ mail }: { mail: Stats["mail"] }) {
  // The mails that tell when they are opened: reminders and letters.
  const tracked = mail.filter((m) => m.opened !== null);
  return (
    <Section
      title="邮件"
      description="打开率和点击率只统计通知邮件和每周来信。部分邮箱默认不显示图片，实际打开的会更多"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="发出" value={sum(mail, "sent")} />
        <Figure label="发送失败" value={sum(mail, "dropped")} />
        <Figure
          label="打开率"
          value={rate(sum(tracked, "opened"), sum(tracked, "sent"))}
          format={percent}
        />
        <Figure
          label="点击率"
          value={rate(sum(tracked, "clicked"), sum(tracked, "sent"))}
          format={percent}
        />
      </div>
      {mail.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">这段时间暂无邮件</p>
      ) : (
        <div className="mt-4 -mx-5 overflow-x-auto overscroll-x-contain">
          <table className="w-full text-sm whitespace-nowrap tabular-nums">
            <thead className="text-left text-meta text-muted-foreground">
              <tr>
                <th className="py-2 pr-2 pl-5 font-medium">类别</th>
                <th className="px-2 py-2 text-right font-medium sm:px-3">发出</th>
                <th className="px-2 py-2 text-right font-medium sm:px-3">失败</th>
                <th className="px-2 py-2 text-right font-medium sm:px-3">打开率</th>
                <th className="py-2 pr-5 pl-2 text-right font-medium sm:pl-3">点击率</th>
              </tr>
            </thead>
            <tbody className="divide-y border-t">
              {mail.map((m) => {
                const opened = rate(m.opened, m.sent);
                const clicked = rate(m.clicked, m.sent);
                return (
                  <tr key={m.kind}>
                    <td className="py-2 pr-2 pl-5">{MAIL_KINDS[m.kind] ?? m.kind}</td>
                    <td className="px-2 py-2 text-right sm:px-3">{number(m.sent)}</td>
                    <td className="px-2 py-2 text-right sm:px-3">{number(m.dropped)}</td>
                    <td className="px-2 py-2 text-right sm:px-3">
                      {opened === null ? "—" : percent(opened)}
                    </td>
                    <td className="py-2 pr-5 pl-2 text-right sm:pl-3">
                      {clicked === null ? "—" : percent(clicked)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// Search terms, each opening the search page for it.
function termsListed(terms: Stats["searches"]["most"]) {
  return terms.map((t) => ({
    key: t.term,
    label: (
      <Link
        to={`/search?q=${encodeURIComponent(t.term)}`}
        title={t.term}
        className="hover:underline"
      >
        {t.term}
      </Link>
    ),
    count: t.searches,
  }));
}

function Searches({ searches }: { searches: Stats["searches"] }) {
  return (
    <Section
      title="搜索"
      description="网页上搜索的词，不记录是谁搜的。同一人一天内搜同一个词只算一次"
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <TopList title="搜得最多的词" items={termsListed(searches.most)} />
        <TopList title="没有结果的词" items={termsListed(searches.unfound)} />
      </div>
    </Section>
  );
}

// Where coins come from and what they go on, as the coins page names them, in this order.
const EARNINGS = [
  { reason: "check_in", label: "签到", color: "var(--chart-1)" },
  { reason: "liked", label: "获赞", color: "var(--chart-2)" },
  { reason: "accepted", label: "回复被采纳", color: "var(--chart-3)" },
  { reason: "bounty", label: "回答悬赏", color: "var(--chart-4)" },
] as const;

const SPENDINGS = [
  { reason: "question", label: "发问答帖", color: "var(--chart-1)" },
  { reason: "look", label: "兑换动态版", color: "var(--chart-2)" },
] as const;

type Coined = { key: string; label: string; color: string; now: number; before: number };

function coinsIn(rows: Coined[], when: "now" | "before") {
  return rows.reduce((total, r) => total + r[when], 0);
}

function LedgerRow({
  label,
  color,
  now,
  before,
}: {
  label: string;
  color?: string;
  now: number;
  before: number;
}) {
  return (
    <tr>
      <th className="py-2 text-left font-normal">
        <span className="inline-flex items-center gap-1.5">
          {color && <span className="h-0.5 w-3 rounded-full" style={{ background: color }} />}
          {label}
        </span>
      </th>
      <td className="py-2 text-right font-semibold tabular-nums">{number(now)}</td>
      <td className="w-16 py-2 pl-2">
        <Delta now={now} before={before} neutral />
      </td>
    </tr>
  );
}

// Coins by where they came from or went, with the total.
function Ledger({ title, rows }: { title: string; rows: Coined[] }) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-medium">{title}</h3>
      <table className="mt-1 w-full text-sm">
        <tbody className="divide-y">
          {rows.map((r) => (
            <LedgerRow key={r.key} label={r.label} color={r.color} now={r.now} before={r.before} />
          ))}
          <LedgerRow label="合计" now={coinsIn(rows, "now")} before={coinsIn(rows, "before")} />
        </tbody>
      </table>
    </div>
  );
}

function Coins({ stats, dates }: { stats: Stats; dates: string[] }) {
  const { days, totals } = stats;
  const { now, before } = totals;
  return (
    <Section title="鼠币" description="获赞、采纳和悬赏的鼠币次日到账，所以今天的发放只含签到">
      <div className="grid gap-6 sm:grid-cols-2">
        <Ledger
          title="发放"
          rows={EARNINGS.map((e) => ({
            key: e.reason,
            label: e.label,
            color: e.color,
            now: now.coins.earned[e.reason],
            before: before.coins.earned[e.reason],
          }))}
        />
        <Ledger
          title="消耗"
          rows={SPENDINGS.map((e) => ({
            key: e.reason,
            label: e.label,
            color: e.color,
            now: now.coins.spent[e.reason],
            before: before.coins.spent[e.reason],
          }))}
        />
      </div>
      <div className="mt-6 grid gap-6">
        <LineChart
          title="每天发放的鼠币"
          days={dates}
          series={EARNINGS.map((e) => ({
            label: e.label,
            color: e.color,
            values: days.map((d) => d.coins.earned[e.reason]),
          }))}
        />
        <LineChart
          title="每天消耗的鼠币"
          days={dates}
          series={SPENDINGS.map((e) => ({
            label: e.label,
            color: e.color,
            values: days.map((d) => d.coins.spent[e.reason]),
          }))}
        />
      </div>
    </Section>
  );
}

// Bytes sent, of one kind or in all, in MB.
function megabytes(bytes: Day["bytes"], kind?: (typeof SENT)[number]["kind"]) {
  if (bytes === null) return null;
  return (kind ? bytes[kind] : bytes.page + bytes.api + bytes.image + bytes.asset) / MB;
}

function Bandwidth({ stats, dates }: { stats: Stats; dates: string[] }) {
  const { days, totals } = stats;
  const { now, before } = totals;
  const since = recordedSince(days, (d) => d.bytes !== null, "流量");
  return (
    <Section
      title="带宽"
      description={`论坛平均每天发出的流量（MB），图片含正文图、头像和背景${since ? `。${since}` : ""}`}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Figure
          label="合计"
          value={megabytes(now.bytes)}
          before={megabytes(before.bytes)}
          neutral
          className="col-span-2 sm:col-span-1"
        />
        {SENT.map((s) => (
          <Figure
            key={s.kind}
            label={s.label}
            value={megabytes(now.bytes, s.kind)}
            before={megabytes(before.bytes, s.kind)}
            neutral
          />
        ))}
      </div>
      <div className="mt-6">
        <LineChart
          title="每天发出的流量（MB）"
          days={dates}
          series={SENT.map((s) => ({
            label: s.label,
            color: s.color,
            values: days.map((d) => megabytes(d.bytes, s.kind)),
          }))}
        />
      </div>
    </Section>
  );
}
