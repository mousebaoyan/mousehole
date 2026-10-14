import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";

const api = testClient(app).api.v1;

let admin = as("");
let member = as("");

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
  member = as(await login((await createUser()).id));
  await api.boards.$post({ json: { slug: "a", name: "日志" } }, admin);
});

describe("操作日志", () => {
  test("成员自己发的帖子也记下，带 IP、User-Agent 和标题；管理员能按 IP 查，别人看不了", async () => {
    const from = {
      headers: {
        ...member.headers,
        "x-real-ip": "203.0.113.7",
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 QQ/9.1",
      },
    };
    const posted = await api.threads.$post(
      { json: { board: "a", title: "留个记录的帖子", content: { markdown: "正文" } } },
      from,
    );
    expect(posted.status).toBe(201);

    const res = await api.admin["audit-logs"].$get({ query: { ip: "203.0.113.7" } }, admin);
    if (!res.ok) throw new Error(`status ${res.status}`);
    expect((await res.json()).items).toMatchObject([
      {
        action: "thread.create",
        ip: "203.0.113.7",
        device: "手机 QQ · iOS",
        data: { title: "留个记录的帖子", board: "a", text: "正文" },
      },
    ]);

    const refused = await api.admin["audit-logs"].$get({ query: {} }, member);
    expect(refused.status).toBe(403);
  });
});
