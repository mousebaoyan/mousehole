import { createRoute, z } from "@hono/zod-openapi";
import { isMember } from "../../platform/access.ts";
import { env } from "../../platform/env.ts";
import {
  actorOf,
  authorize,
  can,
  clientIp,
  createRouter,
  errorResponse,
  requireWeb,
  unix,
} from "../../platform/http.ts";
import { renderMarkdown } from "../../platform/markdown.ts";
import { liveStream } from "../../platform/sse.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import { onEvent } from "../events/service.ts";
import { BoostSchema, boostJson } from "../reactions/schemas.ts";
import { floorExtras } from "../reactions/service.ts";
import { showImages } from "../uploads/service.ts";
import { UserBriefSchema, UserRefSchema } from "../users/schemas.ts";
import { threadJson, ThreadSchema } from "./schemas.ts";
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
  listThreads,
  listUserPosts,
  MAX_BODY,
  NOTIFY_LEVELS,
  recordReading,
  recordView,
  setBookmark,
  setNotifyLevel,
  setSolution,
  VIEWS,
  type ThreadView,
} from "./service.ts";

const ThreadDetailSchema = ThreadSchema.extend({
  url: z.string(),
  solved_floor: z.number().nullable().openapi({ description: "采纳的回答在第几楼" }),
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
    author: UserBriefSchema,
    html: z.string().optional().openapi({ description: "渲染好的正文；带 ?body=markdown 时没有" }),
    body: z.string().optional().openapi({ description: "Markdown 原文；只在 ?body=markdown 时有" }),
    via: z.string().openapi({ description: "web、bot 或 qq" }),
    reply_to: z.object({ id: z.number(), floor: z.number(), author: UserBriefSchema }).nullable(),
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
    edited_at: z.number().nullable(),
    created_at: z.number(),
  })
  .openapi("Post");

type Thread = Awaited<ReturnType<typeof getThread>>;
type Post = Awaited<ReturnType<typeof getPost>>;
type Extras = Awaited<ReturnType<typeof floorExtras>>;

function threadDetailJson(t: Thread, signedIn: boolean) {
  return {
    ...threadJson(t, signedIn),
    url: `${env.PUBLIC_URL}/t/${t.id}`,
    solved_floor: t.solved_floor,
    ...(signedIn && {
      read_floors: t.read_floors,
      bookmarked: t.bookmarked_at !== null,
      notify_level: t.notify_level ?? "normal",
    }),
  };
}

// Only one form of the body travels: the HTML for pages, the Markdown for editing and for bots.
function postJson(p: Post, form: "html" | "markdown", extras: Extras) {
  const deleted = p.deleted_at !== null;
  const text = deleted ? "" : form === "html" ? p.html : p.body;
  return {
    id: p.id,
    thread_id: p.thread_id,
    floor: p.floor,
    author: p.author,
    ...(form === "html" ? { html: text } : { body: text }),
    via: p.via,
    reply_to: p.reply_to,
    reply_count: p.reply_count,
    like_count: p.like_count,
    reactions: p.reactions,
    my_reaction: extras.myReaction.get(p.id) ?? null,
    boosts: (extras.boosts.get(p.id) ?? []).map(boostJson),
    boost_count: p.boost_count,
    my_boost: extras.myBoost.get(p.id) ?? null,
    deleted,
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

const Tags = z
  .array(z.string())
  .max(5)
  .transform((t) => [...new Set(t)]);

const RevisionSchema = z
  .object({
    rev: z.number().openapi({ description: "第几次修改，从 1 开始" }),
    title: z.string().nullable().openapi({ description: "改标题时的旧标题" }),
    body: z.string().openapi({ description: "这次修改之前的 Markdown" }),
    editor: UserBriefSchema,
    created_at: z.number(),
  })
  .openapi("Revision");

function json<T extends z.ZodType>(schema: T) {
  return { required: true, content: { "application/json": { schema } } };
}

const threadResponse = {
  description: "主题",
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
      summary: "主题列表",
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
          description: "每页最多 30 个；最新列表的第一页先列置顶的主题",
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
        404: errorResponse("版块或标签不存在"),
      },
    }),
    async (c) => {
      const query = c.req.valid("query");
      const viewer = OWN_VIEWS.has(query.view) ? authorize(c, "read") : c.var.viewer;
      const page = await listThreads(isMember(viewer, c.var.bot), viewer?.id ?? null, query);
      const items = page.items.map((t) => threadJson(t, viewer !== null));
      return c.json({ items, next_cursor: page.next_cursor }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/users/{user}/threads",
      summary: "某人发过的主题，最新的在前，每页 30 个",
      request: {
        params: z.object({ user: UserRefSchema }),
        query: z.object({ cursor: z.string().optional() }),
      },
      responses: {
        200: {
          description: "主题",
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
      const page = await listThreads(isMember(viewer, bot), viewer?.id ?? null, {
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
      const members = isMember(c.var.viewer, c.var.bot);
      const page = await listUserPosts(members, author, c.req.valid("query").cursor);
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
      summary: "当前范围里新和未读的主题各有几个，列表的标签页用",
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
      const members = isMember(viewer, c.var.bot);
      return c.json(await countUnread(members, viewer.id, c.req.valid("query")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/{id}",
      summary: "主题详情；楼层用 /threads/{id}/posts 取",
      request: { params: IdParam },
      responses: { 200: threadResponse, 404: errorResponse("主题不存在") },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { viewer, bot } = c.var;
      const thread = await getThread(id, isMember(viewer, bot), viewer?.id ?? null);
      // People reading, not bots fetching.
      if (!bot) recordView(id, viewer ? `u${viewer.id}` : (clientIp(c) ?? ""));
      return c.json(threadDetailJson(thread, viewer !== null), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/threads/{id}/stream",
      summary:
        "SSE：这个主题的新楼层、编辑和删除，事件名同事件流（post.created 等），data 是楼层号",
      request: { params: IdParam },
      responses: {
        200: {
          description: "text/event-stream；每 20 秒一条心跳注释",
          content: { "text/event-stream": { schema: z.string() } },
        },
        404: errorResponse("主题不存在"),
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await getThread(id, isMember(c.var.viewer, c.var.bot), null);
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
        404: errorResponse("主题不存在"),
      },
    }),
    async (c) => {
      const { after, before, body } = c.req.valid("query");
      const members = isMember(c.var.viewer, c.var.bot);
      const range = before === undefined ? { after: after ?? 0 } : { before };
      const posts = await listPosts(c.req.valid("param").id, members, range);
      const extras = await floorExtras(
        c.var.viewer?.id ?? null,
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
      const post = await getPost(c.req.valid("param").id, isMember(c.var.viewer, c.var.bot));
      const extras = await floorExtras(c.var.viewer?.id ?? null, [post.id]);
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
      const members = isMember(c.var.viewer, c.var.bot);
      const replies = await listReplies(c.req.valid("param").id, members, after);
      const extras = await floorExtras(
        c.var.viewer?.id ?? null,
        replies.map((p) => p.id),
      );
      return c.json({ items: replies.map((p) => postJson(p, body, extras)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads",
      summary: "发主题；kind 不带时用版块的默认类型",
      request: {
        body: json(
          z.object({
            board: z.string(),
            title: Title,
            content: Content,
            kind: z.enum(["discussion", "question"]).optional(),
            tags: Tags.default([]),
            source: Source.optional(),
          }),
        ),
      },
      responses: {
        201: threadResponse,
        400: errorResponse("标签不存在等"),
        403: errorResponse("不是成员，或者这个版块只有版主能发主题"),
        404: errorResponse("版块不存在"),
        409: errorResponse("这条 QQ 消息已经转到论坛了，附上已有的 thread_id 和 post_id"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const members = isMember(viewer, c.var.bot);
      const thread = await createThread(actorOf(c, viewer), viewer, members, c.req.valid("json"));
      return c.json(threadDetailJson(thread, true), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/posts",
      summary: "回复；reply_to_id 是回复同一主题里的哪一条",
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
        400: errorResponse("回复的那一层不在这个主题里"),
        403: errorResponse("不是成员，或者主题已锁定"),
        404: errorResponse("主题不存在"),
        409: errorResponse("这条 QQ 消息已经转到论坛了，附上已有的 thread_id 和 post_id"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const post = await createPost(
        actorOf(c, viewer),
        viewer,
        isMember(viewer, c.var.bot),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(postJson(post, "html", await floorExtras(null, [])), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/threads/{id}",
      summary: "修改主题：作者可以改标题和标签；版主还可以移动版块、置顶、加精、锁定",
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
          }),
        ),
      },
      responses: {
        200: threadResponse,
        403: errorResponse("不是作者或版主，或者主题已锁定"),
        404: errorResponse("主题不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const thread = await editThread(
        actorOf(c, viewer),
        viewer,
        can(c, "moderate"),
        isMember(viewer, c.var.bot),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(threadDetailJson(thread, true), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/threads/{id}",
      summary: "删除主题；有人回复后作者不能删，只有版主能删",
      request: { params: IdParam },
      responses: {
        204: { description: "已删除" },
        403: errorResponse("不是作者或版主，或者已经有人回复"),
        404: errorResponse("主题不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const members = isMember(viewer, c.var.bot);
      const id = c.req.valid("param").id;
      await deleteThread(actorOf(c, viewer), viewer, can(c, "moderate"), members, id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/posts/{id}",
      summary: "修改回复或主楼的正文，旧的正文进编辑记录",
      request: { params: IdParam, body: json(z.object({ content: MarkdownContent })) },
      responses: {
        200: postResponse,
        403: errorResponse("不是作者或版主，或者主题已锁定"),
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const post = await editPost(
        actorOf(c, viewer),
        viewer,
        can(c, "moderate"),
        isMember(viewer, c.var.bot),
        c.req.valid("param").id,
        c.req.valid("json").content.markdown,
      );
      return c.json(postJson(post, "html", await floorExtras(viewer.id, [post.id])), 200);
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
        403: errorResponse("不是作者或版主，或者主题已锁定"),
        404: errorResponse("回复不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const members = isMember(viewer, c.var.bot);
      const id = c.req.valid("param").id;
      await deletePost(actorOf(c, viewer), viewer, can(c, "moderate"), members, id);
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
        isMember(viewer, c.var.bot),
        c.req.valid("param").id,
      );
      const items = revisions.map((r) => ({ ...r, created_at: unix(r.created_at) }));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/read",
      summary: "记录阅读：读过的楼层区间并入已读，seconds 计入阅读时间，单次最多算 120 秒",
      description: "网页批量上报，见 docs/design.md §8.9。超出主题楼层数的部分不算",
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
        404: errorResponse("主题不存在"),
      },
    }),
    async (c) => {
      const viewer = requireWeb(c);
      const { floors, seconds } = c.req.valid("json");
      const members = isMember(viewer, c.var.bot);
      await recordReading(viewer, members, c.req.valid("param").id, floors, seconds);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/threads/{id}/solution",
      summary: "采纳答案：问答主题里没删的一层回复；再采纳别的就换掉",
      request: { params: IdParam, body: json(z.object({ post_id: z.number().int() })) },
      responses: {
        200: threadResponse,
        400: errorResponse("不是问答主题，或者这一层不能采纳"),
        403: errorResponse("不是主题作者或版主，或者主题已锁定"),
        404: errorResponse("主题不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const thread = await setSolution(
        actorOf(c, viewer),
        viewer,
        can(c, "moderate"),
        isMember(viewer, c.var.bot),
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
        400: errorResponse("不是问答主题"),
        403: errorResponse("不是主题作者或版主，或者主题已锁定"),
        404: errorResponse("主题不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const thread = await setSolution(
        actorOf(c, viewer),
        viewer,
        can(c, "moderate"),
        isMember(viewer, c.var.bot),
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
      summary: "收藏主题；已经收藏的不变",
      request: { params: IdParam },
      responses: { 204: { description: "已收藏" }, 404: errorResponse("主题不存在") },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      await setBookmark(viewer, isMember(viewer, c.var.bot), c.req.valid("param").id, true);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/threads/{id}/bookmark",
      summary: "取消收藏",
      request: { params: IdParam },
      responses: { 204: { description: "已取消" }, 404: errorResponse("主题不存在") },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      await setBookmark(viewer, isMember(viewer, c.var.bot), c.req.valid("param").id, false);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/threads/{id}/subscription",
      summary: "关注级别：watching 每个新楼层都通知，normal 回复我、@我时通知，muted 都不通知",
      request: { params: IdParam, body: json(z.object({ level: z.enum(NOTIFY_LEVELS) })) },
      responses: { 204: { description: "已设置" }, 404: errorResponse("主题不存在") },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const { id } = c.req.valid("param");
      await setNotifyLevel(viewer, isMember(viewer, c.var.bot), id, c.req.valid("json").level);
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
      const viewer = authorize(c, "act");
      rateLimit(`preview:${viewer.id}`, 120, 60_000);
      const { html } = await renderMarkdown(c.req.valid("json").markdown, showImages);
      return c.json({ html }, 200);
    },
  );
