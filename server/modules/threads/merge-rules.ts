// Which threads may be merged (design §8.20), without the database, so the merge page can say so
// before anything is chosen. Polls, lotteries and chat logs keep what is theirs on the thread; two
// threads' anonymous numbers would clash.

const MERGEABLE_KINDS = new Set(["discussion", "question"]);

export function whyUnmergeable(thread: {
  kind: string;
  status: string;
  author_anonymous: boolean;
  anonymous_replies: boolean;
}) {
  if (!MERGEABLE_KINDS.has(thread.kind)) {
    return "投票、抽奖和聊天记录帖不能合并";
  }
  if (thread.author_anonymous || thread.anonymous_replies) return "打开了匿名的帖子不能合并";
  if (thread.status !== "visible") return "待审核和已隐藏的帖子不能合并";
  return null;
}
