// Who the forum is, the same in page titles, share cards, the header and emails (design §9).
// Constants rather than settings: only a rebrand would change them.
export const SITE_NAME = "鼠洞";
export const SITE_DESCRIPTION = "四非计算机保研鼠群的论坛";

// The forum's levels L0–L5 (design §6.6), always shown with their number: "L3 硕鼠".
export const LEVEL_NAMES = ["鼠鼠", "小鼠", "学鼠", "硕鼠", "博鼠", "鼠导"];

export function levelName(level: number) {
  return `L${level} ${LEVEL_NAMES[level]}`;
}
