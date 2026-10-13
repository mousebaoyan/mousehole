// Fake content for the style draft. Replaced by /api/v1 data once boards and threads exist.

export type Board = { slug: string; name: string; color: string; threads: number };

export const boards: Board[] = [
  { slug: "announce", name: "公告", color: "#4f5663", threads: 6 },
  { slug: "qa", name: "保研问答", color: "#2563eb", threads: 1284 },
  { slug: "experience", name: "经验分享", color: "#1f9d63", threads: 356 },
  { slug: "deadlines", name: "通知与截止日期", color: "#e8a21a", threads: 412 },
  { slug: "schools", name: "院校交流", color: "#6e56cf", threads: 198 },
  { slug: "chat", name: "闲聊", color: "#e8956b", threads: 731 },
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
  lastPoster: User;
  lastActive: string;
  participants: User[];
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
    lastPoster: users.rex,
    lastActive: "3 天前",
    participants: [users.owner, users.rex, users.qi],
  },
  {
    id: 2,
    board: "qa",
    title: "rank 30% 能冲华五的夏令营吗？有没有类似背景的学长学姐",
    author: users.qi,
    tags: ["夏令营", "定位"],
    kind: "question",
    solved: false,
    replies: 12,
    views: 436,
    lastPoster: users.moon,
    lastActive: "12 分钟前",
    participants: [users.qi, users.moon, users.nj, users.cat],
  },
  {
    id: 3,
    board: "experience",
    title: "26 届南大 CS 夏令营复盘：机试、面试和联系导师的时间线",
    author: users.nj,
    tags: ["南京大学", "夏令营", "机试"],
    kind: "discussion",
    featured: true,
    replies: 48,
    views: 3104,
    lastPoster: users.sea,
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
    replies: 7,
    views: 289,
    lastPoster: users.rex,
    lastActive: "1 小时前",
    participants: [users.ict, users.rex, users.moon],
  },
  {
    id: 5,
    board: "deadlines",
    title: "复旦大学计算机科学技术学院 2026 年夏令营报名开启（6 月 10 日截止）",
    author: users.rex,
    tags: ["复旦大学", "夏令营"],
    kind: "discussion",
    replies: 5,
    views: 912,
    lastPoster: users.qi,
    lastActive: "2 小时前",
    participants: [users.rex, users.qi],
  },
  {
    id: 6,
    board: "schools",
    title: "上交 CS 学硕和浙大软院专硕怎么选？想做系统方向",
    author: users.moon,
    tags: ["上海交通大学", "浙江大学", "系统"],
    kind: "discussion",
    replies: 31,
    views: 1210,
    lastPoster: users.nj,
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
    lastPoster: users.cat,
    lastActive: "5 小时前",
    participants: [users.sea, users.cat, users.rex],
  },
  {
    id: 8,
    board: "chat",
    title: "今天的鼠鼠也在努力（每日打卡楼）",
    author: users.cat,
    tags: [],
    kind: "discussion",
    fromQQ: true,
    replies: 214,
    views: 5320,
    lastPoster: users.qi,
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
    lastPoster: users.ict,
    lastActive: "2 天前",
    participants: [users.rex, users.ict, users.nj, users.moon],
  },
];

export type Post = {
  id: number;
  floor: number;
  author: User;
  time: string;
  html: string;
  fromQQ?: boolean;
  accepted?: boolean;
  reactions: { emoji: string; count: number; mine?: boolean }[];
  replies?: { id: number; author: User; replyTo?: User; time: string; text: string }[];
  moreReplies?: number;
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
    reactions: [{ emoji: "👀", count: 4 }],
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
    reactions: [
      { emoji: "👍", count: 18, mine: true },
      { emoji: "🎉", count: 3 },
    ],
    replies: [
      {
        id: 201,
        author: users.ict,
        time: "09:52",
        text: "明白了，我去把结题报告里的实验数据翻出来",
      },
      {
        id: 202,
        author: users.moon,
        replyTo: users.ict,
        time: "10:03",
        text: "顺便把代码整理一下放 GitHub，面试时打开给老师看很加分",
      },
    ],
    moreReplies: 3,
  },
  {
    id: 103,
    floor: 3,
    author: users.moon,
    time: "今天 10:15",
    html: `<p>补充一点：如果大创用到了什么工程上的东西，可以单独写一行技术栈，比如：</p>
<pre><code>PyTorch · 混合精度训练 · 4×3090 多卡</code></pre>
<p>老师扫一眼就知道你动手能力怎么样。</p>`,
    reactions: [{ emoji: "👍", count: 6 }],
  },
  {
    id: 104,
    floor: 4,
    author: users.cat,
    time: "今天 11:30",
    html: `<p>楼上说得都对。另外别忘了在群里搜一下，<a href="#">去年有人整理过简历模板</a>。</p>`,
    reactions: [],
  },
];

export const group = { name: "四非计算机保研鼠群", members: 1824, capacity: 2000 };

export const adminOverview = {
  stats: [
    { label: "成员", value: "1,824", note: "已激活 312" },
    { label: "今日新帖", value: "37", note: "回复 214" },
    { label: "待审核", value: "2", note: "先审后发的版块" },
    { label: "未处理举报", value: "1", note: "最早 3 小时前" },
  ],
  groups: [
    {
      name: "四非计算机保研鼠群",
      id: 987654321,
      members: 1824,
      full: "6 分钟前",
      delta: "1 分钟前",
      ok: true,
      primary: true,
    },
    {
      name: "鼠群 2 群",
      id: 912345678,
      members: 213,
      full: "48 分钟前",
      delta: "12 分钟前",
      ok: false,
      primary: false,
    },
  ],
};
