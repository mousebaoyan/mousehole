import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { as, createUser, login, nextQq, sessionCookie } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { sendMail } from "../../platform/mail.ts";
import { getSettings } from "../../platform/settings.ts";

vi.mock("../../platform/mail.ts", () => ({ sendMail: vi.fn() }));

const api = testClient(app).api.v1;

let lastIp = 0;

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.admin.settings.$patch({ json: { smtp: { host: "smtp.qq.com" } } }, admin);
});

// Each request from its own address, so the per-IP limit stays out of the way.
function fromNewIp() {
  return { headers: { "x-real-ip": `10.0.${Math.floor(++lastIp / 250)}.${lastIp % 250}` } };
}

async function requestCode(qq: number) {
  return api.auth.email.$post({ json: { qq } }, fromNewIp());
}

function mailedCode() {
  const subject = vi.mocked(sendMail).mock.lastCall?.[1] ?? "";
  return /\d{6}/.exec(subject)?.[0] ?? "";
}

function verify(qq: number, code: string) {
  return api.auth.email.verify.$post({ json: { qq, code } }, fromNewIp());
}

describe("QQ 邮箱验证码", () => {
  test("同步过的 QQ 号收到验证码，用它登录", async () => {
    const { qq } = await createUser();
    expect((await requestCode(qq)).status).toBe(204);
    expect(vi.mocked(sendMail).mock.lastCall?.[0]).toBe(`${qq}@qq.com`);

    const res = await verify(qq, mailedCode());
    expect(res.status).toBe(204);
    expect(sessionCookie(res)).toBeDefined();
    // Spent once used.
    expect((await verify(qq, mailedCode())).status).toBe(400);
  });

  test("没同步过的 QQ 号收不到", async () => {
    vi.mocked(sendMail).mockClear();
    const res = await requestCode(nextQq());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "not_member" } });
    expect(sendMail).not.toHaveBeenCalled();
  });

  test("同一个 QQ 号 60 秒内只能发一次", async () => {
    const { qq } = await createUser();
    expect((await requestCode(qq)).status).toBe(204);
    const again = await requestCode(qq);
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("retry-after"))).toBeGreaterThan(50);
  });

  test("输错 5 次作废，之后正确的也不行", async () => {
    const { qq } = await createUser();
    await requestCode(qq);
    const code = mailedCode();
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) expect((await verify(qq, wrong)).status).toBe(400);
    expect((await verify(qq, code)).status).toBe(400);
  });

  test("过期的验证码不能用", async () => {
    const { id, qq } = await createUser();
    await requestCode(qq);
    await db
      .updateTable("email_codes")
      .set({ expires_at: sql`now() - interval '1 second'` })
      .where("user_id", "=", id)
      .execute();
    expect((await verify(qq, mailedCode())).status).toBe(400);
  });

  test("封禁的账号不能登录", async () => {
    const { id, qq } = await createUser();
    await requestCode(qq);
    await db.updateTable("users").set({ restriction: "ban" }).where("id", "=", id).execute();

    const res = await verify(qq, mailedCode());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "banned" } });
  });
});

describe("站点设置", () => {
  test("关掉邮箱登录后，申请验证码返回 403", async () => {
    const admin = as(await login((await createUser("admin")).id));
    const { qq } = await createUser();

    const off = await api.admin.settings.$patch({ json: { login: { email: false } } }, admin);
    expect(off.status).toBe(204);
    expect(await (await api.auth.methods.$get()).json()).toMatchObject({
      email: false,
      code: true,
    });
    const res = await requestCode(qq);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "login_method_disabled" } });

    await api.admin.settings.$patch({ json: { login: { email: true } } }, admin);
  });

  test("SMTP 密码加密存储，接口只说是否已设置，不传就不变", async () => {
    const admin = as(await login((await createUser("admin")).id));
    const password = "smtp-auth-code-123";
    await api.admin.settings.$patch({ json: { smtp: { host: "smtp.qq.com", password } } }, admin);
    await api.admin.settings.$patch({ json: { smtp: { user: "bot@qq.com" } } }, admin);

    const res = await api.admin.settings.$get({}, admin);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const { smtp } = await res.json();
    expect(smtp).toMatchObject({ host: "smtp.qq.com", user: "bot@qq.com", password_set: true });
    expect(JSON.stringify(smtp)).not.toContain(password);

    const row = await db
      .selectFrom("settings")
      .select("value")
      .where("key", "=", "smtp")
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row.value)).not.toContain(password);
    // Decrypted for sending.
    expect((await getSettings()).smtp.password).toBe(password);
  });
});
