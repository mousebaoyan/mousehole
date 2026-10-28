// What sponsoring takes (design §8.21). Pages use this file too, so it imports nothing.

export const METHODS = ["wechat", "alipay"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_NAMES: Record<Method, string> = { wechat: "微信", alipay: "支付宝" };

export const STATUSES = ["pending", "confirmed", "rejected"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_NAMES: Record<Status, string> = {
  pending: "待确认",
  confirmed: "已确认",
  rejected: "未收到",
};

// The items the payee set on the WeChat code, in fen: what keeps the group running so many days.
// The thanks wall shows the tier an amount reaches instead of the amount.
export const TIERS = [
  { days: 2, amount: 700 },
  { days: 4, amount: 1400 },
  { days: 7, amount: 2400 },
] as const;

export const MIN_AMOUNT = 100;
export const MAX_AMOUNT = 100_000;
export const MAX_MESSAGE = 50;

// null below the lowest tier.
export function daysOf(amount: number) {
  return TIERS.findLast((t) => amount >= t.amount)?.days ?? null;
}

export function tierName(days: number | null) {
  if (days === null) return "一份心意";
  return `支持鼠群运行${days === 7 ? "一周" : ` ${days} 天`}`;
}

// ¥ amounts without the cents when there are none: 7, 6.66.
export function yuan(fen: number) {
  return fen % 100 === 0 ? String(fen / 100) : (fen / 100).toFixed(2);
}

// A code's picture, named by what it holds, so one replaced in the settings shows at once.
export function codeImagePath(method: Method, code: string) {
  return `/sponsor/${method}.png?${new URLSearchParams({ v: code })}`;
}
