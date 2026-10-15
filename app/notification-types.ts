// The notification types, in the order settings list them (design §8.6).
export const NOTIFICATION_TYPES = [
  { type: "reply", label: "回复我的楼层" },
  { type: "thread_reply", label: "回复我的帖子（没指定回复哪一层）" },
  { type: "mention", label: "@我" },
  { type: "like", label: "点赞" },
  { type: "boost", label: "短评" },
  { type: "watching", label: "关注的帖子有新回复" },
  { type: "following", label: "关注的人发新帖" },
  { type: "solved", label: "回答被采纳" },
  { type: "moderation", label: "内容被审核或隐藏" },
  { type: "level", label: "升级" },
  { type: "lottery", label: "抽奖开奖或取消" },
] as const;
