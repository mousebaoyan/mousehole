import { useState, type PointerEvent } from "react";
import { cn } from "cn";

// A line chart of daily figures for the stats page (design §10.1). The lines are an SVG stretched
// over the plot, kept 2px wide; the axis labels, dots and readout are HTML placed by percentage,
// so text stays its size on any width without measuring the page.

type Series = { label: string; color: string; values: (number | null)[] };

const WEEKDAY = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" });

// "2026-10-19" as "10/19" on the axis, "10月19日", and "10月19日 周日" in the readout.
function shortDay(day: string) {
  const [, month, date] = day.split("-");
  return `${Number(month)}/${Number(date)}`;
}

export function monthDay(day: string) {
  const [, month, date] = day.split("-");
  return `${Number(month)}月${Number(date)}日`;
}

function longDay(day: string) {
  return `${monthDay(day)} ${WEEKDAY.format(new Date(`${day}T12:00:00+08:00`))}`;
}

// Whole-number gridlines, about four, from zero to just above the highest value.
function gridlines(highest: number) {
  const rough = Math.max(highest, 1) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const m = rough / power;
  const step = Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * power);
  const top = Math.max(step, Math.ceil(highest / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

// Five or so dates under the axis, evenly apart and counted back from the last day.
function dateTicks(count: number) {
  const step = Math.ceil((count - 1) / 5);
  const ticks = [];
  for (let i = count - 1; i >= 0; i -= step) ticks.unshift(i);
  return ticks;
}

// The unbroken runs of a series: a day without a value leaves a gap.
function runs(values: (number | null)[]) {
  const all: { index: number; value: number }[][] = [[]];
  values.forEach((value, index) => {
    if (value === null) all.push([]);
    else all[all.length - 1].push({ index, value });
  });
  return all.filter((run) => run.length > 0);
}

export function LineChart({
  title,
  days,
  series,
  format = (n) => n.toLocaleString("zh-CN", { maximumFractionDigits: 1 }),
}: {
  title: string;
  days: string[];
  series: Series[];
  format?: (n: number) => string;
}) {
  const [index, setIndex] = useState<number | null>(null);
  const last = days.length - 1;
  const values = series.flatMap((s) => s.values.filter((v) => v !== null));
  const lines = gridlines(Math.max(0, ...values));
  const top = lines[lines.length - 1];
  const x = (i: number) => (i / last) * 100;
  const y = (v: number) => 100 - (v / top) * 100;

  // The day nearest the pointer, so nobody has to hit a 2px line.
  function pick(e: PointerEvent<HTMLInputElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const at = Math.round(((e.clientX - box.left) / box.width) * last);
    setIndex(Math.min(last, Math.max(0, at)));
  }

  const readout = (i: number) =>
    `${longDay(days[i])}：${series
      .map((s) => {
        const value = s.values[i];
        return `${s.label} ${value === null ? "无" : format(value)}`;
      })
      .join("，")}`;

  return (
    <figure className="min-w-0">
      <figcaption className="text-sm font-medium">{title}</figcaption>
      {series.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted-foreground">
          {series.map((s) => (
            <li key={s.label} className="inline-flex items-center gap-1.5">
              <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 pl-9">
        <div className="relative h-40 rounded-sm ring-ring has-focus-visible:ring-2 sm:h-48">
          {lines.map((line) => (
            <div
              key={line}
              className="absolute inset-x-0 border-t border-border"
              style={{ top: `${y(line)}%` }}
            >
              <span className="absolute right-full mr-2 -translate-y-1/2 text-2xs text-muted-foreground tabular-nums">
                {format(line)}
              </span>
            </div>
          ))}
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
            className="absolute inset-0 size-full overflow-visible"
          >
            {series.map((s) =>
              runs(s.values)
                .filter((run) => run.length > 1)
                .map((run) => (
                  <polyline
                    key={`${s.label}-${run[0].index}`}
                    points={run.map((p) => `${x(p.index)},${y(p.value)}`).join(" ")}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                )),
            )}
          </svg>
          {/* A value standing alone has no line to show it. */}
          {series.map((s) =>
            runs(s.values)
              .filter((run) => run.length === 1)
              .map(([p]) => (
                <Dot key={`${s.label}-${p.index}`} color={s.color} at={[x(p.index), y(p.value)]} />
              )),
          )}
          {index !== null && (
            <>
              <div
                className="absolute inset-y-0 border-l border-muted-foreground/50"
                style={{ left: `${x(index)}%` }}
              />
              {series.map((s) => {
                const value = s.values[index];
                return (
                  value !== null && <Dot key={s.label} color={s.color} at={[x(index), y(value)]} />
                );
              })}
              <div
                className={cn(
                  "pointer-events-none absolute top-0 z-10 rounded-lg border bg-popover px-2.5 py-1.5 text-meta whitespace-nowrap shadow-md",
                  x(index) > 50 ? "-translate-x-full -ml-2" : "ml-2",
                )}
                style={{ left: `${x(index)}%` }}
              >
                <div className="text-muted-foreground">{longDay(days[index])}</div>
                {series.map((s) => {
                  const value = s.values[index];
                  return (
                    <div key={s.label} className="flex items-center gap-1.5">
                      <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
                      <span className="font-semibold tabular-nums">
                        {value === null ? "—" : format(value)}
                      </span>
                      {series.length > 1 && (
                        <span className="text-muted-foreground">{s.label}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {/* Over the whole plot and unseen: the range input gives the arrow keys, dragging on
              phones, and the day's values to screen readers. */}
          <input
            type="range"
            min={0}
            max={last}
            value={index ?? last}
            aria-label={title}
            aria-valuetext={readout(index ?? last)}
            className="absolute inset-0 size-full cursor-crosshair touch-pan-y opacity-0"
            onChange={(e) => setIndex(Number(e.target.value))}
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={(e) => e.pointerType === "mouse" && setIndex(null)}
            onFocus={() => setIndex((i) => i ?? last)}
            onBlur={() => setIndex(null)}
          />
        </div>
        <div className="relative mt-1.5 h-4 text-2xs text-muted-foreground tabular-nums">
          {dateTicks(days.length).map((i) => (
            <span
              key={i}
              className={cn(
                "absolute",
                i === 0 ? "" : i === last ? "-translate-x-full" : "-translate-x-1/2",
              )}
              style={{ left: `${x(i)}%` }}
            >
              {shortDay(days[i])}
            </span>
          ))}
        </div>
      </div>
      <DataTable days={days} series={series} format={format} />
    </figure>
  );
}

function Dot({ color, at: [left, top] }: { color: string; at: [number, number] }) {
  return (
    <span
      className="absolute size-2.5 -translate-1/2 rounded-full ring-2 ring-card"
      style={{ left: `${left}%`, top: `${top}%`, background: color }}
    />
  );
}

// Every value of the chart, newest first, for reading without pointing at each day.
function DataTable({
  days,
  series,
  format,
}: {
  days: string[];
  series: Series[];
  format: (n: number) => string;
}) {
  return (
    <details className="mt-2 text-meta">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        查看数据表
      </summary>
      <div className="mt-2 max-h-64 overflow-auto overscroll-contain rounded-lg border">
        <table className="w-full whitespace-nowrap tabular-nums">
          <thead className="sticky top-0 bg-card text-left text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 font-medium">日期</th>
              {series.map((s) => (
                <th key={s.label} className="px-3 py-1.5 text-right font-medium">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y border-t">
            {days
              .map((day, i) => ({ day, i }))
              .toReversed()
              .map(({ day, i }) => (
                <tr key={day}>
                  <td className="px-3 py-1.5">{longDay(day)}</td>
                  {series.map((s) => {
                    const value = s.values[i];
                    return (
                      <td key={s.label} className="px-3 py-1.5 text-right">
                        {value === null ? "—" : format(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
