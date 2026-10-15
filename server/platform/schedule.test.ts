import { afterEach, expect, test, vi } from "vitest";
import { every } from "./schedule.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("上一次还没跑完时跳过这一次，跑完后照常", async () => {
  vi.useFakeTimers();
  let runs = 0;
  const first = Promise.withResolvers<void>();
  every(1000, "测试", () => {
    runs++;
    return first.promise;
  });

  await vi.advanceTimersByTimeAsync(3000);
  expect(runs).toBe(1);
  first.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toBe(2);
});
