import { sql } from "kysely";
import { afterEach, describe, expect, test, vi } from "vitest";
import { db } from "./db.ts";
import { queueMail, sendMail, sendQueued, testMailboxes } from "./mail.ts";
import { saveSettings } from "./settings.ts";

// Which mailboxes tried to send, what went out, and what each one fails with, by address.
const smtp = vi.hoisted(() => {
  const tries: string[] = [];
  const sent: string[] = [];
  return { tries, sent, failures: new Map<string, Error>() };
});

vi.mock("nodemailer", () => ({
  createTransport: ({ auth }: { auth: { user: string } }) => ({
    sendMail: async ({ to }: { to: string }) => {
      smtp.tries.push(auth.user);
      const failure = smtp.failures.get(auth.user);
      if (failure) throw failure;
      smtp.sent.push(`${auth.user} → ${to}`);
    },
  }),
}));

// Queued mails go a second or two apart; not here.
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

// As nodemailer reports them.
const loginFailed = () =>
  Object.assign(new Error("Invalid login: 535 Login fail"), { code: "EAUTH", command: "AUTH" });
const refused = () =>
  Object.assign(
    new Error("Can't send mail - all recipients were rejected: 550 Mailbox not found"),
    {
      code: "EENVELOPE",
      command: "RCPT TO",
      responseCode: 550,
    },
  );

// Fresh addresses each test: a mailbox that failed keeps resting across tests.
async function mailboxes(...users: string[]) {
  const accounts = users.map((user) => ({
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    user,
    password: "code",
  }));
  await db.transaction().execute((trx) => saveSettings(trx, { smtp: { accounts } }));
  smtp.tries.length = 0;
  smtp.sent.length = 0;
}

async function queue(...addresses: string[]) {
  await db.transaction().execute((trx) =>
    queueMail(
      trx,
      addresses.map((address) => ({ address, subject: "提醒", body: "正文", html: "<p>正文</p>" })),
    ),
  );
}

describe("发信", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("一个邮箱发不出去就换下一个，它歇着的时候不再试它", async () => {
    await mailboxes("a@qq.com", "b@qq.com");
    smtp.failures.set("a@qq.com", loginFailed());
    await sendMail("1@qq.com", "验证码", "123456", "<p>123456</p>");
    await sendMail("2@qq.com", "验证码", "654321", "<p>654321</p>");
    expect(smtp.tries).toEqual(["a@qq.com", "b@qq.com", "b@qq.com"]);
    expect(smtp.sent).toEqual(["b@qq.com → 1@qq.com", "b@qq.com → 2@qq.com"]);
  });

  test("哪个邮箱都发不出去时报错", async () => {
    await mailboxes("c@qq.com");
    smtp.failures.set("c@qq.com", loginFailed());
    await expect(sendMail("1@qq.com", "验证码", "123456", "<p>123456</p>")).rejects.toMatchObject({
      code: "email_failed",
    });
  });

  test("待发的邮件按顺序发，发出去的删掉；放了一天还没发出去的不再发", async () => {
    await mailboxes("d@qq.com");
    await queue("1@qq.com", "2@qq.com");
    await db
      .insertInto("mail_queue")
      .values({
        address: "old@qq.com",
        subject: "提醒",
        body: "正文",
        html: "<p>正文</p>",
        created_at: sql<Date>`now() - interval '25 hours'`,
      })
      .execute();
    await sendQueued();
    expect(smtp.sent).toEqual(["d@qq.com → 1@qq.com", "d@qq.com → 2@qq.com"]);
    expect(await db.selectFrom("mail_queue").select("id").execute()).toEqual([]);
  });

  test("每个邮箱都拒收的地址丢掉；邮箱都歇着时邮件留着，等它们能发了再发", async () => {
    await mailboxes("e@qq.com", "f@qq.com");
    smtp.failures.set("e@qq.com", refused());
    smtp.failures.set("f@qq.com", refused());
    await queue("gone@qq.com", "1@qq.com");
    await sendQueued();
    const left = await db.selectFrom("mail_queue").select("address").execute();
    expect(left).toEqual([{ address: "1@qq.com" }]);

    smtp.failures.clear();
    // A test that goes through ends the rest.
    expect(await testMailboxes("admin@qq.com")).toEqual([
      { user: "e@qq.com", error: null },
      { user: "f@qq.com", error: null },
    ]);
    await sendQueued();
    expect(smtp.sent.at(-1)).toBe("e@qq.com → 1@qq.com");
    expect(await db.selectFrom("mail_queue").select("id").execute()).toEqual([]);
  });

  test("邮箱接连出错，每次歇得比上次久一倍，发出去以后从头算", async () => {
    await mailboxes("g@qq.com");
    smtp.failures.set("g@qq.com", loginFailed());
    const start = Date.now();
    const at = async (minutes: number) => {
      vi.spyOn(Date, "now").mockReturnValue(start + minutes * 60_000);
      await sendMail("1@qq.com", "验证码", "123456", "<p>123456</p>").catch(() => {});
      return smtp.tries.splice(0).length;
    };
    // Rests 10 minutes, then 20, then 40.
    expect([await at(0), await at(9), await at(11), await at(30), await at(32)]).toEqual([
      1, 0, 1, 0, 1,
    ]);
    smtp.failures.clear();
    expect(await at(73)).toBe(1);
    smtp.failures.set("g@qq.com", loginFailed());
    expect([await at(74), await at(83), await at(85)]).toEqual([1, 0, 1]);
  });

  test("一封邮件发不出去，隔 5、10、20、40 分钟再试，第 5 次还不行就丢掉", async () => {
    await mailboxes("h@qq.com");
    await queue("1@qq.com");
    const waits = [];
    for (let i = 0; i < 5; i += 1) {
      // A test mail that goes through ends the mailbox's rest, so the mail can be tried again.
      smtp.failures.clear();
      await testMailboxes("admin@qq.com");
      smtp.failures.set("h@qq.com", loginFailed());
      await sendQueued();
      const mail = await db
        .selectFrom("mail_queue")
        .select(sql<number>`round(extract(epoch from next_at - now()) / 60)::int`.as("wait"))
        .executeTakeFirst();
      waits.push(mail?.wait);
      await db
        .updateTable("mail_queue")
        .set({ next_at: sql<Date>`now()` })
        .execute();
    }
    expect(waits).toEqual([5, 10, 20, 40, undefined]);
  });
});
