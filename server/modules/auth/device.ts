// "QQ 浏览器 · Android" from a User-Agent: enough for the person confirming a login code to
// notice a device that isn't theirs. Order matters: in-app browsers also claim Safari or Chrome.
const BROWSERS: [RegExp, string][] = [
  [/MicroMessenger/, "微信"],
  [/\bQQ\//, "手机 QQ"],
  [/QQBrowser/, "QQ 浏览器"],
  [/Edg(A|iOS)?\//, "Edge"],
  [/Firefox|FxiOS/, "Firefox"],
  [/Chrome|CriOS/, "Chrome"],
  [/Safari/, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

export function deviceSummary(userAgent: string) {
  const browser = BROWSERS.find(([re]) => re.test(userAgent))?.[1] ?? "未知浏览器";
  const system = SYSTEMS.find(([re]) => re.test(userAgent))?.[1] ?? "未知系统";
  return `${browser} · ${system}`;
}
