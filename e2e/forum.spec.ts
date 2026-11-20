import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { BASE, SERVER_ENV } from "./env.ts";

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

test("站长设公告，管理员建版块、发帖再回复，从通知打开别人的回复，读完回到列表", async ({
  page,
}) => {
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

  // Read there, then straight back by the sidebar: the list already knows.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(2500);
  await page.getByRole("link", { name: "全部帖子" }).click();
  const row = page.getByRole("link", { name: /端到端测试发的帖子/ });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText("层没读过");
});

test("成员翻过的列表，退出后后退，访客看不到只对成员开放的帖子", async ({ page }) => {
  // More questions than a page holds in a board only members read, and one anyone reads.
  const db = new Client({ connectionString: SERVER_ENV.DATABASE_URL });
  await db.connect();
  await db.query(`
    WITH author AS (INSERT INTO users (qq, display_name) VALUES (20001, '提问的人') RETURNING id),
      added AS (
        INSERT INTO boards (slug, name, visibility)
        VALUES ('inner', '内部', 'members'), ('open', '公开', 'public') RETURNING id, slug)
    INSERT INTO threads (board_id, author_id, title, last_poster_id, kind, created_at, last_post_at)
    SELECT added.id, author.id, title, author.id, 'question', at, at
    FROM author, added, LATERAL (
      SELECT '内部的提问 ' || i, now() - i * interval '1 minute' FROM generate_series(1, 31) i
      WHERE added.slug = 'inner'
      UNION ALL SELECT '公开的提问', now() - interval '1 hour' WHERE added.slug = 'open'
    ) asked (title, at)`);
  await db.query(`
    INSERT INTO posts (thread_id, floor, author_id, body, html, created_at)
    SELECT id, 1, author_id, '怎么办', '<p>怎么办</p>', created_at FROM threads
    WHERE title LIKE '%的提问%'`);
  await db.end();

  await signIn(page, ["--qq", "10003"]);
  await page.goto("/?view=unsolved");
  await page.getByRole("link", { name: "加载更多" }).scrollIntoViewIfNeeded();
  await expect(page.getByRole("link", { name: /内部的提问/ })).toHaveCount(31);
  await page.getByRole("button", { name: "我的账号" }).click();
  await page.getByRole("button", { name: "退出" }).click();
  await page.waitForURL((url) => url.pathname === "/" && url.search === "");
  await page.goBack();
  await expect(page.getByRole("link", { name: "待解答" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: /公开的提问/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /内部的提问/ })).toHaveCount(0);
});

test("站长登记鼠钟；登录了的打开授权页直接带着授权码回到鼠钟，没登录的带着 login_required 回去", async ({
  page,
  browser,
}) => {
  // Somewhere the browser can land: Playwright doesn't intercept the request a redirect leads to.
  const callback = `${BASE}/healthz`;
  await signIn(page, ["--owner"]);
  await page.goto("/admin/apps");
  await page.getByLabel("名称").fill("鼠钟");
  await page.getByLabel("回调地址").fill(callback);
  await page.getByRole("button", { name: "登记", exact: true }).click();
  const clientId = await page.locator("output dd").first().textContent();
  if (!clientId) throw new Error("no client_id shown");

  const authorize = (extra: Record<string, string> = {}) =>
    `/oauth/authorize?${new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback,
      state: "e2e",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      ...extra,
    })}`;
  const back = (url: URL) => url.href.startsWith(callback);

  await page.goto(authorize());
  await page.waitForURL(back);
  const signedIn = new URL(page.url()).searchParams;
  expect(signedIn.get("code")).toBeTruthy();
  expect(signedIn.get("state")).toBe("e2e");

  const guest = await browser.newPage();
  await guest.goto(authorize({ prompt: "none" }));
  await guest.waitForURL(back);
  expect(new URL(guest.url()).searchParams.get("error")).toBe("login_required");
  await guest.goto(authorize());
  await guest.waitForURL((url) => url.pathname === "/login");
  expect(new URL(guest.url()).searchParams.get("next")).toMatch(/^\/oauth\/authorize\?/);
});
