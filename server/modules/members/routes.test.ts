import type { InferRequestType } from "hono/client";
import { testClient } from "hono/testing";
import { beforeAll, describe, expect, test } from "vitest";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { createBotToken } from "../auth/service.ts";

const api = testClient(app).api.v1;

type Members = InferRequestType<
  (typeof api.bot.groups)[":group_id"]["members"]["$put"]
>["json"]["members"];

// Pushes carry the time the plugin read the data, which must not be in the future.
const T = Math.floor(Date.now() / 1000) - 3600;

let auth = { headers: {} };
let lastQq = 40000;
let lastGroup = 900000;

beforeAll(async () => {
  const { id } = await db
    .insertInto("users")
    .values({ qq: ++lastQq, display_name: "管理员", role: "admin" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const actor = { userId: id, operatorId: null, tokenId: null, ip: null };
  const { token } = await createBotToken(actor, {
    name: "插件",
    botQq: ++lastQq,
    scopes: ["sync", "admin"],
  });
  auth = { headers: { authorization: `Bearer ${token}` } };
});

async function newGroup() {
  const groupId = ++lastGroup;
  expect((await api.admin.groups.$post({ json: { group_id: groupId } }, auth)).status).toBe(204);
  return groupId;
}

async function sync(full: boolean, groupId: number, observedAt: number, members: Members) {
  const args = { param: { group_id: String(groupId) }, json: { observed_at: observedAt, members } };
  const group = api.bot.groups[":group_id"].members;
  const res = full ? await group.$put(args, auth) : await group.$patch(args, auth);
  if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`);
  return res.json();
}

function account(qq: number) {
  return db
    .selectFrom("users")
    .select(["id", "role", "member_status", "display_name", "level"])
    .where("qq", "=", qq)
    .executeTakeFirstOrThrow();
}

function patchGroup(groupId: number, json: { enabled?: boolean; is_primary?: true }) {
  return api.admin.groups[":group_id"].$patch({ param: { group_id: String(groupId) }, json }, auth);
}

function people(count: number) {
  return Array.from({ length: count }, () => ({ user_id: ++lastQq }));
}

describe("成员同步", () => {
  test("全量同步为新成员建号：群主是管理员，群管理员是版主，显示名取群名片", async () => {
    const groupId = await newGroup();
    const [owner, admin, member] = [++lastQq, ++lastQq, ++lastQq];

    const counts = await sync(true, groupId, T, [
      { user_id: owner, role: "owner", card: "群主" },
      { user_id: admin, role: "admin", nickname: "管理昵称" },
      { user_id: member, card: "26-某大学", level: 12 },
    ]);

    expect(counts).toMatchObject({ joined: 3, left: 0, held: false });
    expect(await account(owner)).toMatchObject({ role: "admin", display_name: "群主" });
    expect(await account(admin)).toMatchObject({ role: "moderator", display_name: "管理昵称" });
    expect(await account(member)).toMatchObject({
      role: "user",
      member_status: "member",
      display_name: "26-某大学",
      level: 12,
    });
  });

  test("退群后冻结，重新进群恢复，都写入审计日志", async () => {
    const groupId = await newGroup();
    const qq = ++lastQq;
    await sync(true, groupId, T, [{ user_id: qq, role: "admin" }]);

    const left = await sync(false, groupId, T + 10, [
      { user_id: qq, in_group: false, left_reason: "kick" },
    ]);
    expect(left).toMatchObject({ left: 1 });
    expect(await account(qq)).toMatchObject({ member_status: "frozen", role: "user" });

    await sync(false, groupId, T + 20, [{ user_id: qq, in_group: true, role: "admin" }]);
    const restored = await account(qq);
    expect(restored).toMatchObject({ member_status: "member", role: "moderator" });

    const actions = await db
      .selectFrom("audit_logs")
      .select("action")
      .where("target_type", "=", "user")
      .where("target_id", "=", restored.id)
      .orderBy("id")
      .execute();
    expect(actions.map((a) => a.action)).toEqual([
      "member.role",
      "member.freeze",
      "member.role",
      "member.restore",
      "member.role",
    ]);
  });

  test("比已有数据旧的推送被忽略，到达顺序乱了也没关系", async () => {
    const groupId = await newGroup();
    const qq = ++lastQq;
    await sync(false, groupId, T + 20, [{ user_id: qq, in_group: false, left_reason: "leave" }]);

    const late = await sync(false, groupId, T + 10, [{ user_id: qq, in_group: true }]);
    expect(late).toMatchObject({ stale: 1, joined: 0 });
    expect(await account(qq)).toMatchObject({ member_status: "frozen" });
  });

  test("早于最近一次全量的增量被忽略：全量已经反映了那之前的变化", async () => {
    const groupId = await newGroup();
    const qq = ++lastQq;
    await sync(true, groupId, T, [{ user_id: qq }]);
    await sync(true, groupId, T + 30, [{ user_id: qq }]);

    const late = await sync(false, groupId, T + 20, [{ user_id: qq, in_group: false }]);
    expect(late).toMatchObject({ stale: 1, left: 0 });
    expect(await account(qq)).toMatchObject({ member_status: "member" });
  });

  test("一次全量少了超过 20% 的人先拦下，下一次全量仍然这样才标记退群", async () => {
    const groupId = await newGroup();
    const everyone = people(10);
    await sync(true, groupId, T, everyone);

    const kept = everyone.slice(0, 7);
    const dropped = everyone[9].user_id;
    expect(await sync(true, groupId, T + 10, kept)).toMatchObject({ held: true, left: 0 });
    expect(await account(dropped)).toMatchObject({ member_status: "member" });

    expect(await sync(true, groupId, T + 20, kept)).toMatchObject({ held: false, left: 3 });
    expect(await account(dropped)).toMatchObject({ member_status: "frozen" });
  });

  test("没有变化的成员不写数据库", async () => {
    const groupId = await newGroup();
    const everyone = people(5).map((p) => ({ ...p, card: "名片" }));
    await sync(true, groupId, T, everyone);

    expect(await sync(true, groupId, T + 10, everyone)).toMatchObject({ unchanged: 5, updated: 0 });
    const rows = await db
      .selectFrom("group_members")
      .select("observed_at")
      .where("group_id", "=", groupId)
      .execute();
    expect(rows.every((r) => r.observed_at.getTime() === T * 1000)).toBe(true);
  });

  test("停用群后只在这个群里的人被冻结；换主群后显示名跟着变", async () => {
    const primary = await newGroup();
    const second = await newGroup();
    const [both, onlyPrimary] = [++lastQq, ++lastQq];
    await sync(true, primary, T, [{ user_id: both, card: "主群名片" }, { user_id: onlyPrimary }]);
    await sync(true, second, T, [{ user_id: both, card: "二群名片" }]);
    expect(await account(both)).toMatchObject({ display_name: "主群名片" });

    expect((await patchGroup(second, { is_primary: true })).status).toBe(204);
    expect(await account(both)).toMatchObject({ display_name: "二群名片" });

    expect((await patchGroup(primary, { enabled: false })).status).toBe(204);
    expect(await account(onlyPrimary)).toMatchObject({ member_status: "frozen" });
    expect(await account(both)).toMatchObject({ member_status: "member" });
  });

  test("QQ 机器人同步为 bot 角色", async () => {
    const groupId = await newGroup();
    const qq = ++lastQq;
    await sync(true, groupId, T, [{ user_id: qq, role: "admin", is_robot: true }]);
    expect(await account(qq)).toMatchObject({ role: "bot" });
  });

  test("没有关联的群返回 404", async () => {
    const res = await api.bot.groups[":group_id"].members.$patch(
      { param: { group_id: "1" }, json: { observed_at: T, members: [] } },
      auth,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "group_not_linked" } });
  });
});
