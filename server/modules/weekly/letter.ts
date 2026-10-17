import { html } from "hono/html";
import {
  INK,
  LINE,
  mailButton,
  mailNumbers,
  mailPage,
  MUTED,
  optOut,
  SERIF,
  TEAL,
} from "../../platform/mail-page.ts";
import { BOT_NAME, readTime, SITE_NAME } from "../../platform/site.ts";
import { RECENT_DAYS } from "../levels/rules.ts";

// The weekly letter (design §8.15): what someone's floors did for others last week, written to
// thank them. Only what happened is said; a count of nothing is left out.

export type Week = {
  name: string;
  // Never logged in: their floors came from the groups, and the letter says how to come.
  activated: boolean;
  reads: number;
  likes: number;
  accepted: number;
  // The same the week before, to tell how it changed.
  before: { reads: number; likes: number; accepted: number };
  // Their places on the weekly lists (design §8.15) they made.
  places: { label: string; place: number }[];
  // What the next level still needs of each requirement, or keeping L4 does; null with nothing
  // missing or no level to go for.
  level: {
    name: string;
    keep: boolean;
    missing: { key: string; label: string; left: number }[];
  } | null;
  badges: string[];
  // Their floors most liked last week, each with the likes it got then.
  top: { title: string; floor: number; likes: number; url: string }[];
  peopleReached: number;
  profileUrl: string;
  unsubscribe: string;
};

const REASON = "每周来信";

function change(now: number, before: number) {
  if (now > before) return `比上周多 ${now - before}`;
  if (now < before) return `比上周少 ${before - now}`;
  return undefined;
}

// The numbers worth telling, biggest news first.
function numbers(week: Week) {
  return [
    { label: "被读", value: week.reads, before: week.before.reads },
    { label: "获赞", value: week.likes, before: week.before.likes },
    { label: "被采纳", value: week.accepted, before: week.before.accepted },
  ]
    .filter((n) => n.value > 0)
    .map((n) => ({ label: n.label, value: n.value, unit: "次", note: change(n.value, n.before) }));
}

function placesLine(week: Week) {
  const places = week.places.map((p) => `${p.label}第 ${p.place}`).join("、");
  return `上周全站排名：${places}。`;
}

function levelLine({ name, keep, missing }: NonNullable<Week["level"]>) {
  const left = missing
    .map((m) => {
      if (m.key !== "read_seconds") return `${m.label} ${m.left}`;
      const time = readTime(m.left);
      return `${m.label} ${time.n} ${time.unit}`;
    })
    .join("、");
  return keep
    ? `要保持 ${name}，最近 ${RECENT_DAYS} 天还差：${left}。`
    : `离 ${name}还差：${left}。`;
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
      .map((n) => `${n.label} ${n.value} ${n.unit}${n.note ? `（${n.note}）` : ""}`)
      .join("，"),
    ...(week.places.length > 0 ? [placesLine(week)] : []),
    ...(week.badges.length > 0 ? [`新得到的徽章：${week.badges.join("、")}`] : []),
    ...(week.level ? [levelLine(week.level)] : []),
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
  const card = html`<div style="font-family:${SERIF};font-size:17px;line-height:1.9;">
      <p style="margin:0 0 12px;">${week.name}，你好：</p>
      <p style="margin:0 0 12px;">
        过去一周，你在${SITE_NAME}留下的文字又帮到了一些人。想把这些告诉你：
      </p>
    </div>
    ${mailNumbers(numbers(week))}
    ${
      week.places.length > 0
        ? html`<p style="margin:12px 0 0;font-size:14px;">${placesLine(week)}</p>`
        : ""
    }
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
      week.level
        ? html`<p style="margin:12px 0 0;font-size:14px;color:${MUTED};">
            ${levelLine(week.level)}
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
