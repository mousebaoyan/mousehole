import { createRoute, z } from "@hono/zod-openapi";
import { actorOf, authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { linkGroup, listGroups, syncMembers, updateGroup, updateGroupInfo } from "./service.ts";

// A clock far ahead would make every later push look stale, so it is refused at the door.
const MAX_CLOCK_AHEAD_S = 10 * 60;

const ObservedAt = z
  .number()
  .int()
  .positive()
  .refine(
    (t) => t <= Date.now() / 1000 + MAX_CLOCK_AHEAD_S,
    "比服务器时间晚太多，请检查插件所在机器的时钟",
  )
  .transform((t) => new Date(t * 1000));

// NapCat's fields; anything else in a record is dropped. See docs/api.md §4.2.
const MemberRecordSchema = z.object({
  user_id: z.number().int().positive(),
  nickname: z.string().optional(),
  card: z.string().optional(),
  role: z.enum(["owner", "admin", "member"]).optional(),
  title: z.string().optional(),
  // NapCat gives the group level as a string.
  level: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      const digits = /\d+/.exec(String(v))?.[0];
      return digits === undefined ? null : Number(digits);
    }),
  join_time: z.number().int().nonnegative().optional(),
  last_sent_time: z.number().int().nonnegative().optional(),
  is_robot: z.boolean().optional(),
  in_group: z.boolean().optional(),
  left_reason: z.enum(["leave", "kick"]).optional(),
});

const SyncBody = {
  required: true,
  content: {
    "application/json": {
      schema: z.object({ observed_at: ObservedAt, members: z.array(MemberRecordSchema).max(5000) }),
    },
  },
};

const SyncCountsSchema = z
  .object({
    joined: z.number(),
    left: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    stale: z.number(),
    held: z.boolean(),
  })
  .openapi("SyncCounts");

const GroupParam = z.object({ group_id: z.coerce.number().int().positive() });

const time = (date: Date | null) => date && unix(date);

const syncResponses = {
  200: {
    description: "各类数量",
    content: { "application/json": { schema: SyncCountsSchema } },
  },
  403: errorResponse("token 没有 sync 范围"),
  404: errorResponse("这个群还没有在后台关联"),
};

const GroupSchema = z
  .object({
    group_id: z.number(),
    name: z.string(),
    member_count: z.number().nullable(),
    max_member_count: z.number().nullable(),
    is_primary: z.boolean(),
    enabled: z.boolean(),
    info_synced_at: z.number().nullable(),
    full_synced_at: z.number().nullable(),
    delta_synced_at: z.number().nullable(),
    shrink_held_at: z.number().nullable(),
  })
  .openapi("Group");

async function groups(enabledOnly: boolean) {
  const rows = await listGroups(enabledOnly);
  return rows.map((g) => ({
    group_id: g.id,
    name: g.name,
    member_count: g.member_count,
    max_member_count: g.max_member_count,
    is_primary: g.is_primary,
    enabled: g.enabled,
    info_synced_at: time(g.info_synced_at),
    full_synced_at: time(g.full_synced_at),
    delta_synced_at: time(g.delta_synced_at),
    shrink_held_at: time(g.shrink_held_at),
  }));
}

const groupsResponse = {
  description: "主群在前",
  content: { "application/json": { schema: z.object({ items: z.array(GroupSchema) }) } },
};

export const membersRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/bot/groups",
      summary: "已关联且启用的群，附各自最近一次同步的时间",
      responses: { 200: groupsResponse, 403: errorResponse("token 没有 sync 范围") },
    }),
    async (c) => {
      authorize(c, "sync");
      return c.json({ items: await groups(true) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/bot/groups/{group_id}/info",
      summary: "推送群资料：get_group_info 的返回加上 observed_at",
      request: {
        params: GroupParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                observed_at: ObservedAt,
                group_name: z.string().optional(),
                member_count: z.number().int().nonnegative().optional(),
                max_member_count: z.number().int().nonnegative().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "stale 为 true 表示比已有的数据旧，被忽略",
          content: { "application/json": { schema: z.object({ stale: z.boolean() }) } },
        },
        403: errorResponse("token 没有 sync 范围"),
        404: errorResponse("这个群还没有在后台关联"),
      },
    }),
    async (c) => {
      authorize(c, "sync");
      const body = c.req.valid("json");
      const result = await updateGroupInfo(c.req.valid("param").group_id, body.observed_at, {
        name: body.group_name,
        memberCount: body.member_count,
        maxMemberCount: body.max_member_count,
      });
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/bot/groups/{group_id}/members",
      summary: "全量同步成员：members 是完整名单",
      request: { params: GroupParam, body: SyncBody },
      responses: syncResponses,
    }),
    async (c) => {
      const viewer = authorize(c, "sync");
      const { observed_at, members } = c.req.valid("json");
      const counts = await syncMembers(actorOf(c, viewer), c.req.valid("param").group_id, {
        observedAt: observed_at,
        members,
        full: true,
      });
      return c.json(counts, 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/bot/groups/{group_id}/members",
      summary: "增量同步成员：只处理列出的人",
      request: { params: GroupParam, body: SyncBody },
      responses: syncResponses,
    }),
    async (c) => {
      const viewer = authorize(c, "sync");
      const { observed_at, members } = c.req.valid("json");
      const counts = await syncMembers(actorOf(c, viewer), c.req.valid("param").group_id, {
        observedAt: observed_at,
        members,
        full: false,
      });
      return c.json(counts, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/admin/groups",
      summary: "已关联的群和同步状态，包括停用的",
      responses: { 200: groupsResponse, 403: errorResponse("不是管理员") },
    }),
    async (c) => {
      authorize(c, "admin");
      return c.json({ items: await groups(false) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/admin/groups",
      summary: "关联 QQ 群；第一个关联的群自动成为主群",
      request: {
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({ group_id: z.number().int().positive() }),
            },
          },
        },
      },
      responses: {
        204: { description: "已关联" },
        403: errorResponse("不是管理员"),
        409: errorResponse("已经关联过了"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      await linkGroup(actorOf(c, viewer), c.req.valid("json").group_id);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/admin/groups/{group_id}",
      summary: "启用、停用，或设为主群",
      request: {
        params: GroupParam,
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({ enabled: z.boolean().optional(), is_primary: z.literal(true).optional() })
                .refine((b) => b.enabled !== undefined || b.is_primary, "至少要改一项"),
            },
          },
        },
      },
      responses: {
        204: { description: "已修改，相关成员的成员资格和显示名已重算" },
        403: errorResponse("不是管理员"),
        404: errorResponse("这个群还没有关联"),
      },
    }),
    async (c) => {
      const viewer = authorize(c, "admin");
      const { enabled, is_primary } = c.req.valid("json");
      await updateGroup(actorOf(c, viewer), c.req.valid("param").group_id, {
        enabled,
        isPrimary: is_primary,
      });
      return c.body(null, 204);
    },
  );
