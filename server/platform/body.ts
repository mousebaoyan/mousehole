import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { AppError } from "./errors.ts";

const MB = 1024 * 1024;
const gunzipAsync = promisify(gunzip);

// A full member list is the largest JSON a bot sends; uploads will get their own limit.
function limitFor(path: string) {
  return /^\/api\/v1\/bot\/groups\/[^/]+\/members$/.test(path) ? 4 * MB : MB;
}

function tooLarge(): never {
  throw new AppError(413, "payload_too_large", "请求体太大");
}

// Caps request bodies and unpacks `Content-Encoding: gzip`. The cap applies to the unpacked
// size too, so a small compressed body can't expand without bound.
export const requestBody = createMiddleware(async (c, next) => {
  const maxSize = limitFor(c.req.path);
  if (c.req.header("content-encoding") !== "gzip") {
    return bodyLimit({ maxSize, onError: tooLarge })(c, next);
  }

  // Read from the raw request: HonoRequest would cache the packed bytes for later json().
  const packed = await c.req.raw.arrayBuffer();
  if (packed.byteLength > maxSize) tooLarge();
  const body = await gunzipAsync(packed, { maxOutputLength: maxSize }).catch((error: unknown) => {
    if (error instanceof RangeError) tooLarge();
    throw new AppError(400, "invalid_request", "gzip 请求体无法解压", { cause: error });
  });
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(body.byteLength));
  c.req.raw = new Request(c.req.raw.url, { method: c.req.method, headers, body });
  return next();
});
