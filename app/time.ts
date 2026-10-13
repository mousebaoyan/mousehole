// Times in Beijing time, against a `now` from the loader, so the server and the browser render
// the same text.

const ZONE = "Asia/Shanghai";
const OFFSET_S = 8 * 3600;

const monthDay = new Intl.DateTimeFormat("zh-CN", {
  timeZone: ZONE,
  month: "long",
  day: "numeric",
});
const fullDate = new Intl.DateTimeFormat("zh-CN", { timeZone: ZONE, dateStyle: "long" });
const clock = new Intl.DateTimeFormat("zh-CN", {
  timeZone: ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const year = new Intl.DateTimeFormat("zh-CN", { timeZone: ZONE, year: "numeric" });

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

// Days since the epoch on Beijing's calendar; China has no daylight saving time.
function day(unix: number) {
  return Math.floor((unix + OFFSET_S) / 86_400);
}

function date(unix: number, now: number) {
  const d = new Date(unix * 1000);
  return year.format(d) === year.format(new Date(now * 1000))
    ? monthDay.format(d)
    : fullDate.format(d);
}

// For lists: "12 分钟前", "昨天", "10月3日".
export function ago(unix: number, now: number) {
  const s = now - unix;
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`;
  const days = day(now) - day(unix);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return date(unix, now);
}

// For posts: "今天 09:12", "昨天 21:40", "10月3日 08:00".
export function stamp(unix: number, now: number) {
  const days = day(now) - day(unix);
  const time = clock.format(new Date(unix * 1000));
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  return `${date(unix, now)} ${time}`;
}
