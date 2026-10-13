import { describe, expect, test } from "vitest";
import { deviceSummary } from "./device.ts";

describe("设备摘要", () => {
  test.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Chrome · macOS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; V2309A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0 Mobile Safari/537.36 QQ/9.1.5.1234 V1_AND_SQ",
      "手机 QQ · Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50",
      "微信 · iOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0",
      "Edge · Windows",
    ],
    ["curl/8.5.0", "未知浏览器 · 未知系统"],
  ])("%s", (userAgent, summary) => {
    expect(deviceSummary(userAgent)).toBe(summary);
  });
});
