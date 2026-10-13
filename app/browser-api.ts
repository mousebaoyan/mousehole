import { hc } from "hono/client";
import type { ApiType } from "../server/app.ts";

// For the few requests a page sends straight to /api/v1 rather than through an action: image
// uploads, which an action would only read and send on again, and reading reports, which have
// to go out as the page closes.
export const browserApi = hc<ApiType>("/api/v1");
