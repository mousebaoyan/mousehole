import { promisify } from "node:util";
import { gunzip } from "node:zlib";
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

async function readCapped(stream: ReadableStream<Uint8Array>, maxSize: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxSize) tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Caps request bodies and unpacks `Content-Encoding: gzip`. The cap applies to the unpacked
// size too, so a small compressed body can't expand without bound.
export const requestBody = createMiddleware(async (c, next) => {
  const raw = c.req.raw;
  if (!raw.body) return next();
  const maxSize = limitFor(c.req.path);
  const length = raw.headers.get("content-length");
  const gzip = raw.headers.get("content-encoding") === "gzip";
  if (Number(length) > maxSize) tooLarge();
  if (length !== null && !gzip) return next();

  // The size isn't known up front, or what counts is the unpacked size: read it all here.
  const read = await readCapped(raw.body, maxSize);
  const body = gzip
    ? await gunzipAsync(read, { maxOutputLength: maxSize }).catch((error: unknown) => {
        if (error instanceof RangeError) tooLarge();
        throw new AppError(400, "invalid_request", "gzip 请求体无法解压", { cause: error });
      })
    : read;
  const headers = new Headers(raw.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.set("content-length", String(body.byteLength));
  // From the URL, not the request: the Node server's lightweight requests can't be copied
  // into a real Request.
  c.req.raw = new Request(raw.url, { method: raw.method, headers, body });
  return next();
});
