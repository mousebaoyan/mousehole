const UNTIL = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export type Restriction = { type: string; until: number | null };

// A mute or ban as people read it: "已禁言，到 10月15日 08:00 解除".
export function restrictionText(r: Restriction) {
  const what = r.type === "ban" ? "已封禁" : "已禁言";
  return r.until === null
    ? `${what}（永久）`
    : `${what}，到 ${UNTIL.format(new Date(r.until * 1000))} 解除`;
}
