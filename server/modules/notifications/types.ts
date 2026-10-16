// What people are told of; see design §8.6. reply: someone replied to my floor; thread_reply: to
// my thread without naming a floor; mention: @ me; like and boost: on my floor; watching: a new
// floor in a thread I watch; following: a new thread by someone I follow; solved: my answer was
// accepted; moderation: something of mine was approved, rejected, hidden or shown again; level: I
// went up a level; lottery: one I entered or started was drawn or called off; badge: I earned a
// badge. In the order settings list them. Pages use this file too, so it imports nothing.
export const NOTIFICATION_TYPES = [
  "reply",
  "thread_reply",
  "mention",
  "like",
  "boost",
  "watching",
  "following",
  "solved",
  "moderation",
  "level",
  "lottery",
  "badge",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// As settings and emails name them.
export const NOTIFICATION_LABELS: Record<NotificationType, string> = {
  reply: "回复我",
  thread_reply: "回复我的帖子",
  mention: "@我",
  like: "收到赞",
  boost: "收到短评",
  watching: "关注的帖子有新回复",
  following: "关注的人发新帖",
  solved: "回答被采纳",
  moderation: "内容被审核或隐藏",
  level: "升级",
  lottery: "抽奖开奖或取消",
  badge: "获得徽章",
};
