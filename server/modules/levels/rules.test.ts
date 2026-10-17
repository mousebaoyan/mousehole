import { describe, expect, test } from "vitest";
import { earnedLevel, keepsL4, requirements, type Recent, type Totals } from "./rules.ts";

const none: Totals = {
  threads_entered: 0,
  posts_read: 0,
  threads_replied: 0,
  likes: 0,
  days_visited: 0,
  read_seconds: 0,
};
const l3: Totals = {
  threads_entered: 10,
  posts_read: 300,
  threads_replied: 30,
  likes: 30,
  days_visited: 30,
  read_seconds: 10_800,
};
const quiet: Recent = {
  days_visited: 0,
  threads_replied: 0,
  posts_read: 0,
  read_seconds: 0,
  likes: 0,
  clean_days: 50,
};
const busy: Recent = {
  days_visited: 35,
  threads_replied: 80,
  posts_read: 1000,
  read_seconds: 36_000,
  likes: 120,
  clean_days: 50,
};

describe("等级", () => {
  test("每一级都要满足下面各级的条件，够了可以一次升几级", () => {
    expect(earnedLevel(none, busy)).toBe(0);
    expect(earnedLevel({ ...none, threads_entered: 10, posts_read: 60 }, busy)).toBe(1);
    // Replies and likes enough for L2, but not having read enough for L1.
    expect(earnedLevel({ ...none, threads_replied: 10, likes: 5 }, busy)).toBe(0);
    expect(earnedLevel(l3, quiet)).toBe(3);
    expect(earnedLevel(l3, busy)).toBe(4);
  });

  test("L4 看最近 50 天，其间被禁言或封禁过就不够", () => {
    expect(keepsL4(busy)).toBe(true);
    expect(keepsL4({ ...busy, clean_days: 49 })).toBe(false);
    expect(keepsL4({ ...busy, likes: 119 })).toBe(false);
  });

  test("升级进度列出下一级的每项条件", () => {
    expect(requirements(1, { ...none, posts_read: 12 }, quiet)).toEqual([
      { key: "threads_entered", label: "进入的帖子", have: 0, need: 10 },
      { key: "posts_read", label: "读过的楼层", have: 12, need: 60 },
    ]);
    expect(requirements(4, l3, { ...busy, clean_days: 3 }).at(-1)).toEqual({
      key: "clean_days",
      label: "未被禁言或封禁的天数",
      have: 3,
      need: 50,
    });
  });
});
