import { STAFF } from "../../platform/site.ts";

// What people can make their card and page look like (design §8.16). Pages import this too, so
// it holds only constants and what follows from them; the database keeps the keys.

// Looks unlocked by level are open to moderators and admins, as levels' permissions are.
export function reaches(user: { level: number; role: string }, level: number) {
  return user.level >= level || STAFF.includes(user.role);
}

// Accent colours besides the site's own sea teal, which is no theme at all. app.css has them.
export const THEMES = [
  "apricot",
  "ink",
  "sakura",
  "sky",
  "wisteria",
  "vermilion",
  "graphite",
] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_NAMES: Record<Theme, string> = {
  apricot: "杏黄",
  ink: "墨绿",
  sakura: "樱粉",
  sky: "天蓝",
  wisteria: "紫藤",
  vermilion: "朱红",
  graphite: "石墨",
};
export const DEFAULT_THEME_NAME = "海青";

// What moderators clear when it isn't fit to show.
export const CLEARABLE = ["background", "status", "showcase"] as const;
export type Clearable = (typeof CLEARABLE)[number];

export const STATUS_MAX = 30;
export const PINS_MAX = 6;
export const SHOWCASE_MAX = 1000;

// Backgrounds drawn by app/components/backdrop.tsx, and the level each opens at.
export const BACKGROUNDS = [
  "mist",
  "paper",
  "waves",
  "sunrise",
  "stars",
  "aurora",
  "shimmer",
  "gilded",
] as const;
export type BackgroundPreset = (typeof BACKGROUNDS)[number];
export const BACKGROUND_PRESETS: Record<BackgroundPreset, { name: string; level: number }> = {
  mist: { name: "晨雾", level: 0 },
  paper: { name: "纸笺", level: 0 },
  waves: { name: "海浪", level: 1 },
  sunrise: { name: "日出", level: 2 },
  stars: { name: "星空", level: 3 },
  aurora: { name: "极光", level: 3 },
  shimmer: { name: "流光", level: 4 },
  gilded: { name: "鎏金", level: 5 },
};

// One's own picture, from this level.
export const UPLOAD_LEVEL = 3;

// What an uploaded picture is cut into: the top of the card and the banner of the page. Still
// pictures at twice the size they show at; animated ones smaller, and only so large.
export const BACKGROUND_CROPS = {
  card: {
    ratio: 2,
    still: { width: 576, height: 288 },
    moving: { width: 432, height: 216 },
    movingMax: 500 * 1024,
  },
  profile: {
    ratio: 3,
    still: { width: 1200, height: 400 },
    moving: { width: 900, height: 300 },
    movingMax: 1024 * 1024,
  },
};

// Avatar frames drawn by app/components/frame.tsx, and what opens each: a level, a badge, any gold
// badge, or an event badge an admin gave the frame to.
export const FRAMES = [
  "teal",
  "apricot",
  "flow",
  "breath",
  "laurel",
  "sprout",
  "gilt",
  "trophy",
  "wreath",
  "confetti",
  "medal",
] as const;
export type Frame = (typeof FRAMES)[number];
export const EVENT_FRAMES = ["trophy", "wreath", "confetti", "medal"] as const;

// `by` is what a locked one says opens it.
type Unlock = { level: number } | { badge: string; by: string } | { gold: true } | { event: true };
export const FRAME_LOOKS: Record<Frame, { name: string; unlock: Unlock }> = {
  teal: { name: "青环", unlock: { level: 1 } },
  apricot: { name: "杏环", unlock: { level: 2 } },
  flow: { name: "流转", unlock: { level: 3 } },
  breath: { name: "呼吸", unlock: { level: 4 } },
  laurel: { name: "桂冠", unlock: { level: 5 } },
  sprout: { name: "新芽", unlock: { badge: "seed", by: "种子用户" } },
  gilt: { name: "金边", unlock: { gold: true } },
  trophy: { name: "奖杯", unlock: { event: true } },
  wreath: { name: "花环", unlock: { event: true } },
  confetti: { name: "彩带", unlock: { event: true } },
  medal: { name: "纪念章", unlock: { event: true } },
};

// What a locked frame says opens it.
export function frameUnlockLabel(frame: Frame) {
  const { unlock } = FRAME_LOOKS[frame];
  if ("level" in unlock) return `L${unlock.level}`;
  if ("badge" in unlock) return unlock.by;
  return "gold" in unlock ? "金徽章" : "活动";
}

// Which frames someone may pick, given the badges they have.
export function unlockedFrames(
  user: { level: number; role: string },
  badges: { slug: string | null; tier: string; frame: string | null }[],
) {
  return FRAMES.filter((key) => {
    const { unlock } = FRAME_LOOKS[key];
    if ("level" in unlock) return reaches(user, unlock.level);
    if ("badge" in unlock) return badges.some((b) => b.slug === unlock.badge);
    if ("gold" in unlock) return badges.some((b) => b.tier === "gold");
    return badges.some((b) => b.frame === key);
  });
}
