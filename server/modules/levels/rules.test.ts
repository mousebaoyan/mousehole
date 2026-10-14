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
  threads_entered: 5,
  posts_read: 100,
  threads_replied: 10,
  likes: 10,
  days_visited: 10,
  read_seconds: 3600,
};
const quiet: Recent = {
  days_visited: 0,
  threads_replied: 0,
  posts_read: 0,
  read_seconds: 0,
  likes: 0,
  clean_days: 30,
};
const busy: Recent = {
  days_visited: 15,
  threads_replied: 15,
  posts_read: 200,
  read_seconds: 7200,
  likes: 20,
  clean_days: 30,
};

describe("等级", () => {
  test("每一级都要满足下面各级的条件，够了可以一次升几级", () => {
    expect(earnedLevel(none, busy)).toBe(0);
    expect(earnedLevel({ ...none, threads_entered: 5, posts_read: 30 }, busy)).toBe(1);
    // Replies and likes enough for L2, but not having read enough for L1.
    expect(earnedLevel({ ...none, threads_replied: 3, likes: 1 }, busy)).toBe(0);
    expect(earnedLevel(l3, quiet)).toBe(3);
    expect(earnedLevel(l3, busy)).toBe(4);
  });

  test("L4 看最近 30 天，其间被禁言或封禁过就不够", () => {
    expect(keepsL4(busy)).toBe(true);
    expect(keepsL4({ ...busy, clean_days: 29 })).toBe(false);
    expect(keepsL4({ ...busy, likes: 19 })).toBe(false);
  });

  test("升级进度列出下一级的每项条件", () => {
    expect(requirements(1, { ...none, posts_read: 12 }, quiet)).toEqual([
      { key: "threads_entered", label: "进入的帖子", have: 0, need: 5 },
      { key: "posts_read", label: "读过的楼层", have: 12, need: 30 },
    ]);
    expect(requirements(4, l3, { ...busy, clean_days: 3 }).at(-1)).toEqual({
      key: "clean_days",
      label: "没被禁言或封禁的天数",
      have: 3,
      need: 30,
    });
  });
});
