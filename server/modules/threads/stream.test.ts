import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, readStream } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { eventsArrived } from "../events/service.ts";

const api = testClient(app).api.v1;

let member = as("");
let threadId = 0;

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "live", name: "实时" } }, admin);
  member = as(await login((await createUser()).id));
  const res = await api.threads.$post(
    { json: { board: "live", title: "实时更新的主题", content: { markdown: "主楼" } } },
    member,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  threadId = (await res.json()).id;
});

describe("主题的实时更新", () => {
  test("新楼层推给正在看这个主题的人，访客也有；别的主题的不推", async () => {
    // Where the listeners start, as at start-up; then what the LISTEN connection does on a NOTIFY.
    eventsArrived();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stream = await readStream(`/api/v1/threads/${threadId}/stream`, {});
    await api.threads.$post(
      { json: { board: "live", title: "别的主题", content: { markdown: "主楼" } } },
      member,
    );
    const res = await api.threads[":id"].posts.$post(
      { param: { id: String(threadId) }, json: { content: { markdown: "新的一楼" } } },
      member,
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    eventsArrived();
    expect(await stream.next()).toBe("event: post.created\ndata: 2\n\n");
    await stream.close();
  });
});
