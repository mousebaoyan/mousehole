import { redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/new-thread.ts";

// Threads are written in the docked composer; this address only takes what it sends.
export function loader() {
  return redirect("/");
}

// The new thread's ID, or why it wasn't posted.
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const kind = text("kind");
  const number = (name: string) => (text(name) ? Number(text(name)) : null);
  const res = await context.get(apiContext).threads.$post({
    json: {
      board: text("board"),
      title: text("title"),
      kind: kind === "question" || kind === "poll" ? kind : "discussion",
      poll:
        kind === "poll"
          ? {
              options: form.getAll("options").filter((o) => typeof o === "string"),
              multiple: text("multiple") === "true",
              max_choices: number("max_choices"),
              anonymous: text("poll_anonymous") === "true",
              results: text("results") === "always" ? "always" : "voted",
              closes_at: number("closes_at"),
            }
          : undefined,
      tags: form.getAll("tags").filter((t) => typeof t === "string"),
      content: { markdown: text("markdown") },
      anonymous: text("anonymous") === "true",
      anonymous_replies: text("anonymous_replies") === "true",
    },
  });
  if (res.ok) return { ok: true as const, id: (await res.json()).id };
  return { ok: false as const, message: (await res.json()).error.message };
}
