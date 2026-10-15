import { AppError } from "./errors.ts";

// Fixed-window counters in this process, keyed by raw strings such as "email:qq:123456".
// Restarts forget them, which is fine for abuse limits.
const windows = new Map<string, { count: number; resetAt: number }>();
const PRUNE_AT = 10_000;

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  if (windows.size > PRUNE_AT) {
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  }
  let window = windows.get(key);
  if (!window || window.resetAt <= now) {
    window = { count: 0, resetAt: now + windowMs };
    windows.set(key, window);
  }
  if (window.count >= limit) {
    const retryAfter = Math.ceil((window.resetAt - now) / 1000);
    throw new AppError(429, "rate_limited", `操作过于频繁，请 ${retryAfter} 秒后重试`, {
      retryAfter,
    });
  }
  window.count++;
}
