// Times in Beijing time, against a `now` from the loader, so the server and the browser render
// the same text. Written out by hand rather than with Intl, which costs far more per call, and a
// thread page shows dozens.

const OFFSET_S = 8 * 3600;

export function unixNow() {
  return Math.floor(Date.now() / 1000);
}

// Days since the epoch on Beijing's calendar; China has no daylight saving time.
function day(unix: number) {
  return Math.floor((unix + OFFSET_S) / 86_400);
}

// Beijing's wall clock as a UTC date, to read with getUTC*().
function beijing(unix: number) {
  return new Date((unix + OFFSET_S) * 1000);
}

// For days: "10月3日", with the year when not this one.
export function date(unix: number, now: number) {
  const d = beijing(unix);
  const monthDay = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  const year = d.getUTCFullYear();
  return year === beijing(now).getUTCFullYear() ? monthDay : `${year}年${monthDay}`;
}

// The coming midnight in Beijing.
export function endOfDay(unix: number) {
  return (day(unix) + 1) * 86_400 - OFFSET_S;
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

// For posts: "今天 09:12", "昨天 21:40", "10月3日 08:00"; for deadlines also "明天 22:00".
export function stamp(unix: number, now: number) {
  const days = day(now) - day(unix);
  const time = beijing(unix).toISOString().slice(11, 16);
  if (days === 0) return `今天 ${time}`;
  if (days === 1) return `昨天 ${time}`;
  if (days === -1) return `明天 ${time}`;
  return `${date(unix, now)} ${time}`;
}

// What <input type="datetime-local">, which knows no time zone, shows and takes: Beijing's wall
// clock, to the minute.
export function wallClock(unix: number) {
  return beijing(unix).toISOString().slice(0, 16);
}

export function fromWallClock(value: string) {
  return Date.parse(`${value}:00+08:00`) / 1000;
}
