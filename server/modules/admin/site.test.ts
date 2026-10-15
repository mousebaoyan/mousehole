import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, ownerSession } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";

const api = testClient(app).api.v1;

let admin = as("");
let owner = as("");

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  owner = await ownerSession();
});

function save(site: { banner?: string; qq_public?: boolean }) {
  return api.admin.settings.$patch({ json: { site } }, owner);
}

describe("站点设置", () => {
  test("只有站长能改，管理员不行", async () => {
    const res = await api.admin.settings.$patch({ json: { site: { banner: "" } } }, admin);
    expect(res.status).toBe(403);
  });

  test("公告横幅改了立即生效，谁都能读到", async () => {
    expect((await save({ banner: "  周六晚上停机维护一小时  " })).status).toBe(204);
    const res = await api.site.$get();
    expect(await res.json()).toEqual({ banner: "周六晚上停机维护一小时" });
  });

  test("QQ 号默认只给成员看，设为公开后访客也能看到，成员状态仍然不给", async () => {
    const user = await createUser();
    const profile = async () => {
      const res = await api.users[":user"].$get({ param: { user: String(user.id) } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return res.json();
    };
    expect(await profile()).not.toHaveProperty("qq");
    await save({ qq_public: true });
    const shown = await profile();
    expect(shown).toMatchObject({ qq: user.qq });
    expect(shown).not.toHaveProperty("member_status");
    await save({ qq_public: false });
  });

  test("改了什么记进操作日志，带改前改后的值；邮箱密码只记哪个改了", async () => {
    await save({ banner: "旧公告" });
    await save({ banner: "新公告", qq_public: false });
    const mailbox = { host: "smtp.qq.com", port: 465, secure: true, user: "a@qq.com" };
    await api.admin.settings.$patch(
      { json: { smtp: { accounts: [{ ...mailbox, password: "secret-1" }] } } },
      owner,
    );
    await api.admin.settings.$patch(
      { json: { smtp: { accounts: [{ ...mailbox, port: 587 }] } } },
      owner,
    );
    const logs = await db
      .selectFrom("audit_logs")
      .select("data")
      .where("action", "=", "settings.update")
      .orderBy("id", "desc")
      .limit(3)
      .execute();
    expect(logs.map((l) => l.data)).toEqual([
      {
        smtp: {
          accounts: { from: [mailbox], to: [{ ...mailbox, port: 587 }] },
        },
      },
      { smtp: { accounts: { from: [], to: [mailbox] }, passwords_changed: ["a@qq.com"] } },
      { site: { banner: { from: "旧公告", to: "新公告" } } },
    ]);
    expect(JSON.stringify(logs)).not.toContain("secret-1");
  });
});
