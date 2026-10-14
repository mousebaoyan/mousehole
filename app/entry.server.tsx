import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { renderToPipeableStream, type RenderToPipeableStreamOptions } from "react-dom/server";
import {
  isRouteErrorResponse,
  ServerRouter,
  type EntryContext,
  type RouterContextProvider,
} from "react-router";
import { log } from "../server/platform/log.ts";
import { Nonce, nonceContext } from "./nonce.ts";

export const streamTimeout = 5_000;

// Errors from loaders, actions and rendering. A response thrown on purpose, such as the 404 of a
// page that doesn't exist, is no error, and neither is a request the browser gave up on.
export function handleError(error: unknown, { request }: { request: Request }) {
  if (isRouteErrorResponse(error) || request.signal.aborted) return;
  log("error", "Request failed", { error, url: request.url });
}

// React Router's default, with the CSP nonce on every script it writes inline.
export default function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const nonce = loadContext.get(nonceContext);
  // Crawlers get the whole page at once.
  const userAgent = request.headers.get("user-agent");
  const ready: keyof RenderToPipeableStreamOptions =
    (userAgent !== null && isbot(userAgent)) || routerContext.isSpaMode
      ? "onAllReady"
      : "onShellReady";
  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    const { pipe, abort } = renderToPipeableStream(
      <Nonce value={nonce}>
        <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
      </Nonce>,
      {
        nonce,
        [ready]() {
          shellRendered = true;
          const body = new PassThrough({
            final(callback) {
              clearTimeout(timer);
              callback();
            },
          });
          headers.set("Content-Type", "text/html");
          pipe(body);
          resolve(new Response(createReadableStreamFromReadable(body), { headers, status }));
        },
        onShellError: reject,
        // Errors before the shell is out reject, and React Router logs them.
        onError(error: unknown) {
          status = 500;
          if (shellRendered) log("error", "Rendering failed", { error, url: request.url });
        },
      },
    );
    // Rejected boundaries get a moment to flush before the render is cut off.
    const timer = setTimeout(abort, streamTimeout + 1000);
  });
}
