import { testClient } from "hono/testing";
import { sql } from "kysely";
import { beforeAll, describe, expect, test } from "vitest";
import { as, createUser, login } from "../../../test/fixtures.ts";
import { app } from "../../app.ts";
import { db } from "../../platform/db.ts";
import { env } from "../../platform/env.ts";
import { queueMail } from "../../platform/mail.ts";

const api = testClient(app).api.v1;

let admin = as("");

beforeAll(async () => {
  admin = as(await login((await createUser("admin")).id));
});

// A mail of this kind with links to the site and elsewhere, taken off the queue as if sent: its
// log row, its signature and its HTML as it went out.
async function sent(kind: string) {
  await db.transaction().execute((trx) =>
    queueMail(trx, [
      {
        kind,
        address: "1@qq.com",
        subject: "提醒",
        body: "正文",
        html: `<html><body><a href="${env.PUBLIC_URL}/t/1?floor=2">去回复</a>
          <a href="${env.PUBLIC_URL}/settings#notify">管理邮件提醒</a>
          <a href="${env.PUBLIC_URL}/unsubscribe?u=1&amp;k=reply&amp;s=x">不再接收此类邮件</a>
          <a href="https://example.com/">别处</a></body></html>`,
      },
    ]),
  );
  const mail = await db
    .deleteFrom("mail_queue")
    .returning(["mail_id", "html"])
    .executeTakeFirstOrThrow();
  await db
    .updateTable("mail_log")
    .set({ sent_at: sql<Date>`now()` })
    .where("id", "=", mail.mail_id)
    .execute();
  const sig = /\/mail\/\d+\.gif\?s=([\w-]+)"/.exec(mail.html)?.[1] ?? "";
  return { id: mail.mail_id, sig, html: mail.html };
}

function logOf(id: number) {
  return db
    .selectFrom("mail_log")
    .select(["opened_at", "clicked_at"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

describe("邮件的打开和点击", () => {
  test("指向论坛的链接带上邮件 ID 和签名，退订和站外的不带；末尾放一张记打开的图", async () => {
    const { id, sig, html } = await sent("reply");
    const mark = `m=${id}.${sig}`;
    expect(html).toContain(`href="${env.PUBLIC_URL}/t/1?floor=2&amp;${mark}"`);
    expect(html).toContain(`href="${env.PUBLIC_URL}/settings?${mark}#notify"`);
    expect(html).toContain(`href="${env.PUBLIC_URL}/unsubscribe?u=1&amp;k=reply&amp;s=x"`);
    expect(html).toContain(`href="https://example.com/"`);
    expect(html).toMatch(new RegExp(`<img src="[^"]+/mail/${id}\\.gif\\?s=${sig}"[^>]*></body>`));
  });

  test("图第一次加载时记为打开，点链接记为点击并算打开；签名对不上的不算", async () => {
    const opened = await sent("reply");
    const clicked = await sent("weekly");

    const res = await app.request(`/mail/${opened.id}.gif?s=${opened.sig}`);
    expect(res.headers.get("content-type")).toBe("image/gif");
    const first = await logOf(opened.id);
    expect(first.opened_at).not.toBeNull();
    await app.request(`/mail/${opened.id}.gif?s=${opened.sig}`);
    expect(await logOf(opened.id)).toEqual(first);

    await app.request(`/mail/${clicked.id}.gif?s=${opened.sig}`);
    await api.mail.clicks.$post({ json: { mail: `${clicked.id}.${opened.sig}` } });
    expect(await logOf(clicked.id)).toEqual({ opened_at: null, clicked_at: null });

    const click = await api.mail.clicks.$post({ json: { mail: `${clicked.id}.${clicked.sig}` } });
    expect(click.status).toBe(204);
    const log = await logOf(clicked.id);
    expect(log.clicked_at).not.toBeNull();
    expect(log.opened_at).toEqual(log.clicked_at);
    expect(await logOf(opened.id)).toEqual(first);
  });

  test("数据页按类数这段时间发出、失败、打开和点击的；验证码和测试邮件不记打开", async () => {
    await db.deleteFrom("mail_log").execute();
    for (const kind of ["reply", "reply", "weekly"]) await sent(kind);
    const [first] = await db.selectFrom("mail_log").select("id").orderBy("id").execute();
    await db
      .updateTable("mail_log")
      .set({ opened_at: sql<Date>`now()`, clicked_at: sql<Date>`now()` })
      .where("id", "=", first.id)
      .execute();
    await db
      .insertInto("mail_log")
      .values([
        { kind: "login", sent_at: sql<Date>`now()` },
        { kind: "login", dropped_at: sql<Date>`now()` },
        { kind: "test", sent_at: sql<Date>`now()` },
        // Before the range.
        {
          kind: "reply",
          created_at: sql<Date>`now() - interval '8 days'`,
          sent_at: sql<Date>`now()`,
        },
      ])
      .execute();

    const res = await api.admin.stats.$get({ query: { range: "7" } }, admin);
    if (!res.ok) throw new Error(`status ${res.status}`);
    expect((await res.json()).mail).toEqual([
      { kind: "reply", sent: 2, dropped: 0, opened: 1, clicked: 1 },
      { kind: "login", sent: 1, dropped: 1, opened: null, clicked: null },
      { kind: "test", sent: 1, dropped: 0, opened: null, clicked: null },
      { kind: "weekly", sent: 1, dropped: 0, opened: 0, clicked: 0 },
    ]);
  });
});
