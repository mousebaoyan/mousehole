import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { SERVER_ENV } from "./env.ts";

// Through the bootstrap command's one-time link: --owner as on a new server, --qq for an admin.
async function signIn(page: Page, args: string[]) {
  const output = execFileSync("node", ["scripts/bootstrap.ts", ...args], {
    env: { ...process.env, ...SERVER_ENV },
    encoding: "utf8",
  });
  const link = /\/login\/link\?token=\S+/.exec(output);
  if (!link) throw new Error("bootstrap printed no link");
  await page.goto(link[0]);
  await page.getByRole("button", { name: "确认登录" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("站长设公告，管理员建版块、发帖再回复，从通知打开别人的回复", async ({ page }) => {
  await signIn(page, ["--owner"]);
  await page.goto("/admin/site");
  await page.getByLabel("公告横幅").fill("端到端测试的公告");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存，立即生效")).toBeVisible();

  await signIn(page, ["--qq", "10001"]);
  await page.goto("/admin/boards");
  const create = page.locator("form", { has: page.getByRole("button", { name: "创建" }) });
  await create.getByLabel("地址").fill("e2e");
  await create.getByLabel("名称").fill("端到端");
  await create.getByRole("button", { name: "创建" }).click();
  await expect(page.getByText("已创建")).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "发帖" }).click();
  const composer = page.getByRole("region", { name: "发帖" });
  await composer.getByRole("button", { name: "版块" }).click();
  await composer.getByRole("button", { name: "端到端" }).click();
  await page.getByLabel("标题").fill("端到端测试发的帖子");
  await page.getByLabel("正文").fill("**正文**里有加粗");
  await page.getByRole("button", { name: "发布" }).click();
  await page.waitForURL(/\/t\/\d+$/);
  await expect(page.getByRole("heading", { name: "端到端测试发的帖子" })).toBeVisible();
  await expect(page.locator("#floor-1 strong")).toHaveText("正文");
  await expect(page.getByText("端到端测试的公告")).toBeVisible();

  await page.getByRole("button", { name: "回复", exact: true }).last().click();
  await page.getByLabel("回复内容").fill("一楼说得对");
  await page.locator("footer").getByRole("button", { name: "回复" }).click();
  await expect(page.locator("#floor-2")).toContainText("一楼说得对");

  // Someone else replies; the notification opens the thread at that floor, not at the top.
  const thread = page.url();
  await signIn(page, ["--qq", "10002"]);
  await page.goto(thread);
  await page.getByRole("button", { name: "回复", exact: true }).last().click();
  await page.getByLabel("回复内容").fill("楼上说得对");
  await page.locator("footer").getByRole("button", { name: "回复" }).click();
  await expect(page.locator("#floor-3")).toContainText("楼上说得对");

  await signIn(page, ["--qq", "10001"]);
  await page.setViewportSize({ width: 390, height: 400 });
  await page.goto("/notifications");
  await page.locator('a[href$="?floor=3"]').click();
  await expect(page.locator("#floor-3")).toBeInViewport();
});
