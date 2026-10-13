import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";

const api = testClient(app).api.v1;

let me = as("");

beforeAll(async () => {
  me = as(await login((await createUser()).id));
});

async function settings() {
  const res = await api.me.settings.$get({}, me);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

describe("设置", () => {
  test("默认：跟着 QQ 的名字、允许代发；站内通知都开，QQ 提醒只开回复和 @", async () => {
    expect(await settings()).toMatchObject({
      custom_name: null,
      allow_proxy: true,
      notify_prefs: {
        reply: { site: true, qq: true },
        mention: { site: true, qq: true },
        like: { site: true, qq: false },
        watching: { site: true, qq: false },
      },
    });
  });

  test("只改带了的字段；名字改了显示名跟着变；通知开关按类型整体替换", async () => {
    const res = await api.me.$patch(
      {
        json: {
          custom_name: " 夜猫子 ",
          bio: "26 届，CV 方向",
          notify_prefs: { like: { site: false, qq: true } },
        },
      },
      me,
    );
    expect(res.status).toBe(200);
    expect(await settings()).toMatchObject({
      custom_name: "夜猫子",
      bio: "26 届，CV 方向",
      allow_proxy: true,
      notify_prefs: { like: { site: false, qq: true }, reply: { site: true, qq: true } },
    });
    const profile = await api.me.$get({}, me);
    if (!profile.ok) throw new Error(`status ${profile.status}`);
    expect(await profile.json()).toMatchObject({ display_name: "夜猫子" });

    await api.me.$patch({ json: { allow_proxy: false } }, me);
    expect(await settings()).toMatchObject({ allow_proxy: false, bio: "26 届，CV 方向" });
  });

  test("简介最多 60 个字，名字最多 24 个字", async () => {
    expect((await api.me.$patch({ json: { bio: "字".repeat(61) } }, me)).status).toBe(400);
    expect((await api.me.$patch({ json: { custom_name: "名".repeat(25) } }, me)).status).toBe(400);
  });
});
