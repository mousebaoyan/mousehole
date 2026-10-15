import { html } from "hono/html";
import { BOT_NAME, SITE_NAME } from "../../platform/site.ts";

// The weekly letter (design §8.15): what someone's floors did for others last week, written to
// thank them. Only what happened is said; a count of nothing is left out.

export type Week = {
  name: string;
  // Never logged in: their floors came from the groups, and the letter says how to come.
  activated: boolean;
  reads: number;
  likes: number;
  accepted: number;
  badges: string[];
  // Their floors most liked last week, each with the likes it got then.
  top: { title: string; floor: number; likes: number; url: string }[];
  peopleReached: number;
  profileUrl: string;
  settingsUrl: string;
};

// Colours of the site (app.css): paper, ink, sea teal, apricot sun.
const PAPER = "#fefdfb";
const INK = "#1f2a28";
const MUTED = "#686d66";
const TEAL = "#2b7a6b";
const SUN = "#ef9f70";
const LINE = "#ebe6dd";
const SERIF = `"Songti SC", "STSong", "Noto Serif SC", serif`;
const SANS = `-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;

// The numbers worth telling, biggest news first.
function numbers(week: Week) {
  return [
    { label: "被读", value: week.reads, unit: "次" },
    { label: "获赞", value: week.likes, unit: "次" },
    { label: "被采纳", value: week.accepted, unit: "次" },
  ].filter((n) => n.value > 0);
}

export function subjectOf(week: Week) {
  const said =
    week.accepted > 0 ? `你的回答被采纳了 ${week.accepted} 次` : `你的分享被读了 ${week.reads} 次`;
  return `谢谢你，${week.name}：上周${said}`;
}

export function letterText(week: Week) {
  const lines = [
    `${week.name}，你好：`,
    "",
    `过去一周，你在${SITE_NAME}留下的文字又帮到了一些人：`,
    numbers(week)
      .map((n) => `${n.label} ${n.value} ${n.unit}`)
      .join("，"),
    ...(week.badges.length > 0 ? [`新得到的徽章：${week.badges.join("、")}`] : []),
    ...(week.top.length > 0
      ? [
          "",
          "上周最受欢迎的楼层：",
          ...week.top.map((t) => `${t.title} #${t.floor}（${t.likes} 个赞）${t.url}`),
        ]
      : []),
    "",
    `到现在，你的分享一共帮到了 ${week.peopleReached} 位群友。`,
    "保研路上信息难得，每一条认真的回答，都可能让后来的人少走一段弯路。谢谢你愿意分享。",
    "",
    week.activated
      ? `去看看：${week.profileUrl}`
      : `你在群里的发言已整理到${SITE_NAME}，记在你的名下。私聊${BOT_NAME} 发送「登录」即可登录查看：${week.profileUrl}`,
    "",
    `${SITE_NAME} 敬上`,
    "",
    "——",
    `如不想再收到每周来信，可在${SITE_NAME}的设置中关闭：${week.settingsUrl}`,
  ];
  return lines.join("\n");
}

// hono/html escapes what goes in: names and titles are written by members. It makes a String
// object; mail wants the string.
export async function letterHtml(week: Week): Promise<string> {
  const shown = numbers(week);
  const letter = await html`<!doctype html>
    <html lang="zh-CN">
      <body style="margin:0;padding:24px 12px;background:#f3efe8;">
        <table
          role="presentation"
          width="100%"
          cellpadding="0"
          cellspacing="0"
          style="max-width:560px;margin:0 auto;background:${PAPER};border:1px solid ${LINE};border-radius:16px;"
        >
          <tr>
            <td
              style="padding:28px 28px 8px;font-family:${SANS};font-size:13px;color:${MUTED};letter-spacing:2px;"
            >
              <span style="color:${SUN};">●</span> ${SITE_NAME} · 每周来信
            </td>
          </tr>
          <tr>
            <td
              style="padding:12px 28px 0;font-family:${SERIF};font-size:17px;line-height:1.9;color:${INK};"
            >
              <p style="margin:0 0 12px;">${week.name}，你好：</p>
              <p style="margin:0 0 20px;">
                过去一周，你在${SITE_NAME}留下的文字又帮到了一些人。想把这些告诉你：
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="8">
                <tr>
                  ${shown.map(
                    (n) =>
                      html`<td
                        style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;padding:14px 8px;text-align:center;font-family:${SANS};"
                      >
                        <div style="font-size:26px;font-weight:600;color:${TEAL};">${n.value}</div>
                        <div style="font-size:13px;color:${MUTED};margin-top:2px;">
                          ${n.label}（${n.unit}）
                        </div>
                      </td>`,
                  )}
                </tr>
              </table>
            </td>
          </tr>
          ${
            week.badges.length > 0
              ? html`<tr>
                  <td style="padding:12px 28px 0;font-family:${SANS};font-size:14px;color:${INK};">
                    新得到的徽章：${week.badges.map(
                      (b) =>
                        html`<span
                          style="display:inline-block;margin:4px 6px 0 0;padding:2px 10px;border-radius:999px;background:#fbeee4;color:#a9532e;"
                          >${b}</span
                        >`,
                    )}
                  </td>
                </tr>`
              : ""
          }
          ${
            week.top.length > 0
              ? html`<tr>
                  <td style="padding:20px 28px 0;font-family:${SANS};">
                    <div style="font-size:13px;color:${MUTED};margin-bottom:6px;">
                      上周最受欢迎的楼层
                    </div>
                    ${week.top.map(
                      (t) =>
                        html`<div
                          style="padding:8px 0;border-top:1px solid ${LINE};font-size:15px;"
                        >
                          <a href="${t.url}" style="color:${INK};text-decoration:none;"
                            >${t.title} <span style="color:${MUTED};">#${t.floor}</span></a
                          >
                          <span style="float:right;color:${TEAL};">♥ ${t.likes}</span>
                        </div>`,
                    )}
                  </td>
                </tr>`
              : ""
          }
          <tr>
            <td
              style="padding:24px 28px 0;font-family:${SERIF};font-size:17px;line-height:1.9;color:${INK};"
            >
              <p style="margin:0 0 12px;">
                到现在，你的分享一共帮到了
                <b style="color:${TEAL};">${week.peopleReached}</b> 位群友。
              </p>
              <p style="margin:0;">
                保研路上信息难得，每一条认真的回答，都可能让后来的人少走一段弯路。谢谢你愿意分享。
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px 0;font-family:${SANS};">
              <a
                href="${week.profileUrl}"
                style="display:inline-block;background:${TEAL};color:#ffffff;text-decoration:none;font-size:15px;padding:10px 22px;border-radius:10px;"
                >去${SITE_NAME}看看</a
              >
              ${
                week.activated
                  ? ""
                  : html`<p style="margin:12px 0 0;font-size:13px;line-height:1.7;color:${MUTED};">
                      你在群里的发言已整理到${SITE_NAME}，记在你的名下。私聊${BOT_NAME}
                      发送「登录」即可登录查看。
                    </p>`
              }
            </td>
          </tr>
          <tr>
            <td
              style="padding:24px 28px 28px;font-family:${SERIF};font-size:16px;color:${INK};text-align:right;"
            >
              ${SITE_NAME} 敬上
            </td>
          </tr>
        </table>
        <p
          style="max-width:560px;margin:12px auto 0;font-family:${SANS};font-size:12px;color:${MUTED};text-align:center;"
        >
          如不想再收到每周来信，可在<a href="${week.settingsUrl}" style="color:${MUTED};">设置</a
          >中关闭
        </p>
      </body>
    </html>`;
  return letter.toString();
}
