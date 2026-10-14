import { createRoute, z } from "@hono/zod-openapi";
import { isMember } from "../../platform/access.ts";
import { actorOf, authorize, createRouter, errorResponse } from "../../platform/http.ts";
import {
  createBoard,
  createTag,
  deleteBoard,
  deleteTag,
  getBoard,
  listBoards,
  listTags,
  mergeTag,
  updateBoard,
  updateTag,
} from "./service.ts";

const BoardSchema = z
  .object({
    id: z.number(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    color: z.string(),
    visibility: z.string().openapi({ description: "public：公开；members：仅成员" }),
    post_role: z.string().openapi({ description: "谁能发帖。user：成员；moderator：版主" }),
    default_kind: z.string().openapi({ description: "发帖时默认的类型：discussion 或 question" }),
    review_mode: z.string().openapi({
      description: "after：先发后审；before：先审后发，版主以外的人发的内容通过审核才公开",
    }),
    thread_count: z.number(),
  })
  .openapi("Board");

const TagSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    kind: z.string().openapi({ description: "topic：话题；school：院校；major：方向" }),
    thread_count: z.number(),
  })
  .openapi("Tag");

const BoardFields = z.object({
  name: z.string().trim().min(1).max(20),
  description: z.string().trim().max(100),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "颜色要写成 #rrggbb")
    .transform((c) => c.toLowerCase()),
  visibility: z.enum(["public", "members"]),
  post_role: z.enum(["user", "moderator"]),
  default_kind: z.enum(["discussion", "question"]),
  review_mode: z.enum(["after", "before"]),
});

const TagFields = z.object({
  name: z.string().trim().min(1).max(20),
  kind: z.enum(["topic", "school", "major"]),
});

const SlugParam = z.object({ slug: z.string() });
const IdParam = z.object({ id: z.coerce.number().int() });

function json<T extends z.ZodType>(schema: T) {
  return { required: true, content: { "application/json": { schema } } };
}

const boardResponse = {
  description: "版块",
  content: { "application/json": { schema: BoardSchema } },
};

const tagResponse = {
  description: "标签",
  content: { "application/json": { schema: TagSchema } },
};

export const boardsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/boards",
      summary: "版块列表，按后台排好的顺序；访客看不到仅成员版块",
      responses: {
        200: {
          description: "全部版块",
          content: {
            "application/json": { schema: z.object({ items: z.array(BoardSchema) }) },
          },
        },
      },
    }),
    async (c) => {
      const items = await listBoards(isMember(c.var.viewer, c.var.bot));
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/boards/{slug}",
      summary: "版块信息",
      request: { params: SlugParam },
      responses: { 200: boardResponse, 404: errorResponse("版块不存在，或者访客看仅成员版块") },
    }),
    async (c) => {
      const board = await getBoard(c.req.valid("param").slug, isMember(c.var.viewer, c.var.bot));
      return c.json(board, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/boards",
      summary: "新建版块，排在最后",
      request: {
        body: json(
          BoardFields.partial().extend({
            slug: z
              .string()
              .regex(/^[a-z][a-z0-9-]{0,31}$/, "地址只能用小写字母、数字和短横线，以字母开头"),
            name: BoardFields.shape.name,
          }),
        ),
      },
      responses: {
        201: boardResponse,
        403: errorResponse("不是管理员"),
        409: errorResponse("这个地址已经有版块在用了"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      return c.json(await createBoard(actorOf(c, viewer), c.req.valid("json")), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/boards/{slug}",
      summary: "修改版块；只改带了的字段。position 把版块移到第几位（从 0 开始），其他版块依次顺延",
      request: {
        params: SlugParam,
        body: json(BoardFields.partial().extend({ position: z.number().int().min(0).optional() })),
      },
      responses: {
        200: boardResponse,
        403: errorResponse("不是管理员"),
        404: errorResponse("版块不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      const { slug } = c.req.valid("param");
      return c.json(await updateBoard(actorOf(c, viewer), slug, c.req.valid("json")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/boards/{slug}",
      summary: "删除版块；只能删从来没有过帖子的版块",
      request: { params: SlugParam },
      responses: {
        204: { description: "已删除" },
        403: errorResponse("不是管理员"),
        404: errorResponse("版块不存在"),
        409: errorResponse("版块里有过帖子"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      await deleteBoard(actorOf(c, viewer), c.req.valid("param").slug);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/tags",
      summary: "标签列表：话题、院校、方向依次排列，同一类里用得多的在前",
      responses: {
        200: {
          description: "全部标签",
          content: { "application/json": { schema: z.object({ items: z.array(TagSchema) }) } },
        },
      },
    }),
    async (c) => c.json({ items: await listTags() }, 200),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/tags",
      summary: "新建标签",
      request: { body: json(TagFields) },
      responses: {
        201: tagResponse,
        403: errorResponse("不是版主"),
        409: errorResponse("已经有这个标签了"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      return c.json(await createTag(actorOf(c, viewer), c.req.valid("json")), 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/tags/{id}",
      summary: "改名、改类别；只改带了的字段",
      request: { params: IdParam, body: json(TagFields.partial()) },
      responses: {
        200: tagResponse,
        403: errorResponse("不是版主"),
        404: errorResponse("标签不存在"),
        409: errorResponse("新名字已经有标签在用了，可以合并过去"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      const { id } = c.req.valid("param");
      return c.json(await updateTag(actorOf(c, viewer), id, c.req.valid("json")), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/tags/{id}/merge",
      summary: "合并到另一个标签：帖子都改用那个标签，这个标签删除",
      request: { params: IdParam, body: json(z.object({ into: z.number().int() })) },
      responses: {
        200: { ...tagResponse, description: "合并后的标签" },
        403: errorResponse("不是版主"),
        404: errorResponse("标签不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      const { id } = c.req.valid("param");
      return c.json(await mergeTag(actorOf(c, viewer), id, c.req.valid("json").into), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/tags/{id}",
      summary: "删除标签，帖子上的这个标签一并去掉",
      request: { params: IdParam },
      responses: {
        204: { description: "已删除" },
        403: errorResponse("不是版主"),
        404: errorResponse("标签不存在"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "moderate");
      await deleteTag(actorOf(c, viewer), c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
