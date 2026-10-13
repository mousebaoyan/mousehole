// Fake content for the style draft. Replaced by /api/v1 data once boards and threads exist.

export type Board = {
  slug: string;
  name: string;
  color: string;
  description: string;
  threads: number;
};

export const boards: Board[] = [
  { slug: "announce", name: "公告", color: "#55625f", description: "站务公告与规则", threads: 6 },
  {
    slug: "qa",
    name: "保研问答",
    color: "#e07b53",
    description: "定位、材料、流程等问题",
    threads: 1284,
  },
  {
    slug: "experience",
    name: "经验分享",
    color: "#5e9a6f",
    description: "夏令营、预推免与上岸复盘",
    threads: 356,
  },
  {
    slug: "deadlines",
    name: "通知与截止日期",
    color: "#d29b2f",
    description: "各院校通知与报名截止时间",
    threads: 412,
  },
  {
    slug: "schools",
    name: "院校交流",
    color: "#5a7fa6",
    description: "院校、导师与方向的选择",
    threads: 198,
  },
  { slug: "chat", name: "闲聊", color: "#ad7a9f", description: "保研之外的日常", threads: 731 },
];

export type User = {
  id: number;
  name: string;
  level: number;
  levelName: string;
  title?: string;
  role?: "admin" | "moderator";
};

const u = (id: number, name: string, level: number, title?: string, role?: User["role"]) => ({
  id,
  name,
  level,
  levelName: ["潜水", "冒泡", "常驻", "活跃", "话痨", "传说"][level - 1] ?? "传说",
  title,
  role,
});

export const users = {
  owner: u(1, "鼠群群主", 6, "群主", "admin"),
  rex: u(2, "Rex", 5, "已上岸·复旦", "moderator"),
  qi: u(3, "阿柒", 3, "26届"),
  moon: u(4, "月亮不睡我不睡", 4, "26届"),
  nj: u(5, "南京的鼠", 5, "已上岸·南大"),
  ict: u(6, "计算所预备役", 2, "27届"),
  cat: u(7, "夜猫子", 4),
  sea: u(8, "海边的鼠鼠", 1, "27届"),
} satisfies Record<string, User>;

export type Thread = {
  id: number;
  board: string;
  title: string;
  author: User;
  tags: string[];
  kind: "discussion" | "question";
  solved?: boolean;
  pinned?: boolean;
  featured?: boolean;
  fromQQ?: boolean;
  replies: number;
  views: number;
  lastActive: string;
  participants: User[];
  // For the signed-in reader: never opened (new), or floors added since they last read it.
  isNew?: boolean;
  unread?: number;
};

export const threads: Thread[] = [
  {
    id: 1,
    board: "announce",
    title: "鼠洞内测说明：账号、三种登录方式和发帖规则",
    author: users.owner,
    tags: ["必读"],
    kind: "discussion",
    pinned: true,
    replies: 23,
    views: 1820,
    lastActive: "3 天前",
    participants: [users.owner, users.rex, users.qi],
  },
  {
    id: 2,
    unread: 3,
    board: "qa",
    title: "rank 30% 能冲华五的夏令营吗？有没有类似背景的学长学姐",
    author: users.qi,
    tags: ["夏令营", "定位"],
    kind: "question",
    solved: false,
    replies: 12,
    views: 436,
    lastActive: "12 分钟前",
    participants: [users.qi, users.moon, users.nj, users.cat],
  },
  {
    id: 3,
    isNew: true,
    board: "experience",
    title: "26 届南大 CS 夏令营复盘：机试、面试和联系导师的时间线",
    author: users.nj,
    tags: ["南京大学", "夏令营", "机试"],
    kind: "discussion",
    featured: true,
    replies: 48,
    views: 3104,
    lastActive: "36 分钟前",
    participants: [users.nj, users.sea, users.ict, users.qi, users.cat],
  },
  {
    id: 4,
    board: "qa",
    title: "科研经历只有一段大创，简历怎么写才不显得单薄？",
    author: users.ict,
    tags: ["简历", "科研"],
    kind: "question",
    solved: true,
    fromQQ: true,
    replies: 8,
    views: 289,
    lastActive: "1 小时前",
    participants: [users.ict, users.rex, users.moon],
  },
  {
    id: 5,
    isNew: true,
    board: "deadlines",
    title: "复旦大学计算机科学技术学院 2026 年夏令营报名开启（6 月 10 日截止）",
    author: users.rex,
    tags: ["复旦大学", "夏令营"],
    kind: "discussion",
    replies: 5,
    views: 912,
    lastActive: "2 小时前",
    participants: [users.rex, users.qi],
  },
  {
    id: 6,
    unread: 12,
    board: "schools",
    title: "上交 CS 学硕和浙大软院专硕怎么选？想做系统方向",
    author: users.moon,
    tags: ["上海交通大学", "浙江大学", "系统"],
    kind: "discussion",
    replies: 31,
    views: 1210,
    lastActive: "3 小时前",
    participants: [users.moon, users.nj, users.rex, users.cat],
  },
  {
    id: 7,
    board: "qa",
    title: "预推免的英语面试一般问什么？需要提前准备自我介绍吗",
    author: users.sea,
    tags: ["预推免", "面试"],
    kind: "question",
    solved: true,
    replies: 9,
    views: 377,
    lastActive: "5 小时前",
    participants: [users.sea, users.cat, users.rex],
  },
  {
    id: 8,
    unread: 27,
    board: "chat",
    title: "今天的鼠鼠也在努力（每日打卡楼）",
    author: users.cat,
    tags: [],
    kind: "discussion",
    fromQQ: true,
    replies: 214,
    views: 5320,
    lastActive: "昨天",
    participants: [users.cat, users.qi, users.moon, users.sea, users.ict],
  },
  {
    id: 9,
    board: "experience",
    title: "从四非到中科院计算所：一年时间线和踩过的坑",
    author: users.rex,
    tags: ["中科院计算所", "经验"],
    kind: "discussion",
    replies: 66,
    views: 4410,
    lastActive: "2 天前",
    participants: [users.rex, users.ict, users.nj, users.moon],
  },
];

export const tags = ["夏令营", "预推免", "九推", "简历", "机试", "面试", "导师", "定位", "科研"];

const VIEWS = ["latest", "new", "unread", "hot", "unsolved"] as const;
export type ThreadView = (typeof VIEWS)[number];

// The list filters in a page URL: ?view=hot&tag=夏令营.
export function readFilter(url: string) {
  const params = new URL(url).searchParams;
  return {
    view: VIEWS.find((v) => v === params.get("view")) ?? "latest",
    tag: tags.find((t) => t === params.get("tag")) ?? null,
  };
}

// What /api/v1/threads will do with board, tag and view.
export function listThreads(board: string | null, tag: string | null, view: ThreadView) {
  const scope = threads.filter(
    (t) => (board === null || t.board === board) && (tag === null || t.tags.includes(tag)),
  );
  const counts = {
    new: scope.filter((t) => t.isNew).length,
    unread: scope.filter((t) => t.unread).length,
  };
  const list =
    view === "new"
      ? scope.filter((t) => t.isNew)
      : view === "unread"
        ? scope.filter((t) => t.unread)
        : view === "hot"
          ? scope.toSorted((a, b) => b.views - a.views)
          : view === "unsolved"
            ? scope.filter((t) => t.kind === "question" && !t.solved)
            : scope;
  return { threads: list, counts };
}

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

export type Post = {
  id: number;
  floor: number;
  author: User;
  time: string;
  html: string;
  fromQQ?: boolean;
  accepted?: boolean;
  reactions: Reactions;
  myReaction?: ReactionKey;
  boosts?: { user: User; text: string }[];
  // The floor this post answers.
  replyTo?: number;
};

export const topicPosts: Post[] = [
  {
    id: 101,
    floor: 1,
    author: users.ict,
    time: "今天 09:12",
    fromQQ: true,
    html: `<p>27 届，本科四非 CS，rank 15%。目前唯一的科研经历是一段校级大创（做的是小样本图像分类，没有论文），另外有两个课程项目。</p>
<p>看了好几份上岸学长的简历，感觉别人都有一作或者竞赛。想问问：</p>
<ol><li>大创只有结题报告，简历上怎么写才不显得单薄？</li><li>课程项目值得写吗，还是干脆不写？</li></ol>`,
    reactions: { heart: 4, thinking: 2 },
    boosts: [
      { user: users.qi, text: "同问" },
      { user: users.sea, text: "蹲一个回答" },
    ],
  },
  {
    id: 102,
    floor: 2,
    author: users.rex,
    time: "今天 09:40",
    accepted: true,
    html: `<p>大创完全可以写，关键是写清楚<strong>你做了什么</strong>，而不是项目叫什么。建议按这个结构：</p>
<ul><li><strong>问题</strong>：一句话说明要解决什么，为什么难</li><li><strong>你的工作</strong>：用动词开头，比如"复现了 ProtoNet 并改进了数据增强"</li><li><strong>结果</strong>：给数字，哪怕是"在 miniImageNet 5-way 1-shot 上从 49.4% 提到 52.1%"</li></ul>
<p>课程项目挑一个和目标方向最相关的写，其他的放到 GitHub 链接里就行。</p>
<blockquote><p>面试官问得最多的就是"这里面哪部分是你做的"，提前准备好。</p></blockquote>`,
    reactions: { heart: 18, "+1": 7, clap: 3, tada: 1 },
    myReaction: "heart",
    boosts: [
      { user: users.ict, text: "清楚了，感谢！" },
      { user: users.nj, text: "补充得很全面" },
      { user: users.qi, text: "已收藏" },
      { user: users.cat, text: "学到了 👍" },
      { user: users.sea, text: "mark" },
      { user: users.owner, text: "加精" },
      { user: users.moon, text: "结构很清晰" },
      { user: users.rex, text: "欢迎补充" },
    ],
  },
  {
    id: 1105,
    floor: 3,
    author: users.ict,
    time: "今天 09:52",
    replyTo: 2,
    html: "<p>明白了，我去把结题报告里的实验数据翻出来</p>",
    reactions: { heart: 2 },
  },
  {
    id: 1106,
    floor: 4,
    author: users.moon,
    time: "今天 10:03",
    replyTo: 3,
    html: "<p>顺便把代码整理一下放 GitHub，面试时打开给老师看很加分</p>",
    reactions: { "+1": 5 },
  },
  {
    id: 103,
    floor: 5,
    author: users.moon,
    time: "今天 10:15",
    html: `<p>补充一点：如果大创用到了什么工程上的东西，可以单独写一行技术栈，比如：</p>
<pre><code>PyTorch · 混合精度训练 · 4×3090 多卡</code></pre>
<p>老师扫一眼就知道你动手能力怎么样。</p>`,
    reactions: { "+1": 6 },
  },
  {
    id: 1107,
    floor: 6,
    author: users.nj,
    time: "今天 10:20",
    replyTo: 2,
    html: "<p>数据要写清楚对比的基线是什么，不然老师会追问</p>",
    reactions: { heart: 3 },
  },
  {
    id: 1108,
    floor: 7,
    author: users.ict,
    time: "今天 10:26",
    replyTo: 6,
    html: "<p>基线是原版 ProtoNet，我补上</p>",
    reactions: {},
  },
  {
    id: 1109,
    floor: 8,
    author: users.sea,
    time: "今天 11:02",
    replyTo: 2,
    html: "<p>收藏了，明年用得上</p>",
    reactions: { laughing: 1 },
  },
  {
    id: 104,
    floor: 9,
    author: users.cat,
    time: "今天 11:30",
    html: `<p>楼上说得都对。另外别忘了在群里搜一下，<a href="#">去年有人整理过简历模板</a>。</p>`,
    reactions: {},
  },
];

const checkIns = [
  "今天刷了两道机试题",
  "背了 50 个单词",
  "改完简历第三版",
  "看完一篇论文",
  "联系了一位导师",
];
const regulars = [users.cat, users.qi, users.moon, users.sea, users.ict, users.nj];

// A long thread, to show the floor timeline.
export const checkInPosts: Post[] = Array.from({ length: 64 }, (_, i) => ({
  id: 1000 + i,
  floor: i + 1,
  author: i === 0 ? users.cat : (regulars[i % regulars.length] ?? users.cat),
  time: `10月${String(1 + Math.floor(i / 5))}日`,
  html:
    i === 0
      ? "<p>每天来这里打卡，记录当天完成的事情。</p>"
      : `<p>打卡：${checkIns[i % checkIns.length] ?? ""}。</p>`,
  reactions: i % 4 === 0 ? { heart: 1 + (i % 7) } : {},
}));

// Who left each reaction, made up from the users above for the reactions list.
export function reactorsOf(reactions: Reactions) {
  const pool = Object.values(users);
  return Object.entries(reactions).flatMap(([key, count], k) =>
    Array.from({ length: Math.min(count, 12) }, (_, i) => ({
      user: pool[(i + k * 3) % pool.length] ?? users.owner,
      reaction: key,
    })),
  );
}
