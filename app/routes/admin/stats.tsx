import { Link } from "react-router";
import { cn } from "cn";
import { apiContext } from "../../api.server.ts";
import { ArrowDown, ArrowUp } from "~/components/icons";
import { Section } from "~/components/form-parts";
import { pageTitle } from "~/share-meta";
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

const number = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
const percent = (n: number) => `${number(n)}%`;
const hours = (seconds: number) => seconds / 3600;

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
    </>
  );
}

// Up or down from the period before, in percent; nothing when there was nothing to compare with.
function Delta({ now, before }: { now: number; before: number }) {
  if (before === 0) return null;
  const change = Math.round(((now - before) / before) * 100);
  if (change === 0) return <span className="text-meta text-muted-foreground">持平</span>;
  const Arrow = change > 0 ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-meta",
        change > 0 ? "text-success" : "text-destructive",
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
  before,
  note,
}: {
  label: string;
  value: number | null;
  before?: number;
  note?: string;
}) {
  return (
    <div className="rounded-xl border p-3">
      <div className="text-meta text-muted-foreground">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold">{value === null ? "—" : number(value)}</span>
        {value !== null && before !== undefined && <Delta now={value} before={before} />}
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
  // Member counts are snapshots, which began on some day.
  const first = days.find((d) => d.members !== null);
  return (
    <Section
      title="成员"
      description={
        first && first !== days[0] ? `群成员数和已激活数自 ${monthDay(first.day)}起记录` : undefined
      }
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
