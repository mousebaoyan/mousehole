// Who writes anonymously in a thread (design §8.12); apart from the service so that drafts, which
// the service uses, can tell too.

type Settings = { author_id: number; author_anonymous: boolean; anonymous_replies: boolean };

// The author as the thread says for them, anyone else as it says for replies.
export function writesAnonymously(thread: Settings, userId: number) {
  return userId === thread.author_id ? thread.author_anonymous : thread.anonymous_replies;
}

// How someone's replies go out: as the thread says, or as each reply chooses where only its author
// is anonymous and they aren't the author. Short comments still go as the thread says.
export function replyAnonymity(
  thread: Settings,
  userId: number,
): "named" | "anonymous" | "optional" {
  if (userId !== thread.author_id && thread.author_anonymous && !thread.anonymous_replies) {
    return "optional";
  }
  return writesAnonymously(thread, userId) ? "anonymous" : "named";
}
