import { html } from "hono/html";
import { sql, type NotNull, type Transaction } from "kysely";
import type { DB } from "../../../db/types.ts";
import { env } from "../../platform/env.ts";
import { unsubscribeUrl } from "../../platform/mail.ts";
import {
  INK,
  LINE,
  mailButton,
  mailNumbers,
  mailPage,
  MUTED,
  optOut,
  TEAL,
} from "../../platform/mail-page.ts";
import { excerpt } from "../../platform/markdown.ts";
import { levelName, readTime, SITE_NAME, TIER_NAMES } from "../../platform/site.ts";
import { RECENT_DAYS } from "../levels/rules.ts";
import { anonymousBrief } from "../users/service.ts";
import { NOTIFICATION_LABELS, type NotificationType } from "./types.ts";

// What reminder emails say (design §8.6); service.ts decides who gets them.

type Person = { id: number; qq: number };

// About something done to a floor; levels, lotteries and badges are told by their own, and
// suggestions on the site only.
export type Notice = {
  type: Exclude<NotificationType, "level" | "lottery" | "badge" | "suggestion">;
  actorId: number;
  // Their number in the thread when they did it anonymously (design §8.12).
  actorAlias: number | null;
  threadId: number;
  postId: number;
  data?: Record<string, string>;
};

// What happened, as the email says it after the person's name; levels and lotteries are said
// differently, having nobody behind them.
const SAID: Record<Notice["type"], string> = {
  reply: "回复了你",
  thread_reply: "回复了你的帖子",
  mention: "提到了你",
  like: "赞了你",
  boost: "给你留了短评",
  watching: "回复了你关注的帖子",
  following: "发了新帖",
  solved: "采纳了你的回答",
  moderation: "处理了你的内容",
};

// What a moderator did, for moderation notices, and what comes of it for the author.
const MODERATED: Record<string, string> = {
  approve: "通过了你的内容",
  reject: "未通过你的内容",
  hide: "隐藏了你的内容",
  unhide: "恢复了你的内容",
};
const NOT_SHOWN = "现在别人看不到它。对处理有疑问，可以在群里找版主。";
const MODERATED_AFTER: Record<string, string> = {
  approve: "现在大家都能看到它了。",
  reject: NOT_SHOWN,
  hide: NOT_SHOWN,
  unhide: "现在大家又能看到它了。",
};

// Characters of the floor in an email, and of the floor it replied to.
const MAIL_EXCERPT = 200;
const CONTEXT_EXCERPT = 60;

// Emails go to the QQ mailbox that comes with every QQ number, so they can reach members who
// never logged in here too, when the owner sends to them (design §8.6).
function mailbox(qq: number) {
  return `${qq}@qq.com`;
}

// What a reminder says under what happened, in order: a title, a floor quoted, a line of small
// print, a sentence, numbers in boxes, a list with a heading.
type Line = { kind: "title" | "quote" | "small" | "text"; text: string };
type Block =
  | Line
  | { kind: "numbers"; items: { value: number; unit?: string; label: string }[] }
  | { kind: "list"; title: string; rows: { label: string; value: string; done?: boolean }[] };

const LINE_STYLES: Record<Line["kind"], string> = {
  title: "margin:12px 0 0;font-size:19px;font-weight:600;",
  quote: `margin:12px 0 0;padding:8px 12px;border-left:3px solid ${TEAL};background:#f6f3ee;`,
  small: `margin:8px 0 0;font-size:13px;color:${MUTED};`,
  text: "margin:12px 0 0;",
};

function blockHtml(b: Block) {
  if (b.kind === "numbers") return mailNumbers(b.items);
  if (b.kind === "list") {
    return html`<p style="margin:16px 0 4px;font-weight:600;">${b.title}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${b.rows.map(
          (r) =>
            html`<tr>
              <td
                style="padding:6px 0;border-top:1px solid ${LINE};vertical-align:top;white-space:nowrap;"
              >
                ${r.label}
              </td>
              <td
                style="padding:6px 0 6px 12px;border-top:1px solid ${LINE};vertical-align:top;text-align:right;color:${r.done ? TEAL : INK};"
              >
                ${r.value}
              </td>
            </tr>`,
        )}
      </table>`;
  }
  return html`<p style="${LINE_STYLES[b.kind]}">${b.text}</p>`;
}

function blockText(b: Block) {
  if (b.kind === "numbers") {
    return b.items.map((n) => `${n.label} ${n.value}${n.unit ? ` ${n.unit}` : ""}`).join(" · ");
  }
  if (b.kind === "list") {
    return [b.title, ...b.rows.map((r) => `${r.label}：${r.value}`)].join("\n");
  }
  return b.text;
}

// A reminder by email (design §8.6): what happened, then its blocks, and a button to it; under
// the card, why it came and the link that stops this type. Inboxes preview the floor quoted, or
// the first sentence.
async function reminder(
  person: Person,
  type: NotificationType,
  mail: {
    subject: string;
    said: string;
    blocks: (Block | false)[];
    button: string;
    url: string;
  },
) {
  const unsubscribe = unsubscribeUrl(person.id, type);
  const footer = optOut(`「${NOTIFICATION_LABELS[type]}」的邮件提醒`, unsubscribe);
  const blocks = mail.blocks.filter((b) => b !== false);
  const card = html`<p style="margin:0;font-size:17px;font-weight:600;">${mail.said}</p>
    ${blocks.map(blockHtml)} ${mailButton(mail.button, mail.url)}`;
  const preview = blocks.find((b): b is Line => b.kind === "quote" || b.kind === "text");
  return {
    address: mailbox(person.qq),
    subject: mail.subject,
    body: [mail.said, ...blocks.map(blockText), mail.url, footer.text].join("\n\n"),
    html: await mailPage(preview?.text ?? mail.said, card, footer.html),
    unsubscribe,
  };
}

// The floor a notice is about, its thread, who did it and who wrote it, with the numbers its email
// tells. Accepted answers are counted as the badges count them.
function aboutFloor(trx: Transaction<DB>, notice: Notice) {
  return trx
    .selectFrom("posts")
    .innerJoin("threads", "threads.id", "posts.thread_id")
    .innerJoin("boards", "boards.id", "threads.board_id")
    .innerJoin("users", (join) => join.on("users.id", "=", notice.actorId))
    .innerJoin("users as author", "author.id", "posts.author_id")
    .leftJoin("posts as parent", "parent.id", "posts.reply_to_id")
    .select([
      "posts.floor",
      "posts.html",
      "posts.anonymous",
      "posts.like_count",
      "posts.boost_count",
      "parent.floor as parent_floor",
      "parent.html as parent_html",
      "threads.title",
      "threads.reply_count",
      "threads.view_count",
      "boards.name as board",
      sql<string[]>`ARRAY(SELECT tags.name FROM thread_tags
        JOIN tags ON tags.id = thread_tags.tag_id
        WHERE thread_tags.thread_id = threads.id ORDER BY tags.id)`.as("tags"),
      sql<number>`(SELECT count(DISTINCT p.author_id)::integer FROM posts p
        WHERE p.thread_id = threads.id AND p.status = 'visible' AND p.deleted_at IS NULL)`.as(
        "participants",
      ),
      "users.display_name as actor_name",
      "users.level as actor_level",
      "author.thread_count as author_threads",
      "author.people_reached as author_reached",
      sql<number>`(SELECT count(*)::integer FROM posts p JOIN threads t ON t.id = p.thread_id
        WHERE p.author_id = author.id AND p.accepted_at IS NOT NULL AND p.status = 'visible'
          AND p.deleted_at IS NULL AND NOT p.anonymous
          AND t.status = 'visible' AND t.deleted_at IS NULL)`.as("author_accepted"),
    ])
    .where("posts.id", "=", notice.postId)
    .executeTakeFirstOrThrow();
}

// The next badge up a ladder (design §8.8) for someone with `have` of its count.
function nextBadge(trx: Transaction<DB>, ladder: string, have: number) {
  return trx
    .selectFrom("badges")
    .select(["name", "tier", "need"])
    .where("ladder", "=", ladder)
    .where("need", ">", have)
    .orderBy("need")
    .$narrowType<{ need: NotNull }>()
    .executeTakeFirst();
}

function small(parts: (string | false)[]): Block {
  return { kind: "small", text: parts.filter((p) => p !== false).join(" · ") };
}

// What each kind of floor notice tells besides the floor (design §8.6): a new floor, the thread's
// numbers; a new thread, its board and author; a like or a boost, the floor's numbers; an accepted
// answer, its author's. Likes and accepted answers also tell how far the next badge for them is.
export async function floorReminders(trx: Transaction<DB>, people: Person[], notice: Notice) {
  const about = await aboutFloor(trx, notice);
  const url = `${env.PUBLIC_URL}/t/${notice.threadId}${about.floor > 1 ? `?floor=${about.floor}` : ""}`;
  const actor =
    notice.actorAlias === null ? about.actor_name : anonymousBrief(notice.actorAlias).display_name;
  // Their name and level, ready for what they did to follow.
  const who =
    notice.actorAlias === null && notice.type !== "moderation"
      ? `${actor}（${levelName(about.actor_level)}）`
      : `${actor} `;
  const where = about.floor > 1 ? `${about.title} #${about.floor}` : about.title;
  const quote: Block = { kind: "quote", text: excerpt(about.html, MAIL_EXCERPT) };
  const floorNumbers = small([
    where,
    about.like_count > 0 && `${about.like_count} 个赞`,
    about.boost_count > 0 && `${about.boost_count} 条短评`,
  ]);
  const verb =
    notice.type === "moderation" ? MODERATED[notice.data?.action ?? ""] : SAID[notice.type];
  const subject = `${actor} ${verb}：${about.title}`;
  let mail: { subject: string; said: string; blocks: (Block | false)[]; button: string };
  switch (notice.type) {
    case "following": {
      const did = [
        `发过 ${about.author_threads} 个帖子`,
        about.author_accepted > 0 && `回答被采纳 ${about.author_accepted} 次`,
        about.author_reached > 0 && `帮到过 ${about.author_reached} 位群友`,
      ].filter((d) => d !== false);
      mail = {
        subject,
        said: `你关注的 ${who}发了新帖`,
        blocks: [
          { kind: "title", text: about.title },
          small([about.board, ...about.tags]),
          quote,
          { kind: "small", text: `TA 在${SITE_NAME}${did.join("，")}。` },
        ],
        button: "去看看",
      };
      break;
    }
    case "like":
    case "boost": {
      const next =
        notice.type === "like" && !about.anonymous
          ? await nextBadge(
              trx,
              about.floor === 1 ? "thread_likes" : "reply_likes",
              about.like_count,
            )
          : undefined;
      mail = {
        subject,
        said: `${who}${verb}${notice.type === "boost" ? `：「${notice.data?.body}」` : ""}`,
        blocks: [
          quote,
          floorNumbers,
          next !== undefined && {
            kind: "text",
            text: `再得 ${next.need - about.like_count} 个赞，就能得到${TIER_NAMES[next.tier]}徽章「${next.name}」。`,
          },
        ],
        button: "查看",
      };
      break;
    }
    case "solved": {
      const next = about.anonymous
        ? undefined
        : await nextBadge(trx, "accepted", about.author_accepted);
      mail = {
        subject: `你的回答被采纳了：${about.title}`,
        said: `${who}${verb}`,
        blocks: [
          { kind: "text", text: "谢谢你帮提问的群友解决了问题。" },
          quote,
          small([where]),
          {
            kind: "numbers",
            items: [
              { value: about.author_accepted, label: "回答被采纳" },
              { value: about.like_count, label: "这一层获赞" },
              { value: about.author_reached, label: "帮到的群友" },
            ].filter((n) => n.value > 0),
          },
          next !== undefined && {
            kind: "text",
            text: `再被采纳 ${next.need - about.author_accepted} 次，就能得到${TIER_NAMES[next.tier]}徽章「${next.name}」。`,
          },
        ],
        button: "查看",
      };
      break;
    }
    case "moderation":
      mail = {
        subject,
        said: `${actor} ${verb}${notice.data?.reason ? `（${notice.data.reason}）` : ""}`,
        blocks: [
          quote,
          small([where]),
          { kind: "text", text: MODERATED_AFTER[notice.data?.action ?? ""] },
        ],
        button: "查看",
      };
      break;
    case "reply":
    case "mention":
    case "thread_reply":
    case "watching":
      mail = {
        subject,
        said: `${who}${verb}`,
        blocks: [
          quote,
          notice.type === "reply" &&
            about.parent_floor !== null &&
            about.parent_html !== null && {
              kind: "small",
              text: `回复的是${about.parent_floor === 1 ? "你的主楼" : `你在 #${about.parent_floor} 说的`}：${excerpt(about.parent_html, CONTEXT_EXCERPT)}`,
            },
          small([
            where,
            about.reply_count > 0 && `${about.reply_count} 条回复`,
            about.participants > 1 && `${about.participants} 人参与`,
            about.view_count > 0 && `浏览 ${about.view_count}`,
          ]),
        ],
        button: "去回复",
      };
  }
  const full = { ...mail, url };
  return Promise.all(people.map((p) => reminder(p, notice.type, full)));
}

// ---- Levels, lotteries and badges, which have nobody behind them.

// A level's requirements, with what someone has towards each (levels/rules.ts).
type Requirement = { key: string; label: string; have: number; need: number };
// What earned a level and how far the next one is; null when an admin set it.
export type Standing = {
  earned: Requirement[];
  next: { level: number; items: Requirement[] } | null;
} | null;

// Why someone went up a level by themselves, and what it lets them do (design §6.6).
const LEVEL_WHY: Record<number, string> = {
  1: `你已经在${SITE_NAME}读了不少帖子`,
  2: `你开始在${SITE_NAME}参与讨论，也收到了群友的赞`,
  3: `你常来${SITE_NAME}，读得多、回得多，也得到了不少认可`,
  4: `最近 ${RECENT_DAYS} 天里，你一直是${SITE_NAME}最活跃的群友之一`,
};
const LEVEL_UNLOCKS: Record<number, string> = {
  1: "每天发帖、回复不再限次数，每层的站外链接也不再限个数",
  2: "你可以发投票帖和抽奖帖了",
  3: "你可以建议修改等级比你低的人发的帖子的标题、版块和标签，楼主或版主同意后生效",
  4: "你可以直接修改等级比你低的人发的帖子的标题、版块和标签；举报他们的楼层时，这一层会先隐藏，等版主处理",
  5: "你可以编辑等级比你低的人的楼层，锁定和解锁帖子",
};
const KEEP_L4 = `${levelName(4)}按最近 ${RECENT_DAYS} 天算：达不到会降回 ${levelName(3)}，刚升上去的两周内不降。`;

// As the profile shows progress.
function shown(key: string, n: number) {
  if (key !== "read_seconds") return String(n);
  const time = readTime(n);
  return `${time.n} ${time.unit}`;
}

// What was done, in boxes; staying clear of mutes and bans is a condition, not something done.
function boxed(earned: Requirement[]) {
  return earned
    .filter((r) => r.key !== "clean_days")
    .map((r) => {
      if (r.key !== "read_seconds") return { value: r.have, label: r.label };
      const time = readTime(r.have);
      return { value: time.n, unit: time.unit, label: r.label };
    });
}

export function levelReminder(person: Person, level: number, standing: Standing) {
  const name = levelName(level);
  return reminder(person, "level", {
    subject: `你在${SITE_NAME}升到了 ${name}`,
    said: standing ? `${LEVEL_WHY[level]}，升到了 ${name}` : `管理员把你的等级调到了 ${name}`,
    blocks: [
      standing !== null && { kind: "numbers", items: boxed(standing.earned) },
      { kind: "text", text: `从这一级起，${LEVEL_UNLOCKS[level]}。` },
      standing !== null && level === 4 && { kind: "text", text: KEEP_L4 },
      standing !== null &&
        standing.next !== null && {
          kind: "list",
          title: `下一级 ${levelName(standing.next.level)}`,
          rows: standing.next.items.map((r) => {
            const done = r.have >= r.need;
            const have = shown(r.key, Math.min(r.have, r.need));
            return {
              label: r.label,
              value: `${have} / ${shown(r.key, r.need)}${done ? " ✓" : ""}`,
              done,
            };
          }),
        },
    ],
    button: standing?.next ? "看看升级进度" : "去我的主页",
    url: `${env.PUBLIC_URL}/u/${person.id}`,
  });
}

// How a lottery went for each person told (design §8.13); its author hears who won what.
export type Told =
  | { userId: number; result: "won"; prize: string }
  | { userId: number; result: "lost" | "cancelled" }
  | { userId: number; result: "drawn"; prizes: { name: string; winners: number[] }[] };

// Names listed in the author's email, whatever the number of winners.
const LISTED_WINNERS = 10;

// Only a win and the author's go by email, or a draw would send hundreds of emails at once.
export async function lotteryReminders(
  trx: Transaction<DB>,
  thread: { id: number; title: string },
  told: Told[],
  emailed: Map<number, Person>,
) {
  const entrants = told.filter((t) => t.result === "won" || t.result === "lost").length;
  const winners = told.filter((t) => t.result === "won").length;
  const url = `${env.PUBLIC_URL}/t/${thread.id}`;
  const mails = [];
  for (const t of told) {
    const p = emailed.get(t.userId);
    if (!p) continue;
    if (t.result === "won") {
      mails.push(
        await reminder(p, "lottery", {
          subject: `你中奖了：${t.prize}`,
          said: `恭喜！你在「${thread.title}」里抽中了`,
          blocks: [
            { kind: "title", text: t.prize },
            {
              kind: "numbers",
              items: [
                { value: entrants, label: "参与的人" },
                { value: winners, label: "中奖的人" },
              ],
            },
            { kind: "text", text: "领奖方式写在帖子里，记得去看看。" },
            { kind: "small", text: "开奖结果公开，谁都能复核。" },
          ],
          button: "查看抽奖",
          url,
        }),
      );
    } else if (t.result === "drawn") {
      mails.push(await drawnReminder(trx, p, thread, t.prizes, entrants));
    }
  }
  return mails;
}

async function drawnReminder(
  trx: Transaction<DB>,
  person: Person,
  thread: { id: number; title: string },
  prizes: { name: string; winners: number[] }[],
  entrants: number,
) {
  const winners = prizes.flatMap((p) => p.winners);
  const ids = winners.slice(0, LISTED_WINNERS);
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await trx
            .selectFrom("users")
            .select(["id", "display_name"])
            .where("id", "in", ids)
            .execute()
        ).map((u) => [u.id, u.display_name]),
  );
  let left = LISTED_WINNERS;
  const rows = prizes.flatMap((p) => {
    if (p.winners.length === 0) return [];
    const listed = p.winners.slice(0, left).map((id) => names.get(id));
    left -= listed.length;
    const more = listed.length < p.winners.length;
    return [
      {
        label: p.name,
        value: more ? `${listed.join("、")} 等 ${p.winners.length} 人` : listed.join("、"),
      },
    ];
  });
  return reminder(person, "lottery", {
    subject: `你发起的抽奖已开奖：${thread.title}`,
    said:
      entrants === 0
        ? "这次抽奖没有人参与"
        : `共 ${entrants} 人参与，抽出了 ${winners.length} 位中奖的群友`,
    blocks: [
      rows.length > 0 && { kind: "list", title: "中奖名单", rows },
      rows.length > 0 && { kind: "text", text: "记得按帖子里写的方式给他们发奖。" },
    ],
    button: "查看抽奖",
    url: `${env.PUBLIC_URL}/t/${thread.id}`,
  });
}

// A badge earned (design §8.8): what it takes, the floor it was earned for, how many have it and
// the next one up its ladder.
export async function badgeReminders(
  trx: Transaction<DB>,
  badge: { id: number; name: string; description: string; tier: string },
  granted: { person: Person; post_id: number | null }[],
) {
  const { holders } = await trx
    .selectFrom("user_badges")
    .select(sql<number>`count(DISTINCT user_id)::integer`.as("holders"))
    .where("badge_id", "=", badge.id)
    .executeTakeFirstOrThrow();
  const next = await trx
    .selectFrom("badges as next")
    .innerJoin("badges", (join) =>
      join.onRef("badges.ladder", "=", "next.ladder").onRef("badges.need", "<", "next.need"),
    )
    .select(["next.name", "next.tier", "next.description"])
    .where("badges.id", "=", badge.id)
    .orderBy("next.need")
    .executeTakeFirst();
  const postIds = granted.flatMap((g) => (g.post_id === null ? [] : [g.post_id]));
  const floors = new Map(
    postIds.length === 0
      ? []
      : (
          await trx
            .selectFrom("posts")
            .innerJoin("threads", "threads.id", "posts.thread_id")
            .select(["posts.id", "posts.floor", "posts.html", "posts.like_count", "threads.title"])
            .where("posts.id", "in", postIds)
            .execute()
        ).map((p) => [p.id, p]),
  );
  const tier = `${TIER_NAMES[badge.tier]}徽章`;
  return Promise.all(
    granted.map(({ person, post_id }) => {
      const floor = post_id === null ? undefined : floors.get(post_id);
      return reminder(person, "badge", {
        subject: `你在${SITE_NAME}得到了${tier}「${badge.name}」`,
        said: `${tier}「${badge.name}」`,
        blocks: [
          { kind: "text", text: badge.description },
          floor !== undefined && { kind: "quote", text: excerpt(floor.html, MAIL_EXCERPT) },
          floor !== undefined &&
            small([
              floor.floor > 1 ? `${floor.title} #${floor.floor}` : floor.title,
              `${floor.like_count} 个赞`,
            ]),
          {
            kind: "text",
            text:
              holders === 1 ? "你是第一个得到它的人。" : `${SITE_NAME}里有 ${holders} 人得到过它。`,
          },
          next !== undefined && {
            kind: "text",
            text: `下一枚是${TIER_NAMES[next.tier]}徽章「${next.name}」：${next.description}。`,
          },
        ],
        button: "查看徽章",
        url: `${env.PUBLIC_URL}/badges/${badge.id}`,
      });
    }),
  );
}
