import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login, readStream } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { unreadChanged } from "./service.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let author: { id: number; who: Who } = { id: 0, who: as("") };
let replier: Who = as("");
let threadId = 0;
let opening = 0;

beforeAll(async () => {
  const admin = as(await login((await createUser("admin")).id));
  await api.boards.$post({ json: { slug: "live", name: "实时" } }, admin);
  const user = await createUser();
  author = { id: user.id, who: as(await login(user.id)) };
  replier = as(await login((await createUser()).id));
  const res = await api.threads.$post(
    { json: { board: "live", title: "实时更新的主题", content: { markdown: "主楼" } } },
    author.who,
  );
  if (!res.ok) throw new Error(`status ${res.status}`);
  threadId = (await res.json()).id;
  const posts = await api.threads[":id"].posts.$get({ param: { id: String(threadId) }, query: {} });
  if (!posts.ok) throw new Error(`status ${posts.status}`);
  opening = (await posts.json()).items[0].id;
});

function reply() {
  return api.threads[":id"].posts.$post(
    {
      param: { id: String(threadId) },
      json: { content: { markdown: "回复" }, reply_to_id: opening },
    },
    replier,
  );
}

describe("未读数的实时更新", () => {
  test("连上就推一次，有新通知、标为已读时再推", async () => {
    const stream = await readStream("/api/v1/stream", author.who.headers);
    expect(await stream.next()).toBe("event: unread\ndata: 0\n\n");
    await reply();
    // As the LISTEN connection would on the NOTIFY.
    unreadChanged(String(author.id));
    expect(await stream.next()).toBe("event: unread\ndata: 1\n\n");
    await api.notifications.read.$post({ json: { all: true } }, author.who);
    unreadChanged(String(author.id));
    expect(await stream.next()).toBe("event: unread\ndata: 0\n\n");
    await stream.close();
  });
});
