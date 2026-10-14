import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";

const api = testClient(app).api.v1;

let admin = as("");

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
});

function save(site: { banner?: string; qq_public?: boolean; review_mode?: "after" | "before" }) {
  return api.admin.settings.$patch({ json: { site } }, admin);
}

describe("站点设置", () => {
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

  test("新建版块不指定审核方式时用站点的默认值", async () => {
    await save({ review_mode: "before" });
    const res = await api.boards.$post({ json: { slug: "held", name: "先审" } }, admin);
    expect(await res.json()).toMatchObject({ review_mode: "before" });
    await save({ review_mode: "after" });
  });
});
