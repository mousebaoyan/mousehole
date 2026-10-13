// Turns OneBot v11 message segments into Markdown; see docs/api.md §2.5. What it needs from
// elsewhere comes in `lookups`, so the rules can be tested on their own.

export type Segment = { type: string; data: Record<string, unknown> };

export type Lookups = {
  // Forum members by QQ number.
  members: (qqs: number[]) => Promise<Map<number, { id: number; display_name: string }>>;
  // The image stored here, or null when it couldn't be fetched.
  image: (url: string) => Promise<string | null>;
  // The floor a quoted message became, when it is one in this thread.
  quoted: (messageId: number) => Promise<number | null>;
};

function text(value: unknown) {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

// Chat text shows as typed: characters Markdown would act on are escaped, except in links,
// which escapes would break.
const INLINE = /[\\`*_[\]<>~|]/g;
// A line that would start a heading, quote, list or setext underline; the number of an ordered
// list stays, its dot is escaped.
const LINE_START = /^(\s*)(?:([#>+=-])|(\d+)([.)]))/gm;
const LINK = /(https?:\/\/\S+)/;

export function escapeText(value: string) {
  return value
    .split(LINK)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(INLINE, "\\$&")))
    .join("")
    .replace(LINE_START, (_, space: string, mark?: string, number?: string, dot?: string) =>
      mark === undefined ? `${space}${number}\\${dot}` : `${space}\\${mark}`,
    );
}

export async function onebotToMarkdown(segments: Segment[], lookups: Lookups) {
  const qqs = segments
    .filter((s) => s.type === "at" && text(s.data.qq) !== "all")
    .map((s) => Number(text(s.data.qq)));
  const members = await lookups.members(qqs);
  let replyToId: number | null = null;
  const parts: string[] = [];

  for (const { type, data } of segments) {
    switch (type) {
      case "text":
        parts.push(escapeText(text(data.text)));
        break;
      case "at": {
        if (text(data.qq) === "all") break;
        const member = members.get(Number(text(data.qq)));
        const name = text(data.name);
        // Not someone here: their name only. Their QQ number stays out of public pages.
        parts.push(
          member
            ? `[@${member.display_name.replaceAll(/[[\]]/g, "\\$&")}](/u/${member.id})`
            : `@${escapeText(name || "群友")}`,
        );
        break;
      }
      case "image":
      case "mface": {
        const stored = await lookups.image(text(data.url));
        const alt = escapeText(text(data.summary).replaceAll(/[[\]]/g, ""));
        parts.push(stored ? `![${alt}](${stored})` : "[图片已失效]");
        break;
      }
      case "face":
        parts.push("[表情]");
        break;
      case "reply":
        replyToId = await lookups.quoted(Number(text(data.id)));
        break;
      case "file":
        parts.push(`[文件] ${escapeText(text(data.name) || text(data.file))}`);
        break;
      case "video":
        parts.push("[视频]");
        break;
      case "record":
        parts.push("[语音]");
        break;
      case "forward":
        parts.push("[聊天记录]");
        break;
      case "json":
        parts.push("[卡片]");
        break;
      default:
        parts.push("[消息]");
    }
  }
  return { markdown: parts.join("").trim(), replyToId };
}
