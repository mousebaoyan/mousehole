import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { SERVER_ENV } from "./env.ts";

// The first admin comes in through the bootstrap command's one-time link, as on a new server.
async function signInAsAdmin(page: Page) {
  const output = execFileSync("node", ["scripts/bootstrap.ts", "--qq", "10001"], {
    env: { ...process.env, ...SERVER_ENV },
    encoding: "utf8",
  });
  const link = /\/login\/link\?token=\S+/.exec(output);
  if (!link) throw new Error("bootstrap printed no link");
  await page.goto(link[0]);
  await page.getByRole("button", { name: "确认登录" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

test("管理员登录，建版块、设公告，发主题再回复", async ({ page }) => {
  await signInAsAdmin(page);

  await page.goto("/admin/boards");
  const create = page.locator("form", { has: page.getByRole("button", { name: "创建" }) });
  await create.getByLabel("地址").fill("e2e");
  await create.getByLabel("名称").fill("端到端");
  await create.getByRole("button", { name: "创建" }).click();
  await expect(page.getByText("已创建")).toBeVisible();

  await page.goto("/admin/site");
  await page.getByLabel("公告横幅").fill("端到端测试的公告");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存，立即生效")).toBeVisible();

  await page.goto("/new");
  await page.getByLabel("版块").selectOption("e2e");
  await page.getByLabel("标题").fill("端到端测试发的主题");
  await page.getByLabel("正文").fill("**正文**里有加粗");
  await page.getByRole("button", { name: "发布" }).click();
  await page.waitForURL(/\/t\/\d+$/);
  await expect(page.getByRole("heading", { name: "端到端测试发的主题" })).toBeVisible();
  await expect(page.locator("#floor-1 strong")).toHaveText("正文");
  await expect(page.getByText("端到端测试的公告")).toBeVisible();

  await page.getByRole("button", { name: "回复", exact: true }).last().click();
  await page.getByLabel("回复内容").fill("一楼说得对");
  await page.locator("footer").getByRole("button", { name: "回复" }).click();
  await expect(page.locator("#floor-2")).toContainText("一楼说得对");
});
