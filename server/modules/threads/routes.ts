import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { GUEST, reachOf } from "../../platform/access.ts";
import { env } from "../../platform/env.ts";
import {
  actorOf,
  authorize,
  authorizePosting,
  can,
  clientIp,
  createRouter,
  errorResponse,
  readerOf,
  type AppEnv,
  requireWeb,
  unix,
} from "../../platform/http.ts";
import { excerpt, renderMarkdown } from "../../platform/markdown.ts";
import { liveStream } from "../../platform/sse.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import { listBoards } from "../boards/service.ts";
import { onEvent } from "../events/service.ts";
import { BoostSchema, boostJson } from "../reactions/schemas.ts";
import { floorExtras } from "../reactions/service.ts";
import { showImages } from "../uploads/service.ts";
import { UserBriefSchema, UserRefSchema, WriterSchema } from "../users/schemas.ts";
import { pollJson, PollSchema, threadJson, ThreadSchema } from "./schemas.ts";
import { findUserId } from "../users/service.ts";
import {
  countUnread,
  createPost,
  createThread,
  deletePost,
  deleteThread,
  editPost,
  editThread,
  getPost,
  getThread,
  listPosts,
  listReplies,
  listRevisions,
  revealAliases,
  listThreads,
  listModerated,
  listUserPosts,
  MAX_BODY,
  NOTIFY_LEVELS,
  publicThreads,
  recordReading,
  recordView,
  setBookmark,
  setNotifyLevel,
  setPostStatus,
  setSolution,
  setThreadStatus,
  VIEWS,
  type ThreadView,
} from "./service.ts";

const ThreadDetailSchema = ThreadSchema.extend({
  url: z.string(),
  solved_floor: z.number().nullable().openapi({ description: "采纳的回答在第几楼" }),
  excerpt: z.string().openapi({ description: "主楼正文的前 100 个字，分享卡片用" }),
  status: z.string().openapi({
    description: "visible 公开；pending 待审核、hidden 已隐藏，这两种只有作者和版主打得开",
  }),
  author_anonymous: z.boolean().openapi({ description: "楼主匿名" }),
  anonymous_replies: z.boolean().openapi({ description: "楼主以外的人回复时匿名" }),
  poll: PollSchema.nullable().openapi({ description: "投票帖的投票；其他类型为 null" }),
  my_alias: z
    .number()
    .nullable()
    .optional()
    .openapi({ description: "自己在这个帖子里匿名时的编号；只在登录时有" }),
  read_floors: z
    .array(z.tuple([z.number(), z.number()]))
    .optional()
    .openapi({ description: "读过的楼层区间，含两端，例如 [[1, 20], [480, 495]]；只在登录时有" }),
  bookmarked: z.boolean().optional().openapi({ description: "自己是否收藏了；只在登录时有" }),
  notify_level: z.string().optional().openapi({
    description:
      "自己的关注级别：watching 每个新楼层都通知，normal 回复我、@我时通知，muted 都不通知；只在登录时有",
  }),
}).openapi("ThreadDetail");

const PostSchema = z
  .object({
    id: z.number(),
    thread_id: z.number(),
    floor: z.number(),
    author: WriterSchema,
    html: z.string().optional().openapi({ description: "渲染好的正文；带 ?body=markdown 时没有" }),
    body: z.string().optional().openapi({ description: "Markdown 原文；只在 ?body=markdown 时有" }),
    via: z.string().openapi({ description: "web、bot 或 qq" }),
    reply_to: z.object({ id: z.number(), floor: z.number(), author: WriterSchema }).nullable(),
    reply_count: z.number(),
    like_count: z.number(),
    reactions: z
      .record(z.string(), z.number())
      .openapi({ description: '各表情的数量，例如 { heart: 2, "+1": 1 }' }),
    my_reaction: z.string().nullable().openapi({ description: "自己的表情回应；访客为 null" }),
    boosts: z.array(BoostSchema).openapi({ description: "最先留下的 6 条短评" }),
    boost_count: z.number(),
    my_boost: z.string().nullable().openapi({ description: "自己的短评；访客为 null" }),
    deleted: z.boolean().openapi({ description: "已删除的楼层保留楼层号，没有正文" }),
    members_only: z.boolean().openapi({
      description: "作者设置了不给访客看：访客拿到的这一层没有正文、表情和短评",
    }),
    status: z.string().openapi({
      description: "visible 公开；pending 待审核、hidden 已隐藏，这两种只有作者和版主看得到",
    }),
    edited_at: z.number().nullable(),
    created_at: z.number(),
  })
  .openapi("Post");

// Search engines' list of what to read: the home page, the public boards and their threads, as
// many as one sitemap holds. See design §8.5.
const SITEMAP_URLS = 50_000;

function sitemapEntry(path: string, changed?: Date) {
  const lastmod = changed ? `<lastmod>${changed.toISOString()}</lastmod>` : "";
  return `<url><loc>${env.PUBLIC_URL}${path}</loc>${lastmod}</url>`;
}

export async function serveSitemap(c: Context) {
  const boards = await listBoards(GUEST);
  const threads = await publicThreads(SITEMAP_URLS - 1 - boards.length);
  const urls = [
    sitemapEntry("/"),
    ...boards.map((b) => sitemapEntry(`/b/${b.slug}`)),
    ...threads.map((t) => sitemapEntry(`/t/${t.id}`, t.last_post_at)),
  ];
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
    200,
    { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  );
}

// Abuse limits on posting (design §13): generous for a person, and for a bot token across everyone
// it posts for, so a runaway plugin stops there.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const THREADS_PER_HOUR = 20;
const REPLIES_PER_10_MINUTES = 60;
const BOT_POSTS_PER_MINUTE = 120;

function limitBot(c: Context<AppEnv>) {
  const { bot } = c.var;
  if (bot) rateLimit(`bot:${bot.tokenId}`, BOT_POSTS_PER_MINUTE, MINUTE);
}

type Thread = Awaited<ReturnType<typeof getThread>>;

// Characters of the opening post in a thread's details, for the card a shared link shows.
const SHARE_EXCERPT = 100;
type Post = Awaited<ReturnType<typeof getPost>>;
type Extras = Awaited<ReturnType<typeof floorExtras>>;

function threadDetailJson(t: Thread, signedIn: boolean) {
  return {
    ...threadJson(t, signedIn),
    url: `${env.PUBLIC_URL}/t/${t.id}`,
    solved_floor: t.solved_floor,
    excerpt: excerpt(t.opening_html, SHARE_EXCERPT),
    status: t.status,
    author_anonymous: t.author_anonymous,
    anonymous_replies: t.anonymous_replies,
    poll: t.poll && pollJson(t.poll),
    ...(signedIn && {
      my_alias: t.my_alias,
      read_floors: t.read_floors,
      bookmarked: t.bookmarked_at !== null,
      notify_level: t.notify_level ?? "normal",
    }),
  };
}

// Only one form of the body travels: the HTML for pages, the Markdown for editing and for bots.
function postJson(p: Post, form: "html" | "markdown", extras: Extras) {
  const deleted = p.deleted_at !== null;
  const withheld = deleted || p.members_only;
  const text = withheld ? "" : form === "html" ? p.html : p.body;
  return {
    id: p.id,
    thread_id: p.thread_id,
    floor: p.floor,
    author: p.author,
    ...(form === "html" ? { html: text } : { body: text }),
    via: p.via,
    reply_to: p.reply_to,
    reply_count: p.reply_count,
    like_count: p.members_only ? 0 : p.like_count,
    reactions: p.members_only ? {} : p.reactions,
    my_reaction: extras.myReaction.get(p.id) ?? null,
    boosts: p.members_only ? [] : (extras.boosts.get(p.id) ?? []).map(boostJson),
    boost_count: p.members_only ? 0 : p.boost_count,
    my_boost: extras.myBoost.get(p.id) ?? null,
    deleted,
    members_only: p.members_only,
    status: p.status,
    edited_at: p.edited_at && unix(p.edited_at),
    created_at: unix(p.created_at),
  };
}

const IdParam = z.object({ id: z.coerce.number().int() });

const FLOOR_EVENTS = new Set(["post.created", "post.updated", "post.deleted"]);

// The floor one of these events is about, from either shape threads/events.ts writes.
const FloorEvent = z.union([
  z
    .object({ post: z.object({ floor: z.number() }), thread: z.object({ id: z.number() }) })
    .transform((e) => ({ floor: e.post.floor, thread_id: e.thread.id })),
  z.object({ floor: z.number(), thread_id: z.number() }),
]);

const BodyQuery = z.object({ body: z.enum(["html", "markdown"]).default("html") });

const Markdown = z
  .string()
  .max(MAX_BODY)
  .refine((s) => s.trim().length > 0, "正文不能为空");

const MarkdownContent = z.object({ markdown: Markdown });

const Status = z.enum(["visible", "hidden"]).openapi({
  description: "版主：visible 审核通过或恢复，hidden 隐藏",
});
const Reason = z
  .string()
  .trim()
  .max(200)
  .openapi({ description: "隐藏的理由，告诉作者，记进操作日志" });

const Content = z.union([
  MarkdownContent,
  z.object({
    onebot: z
      .array(z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) }))
      .min(1)
      .max(200)
      .openapi({ description: "OneBot v11 消息段，论坛转换成 Markdown" }),
  }),
]);

const Source = z
  .object({
    chat_type: z.enum(["group", "private"]),
    chat_id: z.number().int().positive(),
    message_id: z.number().int(),
  })
  .openapi("Source", { description: "内容来自哪条 QQ 消息" });

const Title = z.string().trim().min(4).max(80);

const PollInput = z
  .object({
    options: z
      .array(z.string().trim().min(1).max(50))
      .min(2)
      .max(20)
      .refine((o) => new Set(o).size === o.length, "选项不能重复"),
    multiple: z.boolean().default(false),
    max_choices: z
      .number()
      .int()
      .min(2)
      .nullable()
      .default(null)
      .openapi({ description: "多选时最多选几项；null 不限" }),
    anonymous: z.boolean().default(false).openapi({ description: "匿名投票" }),
    results: z.enum(["voted", "always"]).default("voted").openapi({
      description: "voted 投过票或结束后才看得到结果，always 随时公开",
    }),
    days: z
      .number()
      .int()
      .min(1)
      .max(30)
      .nullable()
      .default(null)
      .openapi({ description: "几天后截止；null 不限" }),
  })
  .refine((p) => p.max_choices === null || p.max_choices < p.options.length, {
    message: "最多选几项要少于选项数",
    path: ["max_choices"],
  })
  .openapi("PollInput", { description: "选项、单选还是多选、是否匿名发出后都不能改" });

const Tags = z
  .array(z.string())
  .max(5)
  .transform((t) => [...new Set(t)]);

const RevisionSchema = z
  .object({
    rev: z.number().openapi({ description: "第几次修改，从 1 开始" }),
    title: z.string().nullable().openapi({ description: "改标题时的旧标题" }),
    body: z.string().openapi({ description: "这次修改之前的 Markdown" }),
    editor: WriterSchema,
    created_at: z.number(),
  })
  .openapi("Revision");

function json<T extends z.ZodType>(schema: T) {
  return { required: true, content: { "application/json": { schema } } };
}

const threadResponse = {
  description: "帖子",
  content: { "application/json": { schema: ThreadDetailSchema } },
};

const postResponse = {
  description: "回复",
  content: { "application/json": { schema: PostSchema } },
};

// Lists of the reader's own, for someone signed in.
const OWN_VIEWS = new Set<ThreadView>(["new", "unread", "read", "posted", "bookmarked"]);

export const threadsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/threads",
      summary: "帖子列表",
      request: {
        query: z.object({
          board: z.string().optional(),
          tag: z.string().optional(),
          view: z.enum(VIEWS).default("latest").openapi({
            description:
              "latest 按最后回复，created 按发布时间，hot 热门，unsolved 待解答；要登录的：new 最近 7 天发布、自己没打开过，unread 读过、之后有新楼层，read 读过的、按最后阅读时间，posted 自己发过或回复过的，bookmarked 自己收藏的、按收藏时间",
          }),
          cursor: z.string().optional(),
        }),
      },
      responses: {
        200: {
          description: "每页最多 30 个；最新列表的第一页先列置顶的帖子",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(ThreadSchema),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        401: errorResponse("自己的列表要先登录"),
        403: errorResponse("等级不够看这个版块（level_required），message 里有要几级"),
        404: errorResponse("版块或标签不存在"),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const viewer = OWN_VIEWS.has(query.view) ? authorize(c, "read") : c.var.viewer;
      const page = await listThreads(reachOf(viewer, c.var.bot), viewer?.id ?? null, query);
      const items = page.items.map((t) => threadJson(t, viewer !== null));
      return c.json({ items, next_cursor: page.next_cursor }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}/threads",
      summary: "某人发过的帖子，最新的在前，每页 30 个",
      request: {
        params: z.object({ user: UserRefSchema }),
        query: z.object({ cursor: z.string().optional() }),
      },
      responses: {
        200: {
          description: "帖子",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(ThreadSchema),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const author = await findUserId(c.req.valid("param").user);
      const { viewer, bot } = c.var;
      const page = await listThreads(reachOf(viewer, bot), viewer?.id ?? null, {
        author,
        view: "created",
        cursor: c.req.valid("query").cursor,
      });
      const items = page.items.map((t) => threadJson(t, viewer !== null));
      return c.json({ items, next_cursor: page.next_cursor }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}/posts",
      summary: "某人的回复（不含主楼），最新的在前，每页 30 个，正文只带前 140 个字",
      request: {
        params: z.object({ user: UserRefSchema }),
        query: z.object({ cursor: z.coerce.number().int().optional() }),
      },
      responses: {
        200: {
          description: "回复",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    id: z.number(),
                    thread: z.object({ id: z.number(), title: z.string() }),
                    floor: z.number(),
                    excerpt: z.string().openapi({ description: "正文的纯文本，最多 140 个字" }),
                    like_count: z.number(),
                    created_at: z.number(),
                  }),
                ),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        404: errorResponse("用户不存在"),
      },
    }),
    async (c) => {
      const author = await findUserId(c.req.valid("param").user);
      const reach = reachOf(c.var.viewer, c.var.bot);
      const page = await listUserPosts(reach, author, c.req.valid("query").cursor);
      return c.json(
        {
          items: page.items.map((p) => ({
            id: p.id,
            thread: { id: p.thread_id, title: p.title },
            floor: p.floor,
            excerpt: p.excerpt,
            like_count: p.like_count,
            created_at: unix(p.created_at),
          })),
          next_cursor: page.next_cursor,
        },
        200,
      );
    },
  )
  // Before /threads/{id}, which would take "counts" for an ID.
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/counts",
      summary: "当前范围里新和未读的帖子各有几个，列表的标签页用",
      request: { query: z.object({ board: z.string().optional(), tag: z.string().optional() }) },
      responses: {
        200: {
          description: "数量",
          content: {
            "application/json": { schema: z.object({ new: z.number(), unread: z.number() }) },
          },
        },
        401: errorResponse("没有登录"),
        404: errorResponse("版块或标签不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "read");
      const reach = reachOf(viewer, c.var.bot);
      return c.json(await countUnread(reach, viewer.id, c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/{id}",
      summary: "帖子详情；楼层用 /threads/{id}/posts 取",
      request: { params: IdParam },
      responses: {
        200: threadResponse,
        401: errorResponse("楼主设置了不给访客看，访客要登录后查看"),
        403: errorResponse("等级不够看这个版块（level_required），message 里有要几级"),
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { viewer, bot } = c.var;
      const thread = await getThread(id, readerOf(c));
      // People reading, not bots fetching.
      // Requests from inside the server, such as the guest page cache refreshing a page, have
      // no reader to count.
      const reader = viewer ? `u${viewer.id}` : clientIp(c);
      if (!bot && reader !== null) recordView(id, reader);
      return c.json(threadDetailJson(thread, viewer !== null), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/{id}/stream",
      summary:
        "SSE：这个帖子的新楼层、编辑和删除，事件名同事件流（post.created 等），data 是楼层号",
      request: { params: IdParam },
      responses: {
        200: {
          description: "text/event-stream；每 20 秒一条心跳注释",
          content: { "text/event-stream": { schema: z.string() } },
        },
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await getThread(id, readerOf(c));
      const queue: { type: string; floor: number }[] = [];
      return liveStream(
        c,
        (changed) =>
          onEvent((event) => {
            if (!FLOOR_EVENTS.has(event.type)) return;
            const floor = FloorEvent.safeParse(event.data).data;
            if (floor?.thread_id !== id) return;
            queue.push({ type: event.type, floor: floor.floor });
            changed();
          }),
        async (stream) => {
          for (let e = queue.shift(); e; e = queue.shift()) {
            await stream.writeSSE({ event: e.type, data: String(e.floor) });
          }
        },
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/{id}/posts",
      summary: "楼层，按楼层号升序，每次最多 20 层；after 和 before 二选一，都不带时从主楼开始",
      request: {
        params: IdParam,
        query: BodyQuery.extend({
          after: z.coerce.number().int().min(0).optional(),
          before: z.coerce.number().int().min(1).optional(),
        }),
      },
      responses: {
        200: {
          description: "不足 20 层说明这个方向到头了",
          content: { "application/json": { schema: z.object({ items: z.array(PostSchema) }) } },
        },
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const { after, before, body } = c.req.valid("query");
      const range = before === undefined ? { after: after ?? 0 } : { before };
      const posts = await listPosts(c.req.valid("param").id, readerOf(c), range);
      const extras = await floorExtras(
        readerOf(c),
        posts.map((p) => p.id),
      );
      return c.json({ items: posts.map((p) => postJson(p, body, extras)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/posts/{id}",
      summary: "单条回复",
      request: { params: IdParam, query: BodyQuery },
      responses: { 200: postResponse, 404: errorResponse("回复不存在") },
    }),
    async (c) => {
      const post = await getPost(c.req.valid("param").id, readerOf(c));
      const extras = await floorExtras(readerOf(c), [post.id]);
      return c.json(postJson(post, c.req.valid("query").body, extras), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/posts/{id}/replies",
      summary: "回复这一条的楼层，按楼层号升序，每次最多 20 层；after 是上一批最后一层的楼层号",
      request: {
        params: IdParam,
        query: BodyQuery.extend({ after: z.coerce.number().int().min(0).default(0) }),
      },
      responses: {
        200: {
          description: "不足 20 层说明取完了",
          content: { "application/json": { schema: z.object({ items: z.array(PostSchema) }) } },
        },
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const { after, body } = c.req.valid("query");
      const replies = await listReplies(c.req.valid("param").id, readerOf(c), after);
      const extras = await floorExtras(
        readerOf(c),
        replies.map((p) => p.id),
      );
      return c.json({ items: replies.map((p) => postJson(p, body, extras)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads",
      summary: "发帖；kind 不带时用版块的默认类型",
      request: {
        body: json(
          z
            .object({
              board: z.string(),
              title: Title,
              content: Content,
              kind: z.enum(["discussion", "question", "poll"]).optional(),
              poll: PollInput.optional().openapi({ description: "投票帖必带，其他类型不能带" }),
              tags: Tags.default([]),
              source: Source.optional(),
              anonymous: z.boolean().optional().openapi({ description: "楼主匿名，发出后不能改" }),
              anonymous_replies: z
                .boolean()
                .optional()
                .openapi({ description: "楼主以外的人回复时匿名，发出后不能改" }),
            })
            .refine((b) => (b.kind === "poll") === (b.poll !== undefined), {
              message: "投票帖要带 poll，其他类型不能带",
              path: ["poll"],
            }),
        ),
      },
      responses: {
        201: threadResponse,
        400: errorResponse("标签不存在等"),
        403: errorResponse("不是成员，或者这个版块只有版主能发帖"),
        404: errorResponse("版块不存在"),
        409: errorResponse("这条 QQ 消息已经转到论坛了，附上已有的 thread_id 和 post_id"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      rateLimit(`thread:${viewer.id}`, THREADS_PER_HOUR, HOUR);
      limitBot(c);
      const reach = reachOf(viewer, c.var.bot);
      const thread = await createThread(actorOf(c, viewer), viewer, reach, c.req.valid("json"));
      return c.json(threadDetailJson(thread, true), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/posts",
      summary: "回复；reply_to_id 是回复同一帖子里的哪一条",
      request: {
        params: IdParam,
        body: json(
          z.object({
            content: Content,
            reply_to_id: z.number().int().optional(),
            source: Source.optional(),
          }),
        ),
      },
      responses: {
        201: postResponse,
        400: errorResponse("回复的那一层不在这个帖子里"),
        403: errorResponse("不是成员，或者帖子已锁定"),
        404: errorResponse("帖子不存在"),
        409: errorResponse("这条 QQ 消息已经转到论坛了，附上已有的 thread_id 和 post_id"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      rateLimit(`post:${viewer.id}`, REPLIES_PER_10_MINUTES, 10 * MINUTE);
      limitBot(c);
      const post = await createPost(
        actorOf(c, viewer),
        viewer,
        reachOf(viewer, c.var.bot),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(postJson(post, "html", await floorExtras(readerOf(c), [])), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/threads/{id}",
      summary: "修改帖子：作者可以改标题和标签；版主还可以移动版块、置顶、加精、锁定",
      request: {
        params: IdParam,
        body: json(
          z.object({
            title: Title.optional(),
            tags: Tags.optional(),
            board: z.string().optional(),
            pinned: z.number().int().min(0).max(2).optional(),
            featured: z.boolean().optional(),
            locked: z.boolean().optional(),
            status: Status.optional(),
            reason: Reason.optional(),
          }),
        ),
      },
      responses: {
        200: threadResponse,
        403: errorResponse("不是作者或版主，或者帖子已锁定"),
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      const { status, reason, ...change } = c.req.valid("json");
      const reach = reachOf(viewer, c.var.bot);
      const id = c.req.valid("param").id;
      if (status !== undefined) {
        authorize(c, "moderate");
        await setThreadStatus(actorOf(c, viewer), viewer, reach, id, status, reason ?? null);
      }
      const thread =
        Object.keys(change).length === 0
          ? await getThread(id, readerOf(c))
          : await editThread(actorOf(c, viewer), viewer, can(c, "moderate"), reach, id, change);
      return c.json(threadDetailJson(thread, true), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/threads/{id}",
      summary: "删除帖子；有人回复后作者不能删，只有版主能删",
      request: { params: IdParam },
      responses: {
        204: { description: "已删除" },
        403: errorResponse("不是作者或版主，或者已经有人回复"),
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const reach = reachOf(viewer, c.var.bot);
      const id = c.req.valid("param").id;
      await deleteThread(actorOf(c, viewer), viewer, can(c, "moderate"), reach, id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/posts/{id}",
      summary:
        "修改回复或主楼的正文，旧的正文进编辑记录；版主还可以审核通过、隐藏或恢复（主楼随帖子）",
      request: {
        params: IdParam,
        body: json(
          z
            .object({
              content: MarkdownContent.optional(),
              status: Status.optional(),
              reason: Reason.optional(),
            })
            .refine((b) => b.content || b.status, "content 和 status 至少带一个"),
        ),
      },
      responses: {
        200: postResponse,
        400: errorResponse("改的是主楼的状态"),
        403: errorResponse("不是作者或版主，或者帖子已锁定"),
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      const { content, status, reason } = c.req.valid("json");
      const reach = reachOf(viewer, c.var.bot);
      const id = c.req.valid("param").id;
      if (status !== undefined) {
        authorize(c, "moderate");
        await setPostStatus(actorOf(c, viewer), viewer, reach, id, status, reason ?? null);
      }
      if (content) {
        await editPost(actorOf(c, viewer), viewer, can(c, "moderate"), reach, id, content.markdown);
      }
      const post = await getPost(id, readerOf(c));
      return c.json(postJson(post, "html", await floorExtras(readerOf(c), [post.id])), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/posts/{id}",
      summary: "删除回复；楼层号保留，显示为已删除。主楼不能单独删除",
      request: { params: IdParam },
      responses: {
        204: { description: "已删除" },
        400: errorResponse("这是主楼"),
        403: errorResponse("不是作者或版主，或者帖子已锁定"),
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const reach = reachOf(viewer, c.var.bot);
      const id = c.req.valid("param").id;
      await deletePost(actorOf(c, viewer), viewer, can(c, "moderate"), reach, id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/posts/{id}/revisions",
      summary: "编辑记录，最近的在前",
      request: { params: IdParam },
      responses: {
        200: {
          description: "每次修改之前的版本",
          content: {
            "application/json": { schema: z.object({ items: z.array(RevisionSchema) }) },
          },
        },
        403: errorResponse("不是作者或版主"),
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "read");
      const revisions = await listRevisions(
        viewer,
        can(c, "moderate"),
        reachOf(viewer, c.var.bot),
        c.req.valid("param").id,
      );
      const items = revisions.map((r) => ({ ...r, created_at: unix(r.created_at) }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/{id}/aliases",
      summary:
        "匿名的人各是谁：编号和真实的用户。只有管理员能在网页上看，每次看都记操作日志（design §8.12）",
      request: { params: IdParam },
      responses: {
        200: {
          description: "按编号排",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(z.object({ number: z.number(), user: UserBriefSchema })),
              }),
            },
          },
        },
        403: errorResponse("不是管理员，或者不在网页上"),
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      requireWeb(c);
      const viewer = authorize(c, "admin");
      const items = await revealAliases(actorOf(c, viewer), c.req.valid("param").id);
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/read",
      summary: "记录阅读：读过的楼层区间并入已读，seconds 计入阅读时间，单次最多算 120 秒",
      description: "网页批量上报，见 docs/design.md §8.9。超出帖子楼层数的部分不算",
      request: {
        params: IdParam,
        body: json(
          z.object({
            floors: z
              .array(
                z
                  .tuple([z.number().int().min(1), z.number().int().min(1)])
                  .refine(([from, to]) => from <= to, "区间的起点不能大于终点"),
              )
              .max(100)
              .openapi({ description: "楼层区间，含两端，例如 [[1, 20], [480, 495]]" }),
            seconds: z.number().int().min(0).max(3600),
          }),
        ),
      },
      responses: {
        204: { description: "已记录" },
        401: errorResponse("没有登录"),
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const viewer = requireWeb(c);
      const { floors, seconds } = c.req.valid("json");
      const reach = reachOf(viewer, c.var.bot);
      await recordReading(viewer, reach, c.req.valid("param").id, floors, seconds);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/content",
      summary: "待审核或已隐藏的内容，最新的在前，每页 30 条；帖子以主楼出现",
      request: {
        query: z.object({
          status: z.enum(["pending", "hidden"]).default("pending"),
          cursor: z.coerce.number().int().optional(),
        }),
      },
      responses: {
        200: {
          description: "内容",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    id: z.number(),
                    floor: z.number(),
                    thread_id: z.number(),
                    title: z.string(),
                    board: z.object({ slug: z.string(), name: z.string() }),
                    author: WriterSchema,
                    excerpt: z.string(),
                    created_at: z.number(),
                  }),
                ),
                next_cursor: z.string().nullable(),
              }),
            },
          },
        },
        403: errorResponse("不是版主"),
      },
    }),
    async (c) => {
      authorize(c, "moderate");
      const { status, cursor } = c.req.valid("query");
      const page = await listModerated(status, cursor);
      return c.json(
        {
          items: page.items.map(({ board_slug, board_name, created_at, ...r }) => ({
            ...r,
            board: { slug: board_slug, name: board_name },
            created_at: unix(created_at),
          })),
          next_cursor: page.next_cursor,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/threads/{id}/solution",
      summary: "采纳答案：问答帖子里没删的一层回复；再采纳别的就换掉",
      request: { params: IdParam, body: json(z.object({ post_id: z.number().int() })) },
      responses: {
        200: threadResponse,
        400: errorResponse("不是问答帖子，或者这一层不能采纳"),
        403: errorResponse("不是楼主或版主，或者帖子已锁定"),
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const thread = await setSolution(
        actorOf(c, viewer),
        viewer,
        can(c, "moderate"),
        reachOf(viewer, c.var.bot),
        c.req.valid("param").id,
        c.req.valid("json").post_id,
      );
      return c.json(threadDetailJson(thread, true), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/threads/{id}/solution",
      summary: "取消采纳",
      request: { params: IdParam },
      responses: {
        200: threadResponse,
        400: errorResponse("不是问答帖子"),
        403: errorResponse("不是楼主或版主，或者帖子已锁定"),
        404: errorResponse("帖子不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const thread = await setSolution(
        actorOf(c, viewer),
        viewer,
        can(c, "moderate"),
        reachOf(viewer, c.var.bot),
        c.req.valid("param").id,
        null,
      );
      return c.json(threadDetailJson(thread, true), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/threads/{id}/bookmark",
      summary: "收藏帖子；已经收藏的不变",
      request: { params: IdParam },
      responses: { 204: { description: "已收藏" }, 404: errorResponse("帖子不存在") },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      await setBookmark(viewer, reachOf(viewer, c.var.bot), c.req.valid("param").id, true);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/threads/{id}/bookmark",
      summary: "取消收藏",
      request: { params: IdParam },
      responses: { 204: { description: "已取消" }, 404: errorResponse("帖子不存在") },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      await setBookmark(viewer, reachOf(viewer, c.var.bot), c.req.valid("param").id, false);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/threads/{id}/subscription",
      summary: "关注级别：watching 每个新楼层都通知，normal 回复我、@我时通知，muted 都不通知",
      request: { params: IdParam, body: json(z.object({ level: z.enum(NOTIFY_LEVELS) })) },
      responses: { 204: { description: "已设置" }, 404: errorResponse("帖子不存在") },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const { id } = c.req.valid("param");
      await setNotifyLevel(viewer, reachOf(viewer, c.var.bot), id, c.req.valid("json").level);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/preview",
      summary: "预览：把 Markdown 渲染成发布后的 HTML，编辑器边写边看",
      request: { body: json(z.object({ markdown: z.string().max(MAX_BODY) })) },
      responses: {
        200: {
          description: "渲染结果",
          content: { "application/json": { schema: z.object({ html: z.string() }) } },
        },
        403: errorResponse("不是成员"),
        429: errorResponse("预览太频繁"),
      },
    }),
    async (c) => {
      const viewer = authorizePosting(c);
      rateLimit(`preview:${viewer.id}`, 120, 60_000);
      const { html } = await renderMarkdown(c.req.valid("json").markdown, showImages);
      return c.json({ html }, 200);
    },
  );
