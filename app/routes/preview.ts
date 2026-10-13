import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/preview.ts";

// The editor's preview, rendered by the server exactly as a published post would be.
export async function action({ request, context }: Route.ActionArgs) {
  const markdown = (await request.formData()).get("markdown");
  const res = await context.get(apiContext).preview.$post({
    json: { markdown: typeof markdown === "string" ? markdown : "" },
  });
  return res.ok ? res.json() : { html: null };
}
