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
  const res = await context.get(apiContext).threads.$post({
    json: {
      board: text("board"),
      title: text("title"),
      kind: text("kind") === "question" ? "question" : "discussion",
      tags: form.getAll("tags").filter((t) => typeof t === "string"),
      content: { markdown: text("markdown") },
      anonymous: text("anonymous") === "true",
      anonymous_replies: text("anonymous_replies") === "true",
    },
  });
  if (res.ok) return { ok: true as const, id: (await res.json()).id };
  return { ok: false as const, message: (await res.json()).error.message };
}
