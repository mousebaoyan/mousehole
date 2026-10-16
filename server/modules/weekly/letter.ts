import { html } from "hono/html";
import {
  INK,
  LINE,
  mailButton,
  mailPage,
  MUTED,
  optOut,
  SERIF,
  TEAL,
} from "../../platform/mail-page.ts";
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
  unsubscribe: string;
};

const REASON = "每周来信";

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
    optOut(REASON, week.unsubscribe).text,
  ];
  return lines.join("\n");
}

export async function letterHtml(week: Week) {
  const shown = numbers(week);
  // The numbers' table sits in a div pulled out by the spacing of its cells, which would
  // otherwise indent them from the text.
  const card = html`<div style="font-family:${SERIF};font-size:17px;line-height:1.9;">
      <p style="margin:0 0 12px;">${week.name}，你好：</p>
      <p style="margin:0 0 12px;">
        过去一周，你在${SITE_NAME}留下的文字又帮到了一些人。想把这些告诉你：
      </p>
    </div>
    <div style="margin:0 -8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="8">
        <tr>
          ${shown.map(
            (n) =>
              html`<td
                style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;padding:14px 8px;text-align:center;"
              >
                <div style="font-size:26px;font-weight:600;color:${TEAL};">${n.value}</div>
                <div style="font-size:13px;color:${MUTED};margin-top:2px;">
                  ${n.label}（${n.unit}）
                </div>
              </td>`,
          )}
        </tr>
      </table>
    </div>
    ${
      week.badges.length > 0
        ? html`<p style="margin:12px 0 0;font-size:14px;">
            新得到的徽章：${week.badges.map(
              (b) =>
                html`<span
                  style="display:inline-block;margin:4px 6px 0 0;padding:2px 10px;border-radius:999px;background:#fbeee4;color:#a9532e;"
                  >${b}</span
                >`,
            )}
          </p>`
        : ""
    }
    ${
      week.top.length > 0
        ? html`<div style="margin-top:20px;font-size:13px;color:${MUTED};margin-bottom:6px;">
              上周最受欢迎的楼层
            </div>
            ${week.top.map(
              (t) =>
                html`<div style="padding:8px 0;border-top:1px solid ${LINE};">
                  <a href="${t.url}" style="color:${INK};text-decoration:none;"
                    >${t.title} <span style="color:${MUTED};">#${t.floor}</span></a
                  >
                  <span style="float:right;color:${TEAL};">♥ ${t.likes}</span>
                </div>`,
            )}`
        : ""
    }
    <div style="margin-top:24px;font-family:${SERIF};font-size:17px;line-height:1.9;">
      <p style="margin:0 0 12px;">
        到现在，你的分享一共帮到了 <b style="color:${TEAL};">${week.peopleReached}</b> 位群友。
      </p>
      <p style="margin:0;">
        保研路上信息难得，每一条认真的回答，都可能让后来的人少走一段弯路。谢谢你愿意分享。
      </p>
    </div>
    ${mailButton(`去${SITE_NAME}看看`, week.profileUrl)}
    ${
      week.activated
        ? ""
        : html`<p style="margin:12px 0 0;font-size:13px;line-height:1.7;color:${MUTED};">
            你在群里的发言已整理到${SITE_NAME}，记在你的名下。私聊${BOT_NAME}
            发送「登录」即可登录查看。
          </p>`
    }
    <p style="margin:24px 0 0;font-family:${SERIF};font-size:16px;text-align:right;">
      ${SITE_NAME} 敬上
    </p>`;
  return mailPage(subjectOf(week), card, optOut(REASON, week.unsubscribe).html);
}
