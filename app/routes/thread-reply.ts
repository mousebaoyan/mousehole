import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/thread-reply.ts";

// The docked editor's reply: the new floor's number, or why it wasn't posted.
export async function action({ params, request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const markdown = form.get("markdown");
  const replyTo = form.get("reply_to_id");
  const res = await context.get(apiContext).threads[":id"].posts.$post({
    param: { id: params.id },
    json: {
      content: { markdown: typeof markdown === "string" ? markdown : "" },
      reply_to_id: replyTo === null ? undefined : Number(replyTo),
    },
  });
  if (res.ok) return { ok: true as const, floor: (await res.json()).floor };
  return { ok: false as const, message: (await res.json()).error.message };
}
