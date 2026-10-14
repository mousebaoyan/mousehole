import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";

const api = testClient(app).api.v1;

let member = as("");
const ids = { open: 0, members: 0, pending: 0 };

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  member = as(await login((await createUser()).id));
  await api.boards.$post({ json: { slug: "open", name: "公开" } }, admin);
  await api.boards.$post({ json: { slug: "inner", name: "仅成员", visibility: "members" } }, admin);
  await api.boards.$post({ json: { slug: "held", name: "先审", review_mode: "before" } }, admin);
  for (const [key, board] of [
    ["open", "open"],
    ["members", "inner"],
    ["pending", "held"],
  ] as const) {
    const res = await api.threads.$post(
      { json: { board, title: "收录测试的主题", content: { markdown: "正文" } } },
      member,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    ids[key] = (await res.json()).id;
  }
});

describe("sitemap", () => {
  test("只列访客能看的版块和主题：仅成员版块和待审核的主题不在里面", async () => {
    const xml = await (await app.request("/sitemap.xml")).text();
    expect(xml).toContain(`/t/${ids.open}<`);
    expect(xml).toContain("/b/open<");
    expect(xml).not.toContain(`/t/${ids.members}<`);
    expect(xml).not.toContain("/b/inner<");
    expect(xml).not.toContain(`/t/${ids.pending}<`);
  });
});
