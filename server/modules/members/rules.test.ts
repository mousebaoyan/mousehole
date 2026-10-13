import { describe, expect, test } from "vitest";
import { deriveAccount, mergeRecord, type Account, type Membership } from "./rules.ts";

const account: Account = {
  qq: 123456,
  role: "user",
  role_locked: false,
  custom_name: null,
  qq_nickname: "昵称",
  display_name: "旧名字",
  level: null,
  member_status: "member",
};

function group(change: Partial<Membership>): Membership {
  return {
    card: "",
    role: "member",
    level: null,
    left_at: null,
    enabled: true,
    is_primary: false,
    ...change,
  };
}

describe("合并成员记录", () => {
  test("没带的字段保持原值，最后发言时间按小时取整", () => {
    const first = mergeRecord(
      undefined,
      { user_id: 1, card: "名片", level: 5 },
      new Date(1000),
      true,
    );
    expect(first.change).toBe("joined");

    const observed = new Date(2000);
    const lastSent = Date.UTC(2026, 9, 13, 8, 47) / 1000;
    const next = mergeRecord(first.row, { user_id: 1, last_sent_time: lastSent }, observed, true);
    expect(next.change).toBe("updated");
    expect(next.row).toMatchObject({ card: "名片", level: 5, observed_at: observed });
    expect(next.row.last_sent_at).toEqual(new Date(Date.UTC(2026, 9, 13, 8)));

    // Another message in the same hour is not a change.
    const again = mergeRecord(
      next.row,
      { user_id: 1, last_sent_time: lastSent + 60 },
      observed,
      true,
    );
    expect(again.change).toBe("unchanged");
  });
});

describe("由群记录推导账号", () => {
  test("主群的群名片和等级优先；不在主群时取等级最高的群", () => {
    const groups = [
      group({ card: "主群名片", level: 3, is_primary: true }),
      group({ card: "二群名片", level: 9 }),
      group({ card: "三群名片", level: 6 }),
    ];
    expect(deriveAccount(account, groups, undefined)).toMatchObject({
      display_name: "主群名片",
      level: 3,
    });
    const noPrimary = groups.slice(1);
    expect(deriveAccount(account, noPrimary, undefined)).toMatchObject({
      display_name: "二群名片",
      level: 9,
    });
  });

  test("没有群名片时用 QQ 昵称，自己设置的名字优先", () => {
    expect(deriveAccount(account, [group({})], undefined).display_name).toBe("昵称");
    const named = { ...account, custom_name: "自己起的名" };
    expect(deriveAccount(named, [group({ card: "名片" })], undefined).display_name).toBe(
      "自己起的名",
    );
  });

  test("群主是管理员、群管理员是版主，取所在群里最高的", () => {
    expect(deriveAccount(account, [group({ role: "admin" })], undefined).role).toBe("moderator");
    const both = [group({ role: "admin" }), group({ role: "owner" })];
    expect(deriveAccount(account, both, undefined).role).toBe("admin");
  });

  test("不在任何启用的群里就冻结，角色变回普通用户，名字和等级保留", () => {
    const moderator = { ...account, role: "moderator", level: 7 };
    const gone = [
      group({ role: "admin", left_at: new Date() }),
      group({ role: "admin", enabled: false }),
    ];
    expect(deriveAccount(moderator, gone, undefined)).toEqual({
      member_status: "frozen",
      role: "user",
      level: 7,
      display_name: "旧名字",
    });
  });

  test("锁定的角色不跟随群角色，QQ 机器人是 bot", () => {
    const locked = { ...account, role: "admin", role_locked: true };
    expect(deriveAccount(locked, [group({})], undefined).role).toBe("admin");
    expect(deriveAccount(account, [group({ role: "admin" })], true).role).toBe("bot");
    const knownBot = { ...account, role: "bot" };
    expect(deriveAccount(knownBot, [group({})], undefined).role).toBe("bot");
  });

  test("没有任何群记录的账号保持原样", () => {
    const admin = { ...account, role: "admin", role_locked: true, member_status: "member" };
    expect(deriveAccount(admin, [], undefined)).toMatchObject({
      member_status: "member",
      role: "admin",
    });
  });
});
