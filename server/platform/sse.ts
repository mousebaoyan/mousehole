import type { Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";

// A comment this often keeps proxies from closing a quiet stream.
export const HEARTBEAT_MS = 20_000;

// An SSE stream for a page that follows something live: `send` runs at once, then again after
// `subscribe`'s listener is called. Several calls while sending make one more run.
export function liveStream(
  c: Context,
  subscribe: (changed: () => void) => () => void,
  send: (stream: SSEStreamingApi) => Promise<void>,
) {
  return streamSSE(c, async (stream) => {
    let dirty = true;
    let wake: (() => void) | null = null;
    const unsubscribe = subscribe(() => {
      dirty = true;
      wake?.();
    });
    stream.onAbort(() => wake?.());
    try {
      while (!stream.aborted) {
        if (dirty) {
          dirty = false;
          await send(stream);
          continue;
        }
        const woken = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), HEARTBEAT_MS);
          wake = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        if (!woken) await stream.write(": ping\n\n");
      }
    } finally {
      unsubscribe();
    }
  });
}
