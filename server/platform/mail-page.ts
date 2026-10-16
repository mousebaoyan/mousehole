import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { env } from "./env.ts";
import { SITE_NAME } from "./site.ts";

// How every email looks (design §8.6): a paper card on a cream page, in the site's colours
// (app.css). Tables and inline styles only, the one thing mail apps agree on; no images, which QQ
// Mail hides from senders it doesn't know. hono/html escapes what goes in: names, titles and
// floors are written by members.

export const INK = "#1f2a28";
export const MUTED = "#686d66";
export const TEAL = "#2b7a6b";
export const LINE = "#ebe6dd";
export const SERIF = `"Songti SC", "STSong", "Noto Serif SC", serif`;
const PAPER = "#fefdfb";
const CREAM = "#f3efe8";
const SUN = "#ef9f70";
const SANS = `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;

type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

// preview is what inboxes show after the subject; the footer goes under the card in small print.
export async function mailPage(preview: string, card: Html | string, footer?: Html | string) {
  const page = await html`<!doctype html>
    <html lang="zh-CN">
      <body style="margin:0;">
        <div style="display:none;max-height:0;overflow:hidden;">${preview}</div>
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="background:${CREAM};font-family:${SANS};"
        >
          <tr>
            <td style="padding:24px 12px;">
              <table
                role="presentation"
                width="100%"
                cellpadding="0"
                cellspacing="0"
                style="max-width:560px;margin:0 auto;background:${PAPER};border:1px solid ${LINE};border-radius:16px;"
              >
                <tr>
                  <td style="padding:24px 28px 0;font-size:13px;color:${MUTED};letter-spacing:2px;">
                    <span style="color:${SUN};">●</span> ${SITE_NAME}
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 28px 28px;font-size:15px;line-height:1.8;color:${INK};">
                    ${card}
                  </td>
                </tr>
              </table>
              ${
                footer
                  ? html`<p
                      style="max-width:560px;margin:12px auto 0;font-size:12px;line-height:1.8;color:${MUTED};text-align:center;"
                    >
                      ${footer}
                    </p>`
                  : ""
              }
            </td>
          </tr>
        </table>
      </body>
    </html>`;
  // A run of whitespace shows as one space, and the templates' indentation would be a third of
  // each email.
  return page.toString().replace(/[ \t\r\n]+/g, " ");
}

export function mailButton(label: string, url: string) {
  return html`<p style="margin:24px 0 0;text-align:center;">
    <a
      href="${url}"
      style="display:inline-block;background:${TEAL};color:#ffffff;text-decoration:none;font-size:15px;padding:10px 22px;border-radius:10px;"
      >${label}</a
    >
  </p>`;
}

// Numbers in boxes, three to a row, a unit in small print after the number and a note under its
// label. The table sits in a div pulled out by the spacing of its cells, which would otherwise
// indent them from the text.
export function mailNumbers(
  items: { value: number; unit?: string; label: string; note?: string }[],
) {
  const rows = [];
  for (let i = 0; i < items.length; i += 3) rows.push(items.slice(i, i + 3));
  return html`<div style="margin:12px -8px 0;">
    <table
      role="presentation"
      width="100%"
      cellpadding="0"
      cellspacing="8"
      style="table-layout:fixed;"
    >
      ${rows.map(
        (row) =>
          html`<tr>
            ${row.map(
              (n) =>
                html`<td
                  style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;padding:14px 8px;text-align:center;"
                >
                  <div style="font-size:24px;font-weight:600;color:${TEAL};">
                    ${n.value}${n.unit && html`<span style="font-size:14px;"> ${n.unit}</span>`}
                  </div>
                  <div style="font-size:13px;color:${MUTED};margin-top:2px;">${n.label}</div>
                  ${n.note && html`<div style="font-size:12px;color:${MUTED};">${n.note}</div>`}
                </td>`,
            )}
          </tr>`,
      )}
    </table>
  </div>`;
}

// Why the mail came and how to stop it, as the big senders say it; the link turns this kind off
// without logging in. reason is what was turned on, e.g. 「回复我」的邮件提醒.
export function optOut(reason: string, unsubscribe: string) {
  const settings = `${env.PUBLIC_URL}/settings#notify`;
  return {
    html: html`你收到这封邮件，是因为在${SITE_NAME}开启了${reason}。<br /><a
        href="${unsubscribe}"
        style="color:${MUTED};"
        >不再接收此类邮件</a
      >
      · <a href="${settings}" style="color:${MUTED};">管理邮件提醒</a>`,
    text: `——\n你收到这封邮件，是因为在${SITE_NAME}开启了${reason}。\n不再接收此类邮件：${unsubscribe}\n管理邮件提醒：${settings}`,
  };
}
