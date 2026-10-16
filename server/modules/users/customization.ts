// What people can make their card and page look like (design §8.16). Pages import this too, so
// it holds only constants and what follows from them; the database keeps the keys.

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

export const STATUS_MAX = 30;
export const PINS_MAX = 6;
export const SHOWCASE_MAX = 1000;
