// Who the forum is, the same in page titles, share cards, the header and emails (design §9).
// Constants rather than settings: only a rebrand would change them.
export const SITE_NAME = "鼠洞";
export const SITE_DESCRIPTION = "四非计算机保研鼠群的论坛";
// The bot in the groups, by name wherever members are told about it; never "机器人".
export const BOT_NAME = "鼬鼬bot";
// 鼠群's own site, which links back to the forum from its header.
export const MAIN_SITE = "https://mousebaoyan.cn";

// The forum's levels L0–L5 (design §6.6), always shown with their number: "L3 硕鼠".
export const LEVEL_NAMES = ["鼠鼠", "小鼠", "学鼠", "硕鼠", "博鼠", "鼠导"];

export function levelName(level: number) {
  return `L${level} ${LEVEL_NAMES[level]}`;
}

// Reading time wherever it is shown: in hours from an hour on, else in minutes.
export function readTime(seconds: number) {
  return seconds >= 3600
    ? { n: Math.round(seconds / 360) / 10, unit: "小时" }
    : { n: Math.round(seconds / 60), unit: "分钟" };
}

// Badge tiers (design §8.8), as in "银徽章".
export const TIER_NAMES: Record<string, string> = { gold: "金", silver: "银", bronze: "铜" };

// Moderators and up (design §6.4). The owner runs the system and may do whatever admins do.
export const STAFF = ["moderator", "admin", "owner"];

// Visits are counted by the Umami on the forum's server (design §12), on the real site only, so
// local, CI and staging pages never call it.
export const UMAMI = {
  site: "https://bbs.mousebaoyan.cn",
  origin: "https://umami.juniexd.cn",
  websiteId: "ebf04406-ab5c-4f96-9e38-584911473bb7",
};
