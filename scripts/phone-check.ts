// Opens pages as a phone does, 360px wide, logged in as the owner, who sees every page. Reports
// what runs off the screen sideways, on the page itself or in any menu or dropdown opened from
// it, and saves a screenshot of each page into test-results/phone/ for looking over the layout
// and the copy. Run it with `pnpm dev` up:
//
//   pnpm phone-check [路径…]
//
// With no paths it opens the pages that need no ID; add a thread or a user page to check those.
import { mkdirSync } from "node:fs";
import { chromium, devices } from "@playwright/test";
import { issueLoginLink } from "../server/modules/auth/service.ts";
import { ensureOwner } from "../server/modules/users/service.ts";
import { db } from "../server/platform/db.ts";
import { env } from "../server/platform/env.ts";

const PAGES = [
  "/",
  "/search?q=保研",
  "/notifications",
  "/coins",
  "/badges",
  "/settings",
  "/drafts",
  "/my/posts",
  "/admin",
  "/admin/content",
  "/admin/reports",
  "/admin/archive-flags",
  "/admin/suggestions",
  "/admin/members",
  "/admin/boards",
  "/admin/tags",
  "/admin/badges",
  "/admin/site",
  "/admin/groups",
  "/admin/email",
  "/admin/tokens",
  "/admin/logs",
];
const WIDTH = 360;
const OUT = "test-results/phone";

const paths = process.argv.slice(2);
const token = await issueLoginLink(await ensureOwner());
await db.destroy();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  ...devices["iPhone 13"],
  viewport: { width: WIDTH, height: 760 },
  baseURL: env.PUBLIC_URL,
});
await page.goto(`/login/link?token=${token}`);
await page.getByRole("button", { name: "确认登录" }).click();
await page.waitForURL((url) => url.pathname !== "/login/link");

// The elements matching the selector that stick out past the screen's edges, leaving out those
// inside something that scrolls or clips sideways, as a wide table does on purpose. Measured
// against the set width: a phone widens the page to take in what sticks out.
function offscreen(selector: string) {
  return page.evaluate(
    ([css, width]) => {
      const out: string[] = [];
      for (const e of document.querySelectorAll(css)) {
        const box = e.getBoundingClientRect();
        if (box.width === 0 || (box.left >= -1 && box.right <= width + 1)) continue;
        let up = e.parentElement;
        while (up && getComputedStyle(up).overflowX === "visible") up = up.parentElement;
        if (up === null) out.push(`<${e.tagName.toLowerCase()} class="${e.className}">`);
      }
      return out;
    },
    [selector, WIDTH] as const,
  );
}

let problems = 0;
function report(what: string, found: string[]) {
  if (found.length === 0) return;
  problems += found.length;
  console.log(`  ${what}：\n${found.map((e) => `    ${e.slice(0, 120)}`).join("\n")}`);
}

for (const path of paths.length > 0 ? paths : PAGES) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  console.log(path);
  await page.screenshot({
    path: `${OUT}/${path.replace(/[^\w]+/g, "_")}.png`,
    fullPage: true,
  });
  report("超出屏幕", await offscreen("body *"));
  // Every menu and dropdown on the page, opened one at a time; their panels are z-50.
  for (const trigger of await page.locator("button[aria-expanded]").all()) {
    if (!(await trigger.isVisible()) || (await trigger.getAttribute("aria-expanded")) === "true")
      continue;
    const name = (await trigger.getAttribute("aria-label")) ?? (await trigger.innerText());
    await trigger.click();
    report(`「${name}」展开后超出屏幕`, await offscreen(".z-50"));
    await page.keyboard.press("Escape");
    // A dialog's close event comes in a task after the key's; the menus close at once.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
    if ((await trigger.getAttribute("aria-expanded")) === "true") await trigger.click();
  }
}
await browser.close();
console.log(problems === 0 ? "没有发现超出屏幕的元素" : `发现 ${problems} 处超出屏幕`);
process.exitCode = problems === 0 ? 0 : 1;
