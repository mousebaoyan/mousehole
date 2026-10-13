// Made-up people who reacted, for the reaction list until reactions have their API.

const users = [
  { id: 1, display_name: "鼠群群主", level: 72 },
  { id: 2, display_name: "Rex", level: 55 },
  { id: 3, display_name: "阿柒", level: 23 },
  { id: 4, display_name: "月亮不睡我不睡", level: 41 },
  { id: 5, display_name: "南京的鼠", level: 60 },
  { id: 6, display_name: "计算所预备役", level: 12 },
];

export type ReactionKey =
  | "heart"
  | "+1"
  | "laughing"
  | "open_mouth"
  | "clap"
  | "tada"
  | "hugs"
  | "thinking"
  | "sob"
  | "mouse";

export type Reactions = Partial<Record<ReactionKey, number>>;

export function reactorsOf(reactions: Reactions) {
  return Object.entries(reactions).flatMap(([key, count], k) =>
    Array.from({ length: Math.min(count, 12) }, (_, i) => ({
      user: users[(i + k * 3) % users.length],
      reaction: key,
    })),
  );
}
