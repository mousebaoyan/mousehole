import { createRoute, z } from "@hono/zod-openapi";
import { isMember } from "../../platform/access.ts";
import { env } from "../../platform/env.ts";
import {
  actorOf,
  authorize,
  clientIp,
  createRouter,
  errorResponse,
  unix,
} from "../../platform/http.ts";
import { renderMarkdown } from "../../platform/markdown.ts";
import { rateLimit } from "../../platform/rate-limit.ts";
import {
  createPost,
  createThread,
  getPost,
  getThread,
  listPosts,
  listThreads,
  recordView,
} from "./service.ts";

// Longest Markdown a post may have.
const MAX_BODY = 30_000;

const UserBriefSchema = z
  .object({
    id: z.number(),
    display_name: z.string(),
    role: z.string(),
    level: z.number().nullable(),
    title: z.string().openapi({ description: "主群里的专属头衔，没有为空字符串" }),
  })
  .openapi("UserBrief");

const ThreadSchema = z
  .object({
    id: z.number(),
    board: z.object({ slug: z.string(), name: z.string(), color: z.string() }),
    kind: z.string().openapi({ description: "discussion：讨论；question：问答" }),
    title: z.string(),
    author: UserBriefSchema,
    posters: z.array(UserBriefSchema).openapi({ description: "作者以外最近回复的最多 4 个人" }),
    tags: z.array(z.string()),
    pinned: z.number().openapi({ description: "0：不置顶；1：版块内置顶；2：全站置顶" }),
    featured: z.boolean(),
    locked: z.boolean(),
    solved_post_id: z.number().nullable(),
    reply_count: z.number(),
    floor_count: z.number(),
    view_count: z.number(),
    like_count: z.number(),
    last_post_at: z.number(),
    created_at: z.number(),
  })
  .openapi("Thread");

const ThreadDetailSchema = ThreadSchema.extend({ url: z.string() }).openapi("ThreadDetail");

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
    deleted: z.boolean().openapi({ description: "已删除的楼层保留楼层号，没有正文" }),
    edited_at: z.number().nullable(),
    created_at: z.number(),
  })
  .openapi("Post");

type Thread = Awaited<ReturnType<typeof getThread>>;
type Post = Awaited<ReturnType<typeof getPost>>;

function threadJson(t: Thread) {
  return {
    id: t.id,
    board: { slug: t.board_slug, name: t.board_name, color: t.board_color },
    kind: t.kind,
    title: t.title,
    author: t.author,
    posters: t.posters,
    tags: t.tags,
    pinned: t.pinned,
    featured: t.featured,
    locked: t.locked,
    solved_post_id: t.solved_post_id,
    reply_count: t.reply_count,
    floor_count: t.floor_count,
    view_count: t.view_count,
    like_count: t.like_count,
    last_post_at: unix(t.last_post_at),
    created_at: unix(t.created_at),
  };
}

function threadDetailJson(t: Thread) {
  return { ...threadJson(t), url: `${env.PUBLIC_URL}/t/${t.id}` };
}

// Only one form of the body travels: the HTML for pages, the Markdown for editing and for bots.
function postJson(p: Post, form: "html" | "markdown") {
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
    deleted,
    edited_at: p.edited_at && unix(p.edited_at),
    created_at: unix(p.created_at),
  };
}

const IdParam = z.object({ id: z.coerce.number().int() });
const BodyQuery = z.object({ body: z.enum(["html", "markdown"]).default("html") });

const Markdown = z
  .string()
  .max(MAX_BODY)
  .refine((s) => s.trim().length > 0, "正文不能为空");

// Only Markdown for now; QQ message segments come with the bot's message conversion.
const Content = z.object({ markdown: Markdown });

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
          view: z.enum(["latest", "created", "hot", "unsolved"]).default("latest"),
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
        404: errorResponse("版块或标签不存在"),
      },
    }),
    async (c) => {
      const page = await listThreads(isMember(c.var.viewer, c.var.bot), c.req.valid("query"));
      return c.json({ items: page.items.map(threadJson), next_cursor: page.next_cursor }, 200);
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
      const thread = await getThread(id, isMember(c.var.viewer, c.var.bot));
      // People reading, not bots fetching.
      if (!c.var.bot) recordView(id, c.var.viewer ? `u${c.var.viewer.id}` : (clientIp(c) ?? ""));
      return c.json(threadDetailJson(thread), 200);
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
      return c.json({ items: posts.map((p) => postJson(p, body)) }, 200);
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
      return c.json(postJson(post, c.req.valid("query").body), 200);
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
            title: z.string().trim().min(4).max(80),
            content: Content,
            kind: z.enum(["discussion", "question"]).optional(),
            tags: z
              .array(z.string())
              .max(5)
              .default([])
              .transform((t) => [...new Set(t)]),
          }),
        ),
      },
      responses: {
        201: threadResponse,
        400: errorResponse("标签不存在等"),
        403: errorResponse("不是成员，或者这个版块只有版主能发主题"),
        404: errorResponse("版块不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const { content, ...input } = c.req.valid("json");
      const thread = await createThread(actorOf(c, viewer), viewer, isMember(viewer, c.var.bot), {
        ...input,
        markdown: content.markdown,
      });
      return c.json(threadDetailJson(thread), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/threads/{id}/posts",
      summary: "回复；reply_to_id 是回复同一主题里的哪一条",
      request: {
        params: IdParam,
        body: json(z.object({ content: Content, reply_to_id: z.number().int().optional() })),
      },
      responses: {
        201: postResponse,
        400: errorResponse("回复的那一层不在这个主题里"),
        403: errorResponse("不是成员，或者主题已锁定"),
        404: errorResponse("主题不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "act");
      const { content, reply_to_id } = c.req.valid("json");
      const post = await createPost(
        actorOf(c, viewer),
        viewer,
        isMember(viewer, c.var.bot),
        c.req.valid("param").id,
        { markdown: content.markdown, reply_to_id },
      );
      return c.json(postJson(post, "html"), 201);
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
      const { html } = await renderMarkdown(c.req.valid("json").markdown);
      return c.json({ html }, 200);
    },
  );
