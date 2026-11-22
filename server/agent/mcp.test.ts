import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { as, createUser, login, nextQq, ownerSession } from "../../test/fixtures.ts";
import { app } from "../app.ts";
import { db } from "../platform/db.ts";
import { env } from "../platform/env.ts";
import { agentApp } from "./routes.ts";

const api = testClient(app).api.v1;

type Who = { headers: Record<string, string> };

let thread: number;

async function person(level: number) {
  const { id } = await createUser("user", level);
  return { id, who: as(await login(id)) };
}

async function tokenOf(who: Who, scopes: ["read"] | ["read", "act"] = ["read", "act"]) {
  const res = await api.me.tokens.$post({ json: { name: "Codex", scopes } }, who);
  if (res.status !== 201) throw new Error(`status ${res.status}`);
  return (await res.json()).token;
}

// One message as Agents send it today: the 2025 protocol, a request each.
function rpc(token: string | null, method: string, params: object = {}) {
  return agentApp.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

const ToolResult = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
  }),
});

async function call(token: string, name: string, args: object) {
  const res = await rpc(token, "tools/call", { name, arguments: args });
  const { result } = ToolResult.parse(await res.json());
  return { error: result.isError === true, text: result.content[0].text };
}

let admin: Who;

async function newThread(title: string) {
  const res = await api.threads.$post(
    { json: { board: "agents", title, content: { markdown: "主楼" } } },
    admin,
  );
  if (res.status !== 201) throw new Error(`status ${res.status}`);
  return (await res.json()).id;
}

beforeAll(async () => {
  admin = as(await login((await createUser("admin", 0)).id));
  await api.boards.$post({ json: { slug: "agents", name: "Agent" } }, admin);
  thread = await newThread("要回复的帖子");
});

describe("MCP", () => {
  test("没有令牌、只能取资料的令牌和 bot 的令牌连不上，告诉 Agent 怎么授权", async () => {
    const none = await rpc(null, "tools/list");
    expect(none.status).toBe(401);
    const header = none.headers.get("www-authenticate") ?? "";
    expect(header).toMatch(
      /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/mcp", scope="read act"$/,
    );
    const metadata = await agentApp.request(new URL(header.split('"')[1]).pathname);
    expect(await metadata.json()).toMatchObject({
      resource: `${env.PUBLIC_URL}/mcp`,
      authorization_servers: [env.PUBLIC_URL],
    });

    // As an app that signs people in with the forum holds.
    const holder = await person(3);
    const token = await tokenOf(holder.who, ["read"]);
    await db
      .updateTable("api_tokens")
      .set({ scopes: ["profile"] })
      .where("user_id", "=", holder.id)
      .execute();
    const profile = await rpc(token, "tools/list");
    expect(profile.status).toBe(403);
    expect(profile.headers.get("www-authenticate")).toContain('error="insufficient_scope"');

    const owner = await ownerSession();
    const bot = await api.admin.tokens.$post(
      { json: { name: "插件", bot_qq: nextQq(), scopes: ["read", "act"] } },
      owner,
    );
    if (!bot.ok) throw new Error(`status ${bot.status}`);
    expect((await rpc((await bot.json()).token, "tools/list")).status).toBe(403);
  });

  test("工具带着接口的参数说明，以本人的身份调接口，发的楼层标为 Agent", async () => {
    const me = await person(3);
    const token = await tokenOf(me.who);

    const list = await rpc(token, "tools/list");
    const { tools } = z
      .object({
        result: z.object({
          tools: z.array(
            z.object({
              name: z.string(),
              inputSchema: z.object({
                properties: z.record(z.string(), z.object({ description: z.string().optional() })),
              }),
            }),
          ),
        }),
      })
      .parse(await list.json()).result;
    const search = tools.find((t) => t.name === "search");
    expect(search?.inputSchema.properties.since.description).toBeTruthy();

    const reply = await call(token, "reply", { id: thread, content: { markdown: "Agent 的回复" } });
    expect(reply.error).toBe(false);
    expect(JSON.parse(reply.text)).toMatchObject({ author: { id: me.id }, via: "agent" });
    expect(reply.text).not.toContain('"html"');

    const read = await call(token, "read_posts", { id: thread, after: 1 });
    const posts: unknown = JSON.parse(read.text);
    expect(posts).toMatchObject({ items: [{ body: "Agent 的回复", via: "agent" }] });
    expect(read.text).not.toContain("avatar_url");
  });

  test("接口的错误作为工具的错误返回：等级不够，令牌不能发帖时说怎么重新授权", async () => {
    const low = await call(await tokenOf((await person(2)).who), "reply", {
      id: thread,
      content: { markdown: "L2 的回复" },
    });
    expect(low.error).toBe(true);
    expect(low.text).toContain("L3");

    const readOnly = await call(await tokenOf((await person(3)).who, ["read"]), "reply", {
      id: thread,
      content: { markdown: "只读令牌的回复" },
    });
    expect(readOnly.error).toBe(true);
    expect(readOnly.text).toContain("codex mcp login mousehole");
  });

  test("帖子已合并时，错误带上主楼现在在哪", async () => {
    const kept = await newThread("留下的帖子");
    const gone = await newThread("合并掉的帖子");
    const merged = await api.threads[":id"].merge.$post(
      { param: { id: String(gone) }, json: { into: kept } },
      admin,
    );
    expect(merged.ok).toBe(true);
    const res = await call(await tokenOf((await person(3)).who, ["read"]), "get_thread", {
      id: gone,
    });
    expect(res.error).toBe(true);
    expect(res.text).toContain(`"thread_id":${kept}`);
  });

  test("2025 和 2026 版的协议都回 JSON，GET 不接受", async () => {
    const token = await tokenOf((await person(3)).who, ["read"]);
    const legacy = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(legacy.headers.get("content-type")).toBe("application/json");
    expect(await legacy.json()).toMatchObject({ result: { serverInfo: { name: "mousehole" } } });

    const modern = await agentApp.request("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(modern.headers.get("content-type")).toBe("application/json");
    expect(await modern.json()).toMatchObject({ result: { supportedVersions: ["2026-07-28"] } });

    expect((await agentApp.request("/mcp")).status).toBe(405);
  });
});
