import { createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { authorize, createRouter, errorResponse, unix } from "../../platform/http.ts";
import { HEARTBEAT_MS } from "../../platform/sse.ts";
import {
  batchPolled,
  checkCursor,
  EVENT_TYPES,
  pending,
  HELD_MS,
  latestEventId,
  nextEvents,
  readEvents,
  streamClosed,
  streamOpened,
} from "./service.ts";

const Types = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? null : v.split(",")))
  .pipe(z.array(z.enum(EVENT_TYPES)).nullable())
  .openapi({ description: "只要这几类，逗号分隔，例如 thread.created,notification.created" });

const expired = errorResponse(
  "游标早于最早的事件；latest_id 是当前最新的事件 ID，可以从那里重新开始",
);

const BATCH = 100;

export const eventsRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/bot/events",
      summary: "事件流（SSE）：带 Last-Event-ID 或 after 时先补发之后的事件，再实时推送",
      request: {
        query: z.object({ after: z.coerce.number().int().min(0).optional(), types: Types }),
        headers: z.object({ "last-event-id": z.coerce.number().int().min(0).optional() }),
      },
      responses: {
        200: {
          description: "text/event-stream；每 20 秒一条心跳注释",
          content: { "text/event-stream": { schema: z.string() } },
        },
        410: expired,
      },
    }),
    async (c) => {
      authorize(c, "events");
      const { types } = c.req.valid("query");
      const after = c.req.valid("header")["last-event-id"] ?? c.req.valid("query").after;
      if (after !== undefined) await checkCursor(after);
      let cursor = after ?? (await latestEventId());
      return streamSSE(c, async (stream) => {
        const closed = new AbortController();
        stream.onAbort(() => closed.abort());
        streamOpened();
        try {
          while (!closed.signal.aborted) {
            const events = await readEvents(cursor, types, BATCH);
            for (const e of events) {
              await stream.writeSSE({
                id: String(e.id),
                event: e.type,
                data: JSON.stringify(e.data),
              });
              cursor = e.id;
            }
            // A full batch may have more behind it; otherwise wait for news, or say it is alive.
            if (events.length === BATCH) continue;
            if (await pending(cursor, types)) await nextEvents(HELD_MS, closed.signal);
            else if (!(await nextEvents(HEARTBEAT_MS, closed.signal))) {
              await stream.write(": ping\n\n");
            }
          }
        } finally {
          streamClosed();
        }
      });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/bot/events/batch",
      summary: "按游标拉取事件，和事件流的内容一样；next_after 是下次的 after",
      request: {
        query: z.object({
          after: z.coerce.number().int().min(0).optional().openapi({
            description: "不带时不返回事件，next_after 是当前最新的事件 ID，从现在开始拉取用",
          }),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          types: Types,
        }),
      },
      responses: {
        200: {
          description: "事件",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(
                  z.object({
                    id: z.number(),
                    type: z.string(),
                    data: z.record(z.string(), z.unknown()),
                    created_at: z.number(),
                  }),
                ),
                next_after: z.number(),
              }),
            },
          },
        },
        410: expired,
      },
    }),
    async (c) => {
      authorize(c, "events");
      batchPolled();
      const { after, limit, types } = c.req.valid("query");
      if (after === undefined) return c.json({ items: [], next_after: await latestEventId() }, 200);
      await checkCursor(after);
      const events = await readEvents(after, types, limit);
      return c.json(
        {
          items: events.map((e) => ({ ...e, created_at: unix(e.created_at) })),
          next_after: events.at(-1)?.id ?? after,
        },
        200,
      );
    },
  );
