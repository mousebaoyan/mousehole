import { Check, X } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { Form, Link, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { readForm, Time } from "~/components/form-parts";
import { Button } from "~/components/ui/button";
import { SuggestionChanges } from "../suggestion-changes.tsx";
import type { Route } from "./+types/suggestions.ts";

export function meta() {
  return [{ title: pageTitle("修改建议", "管理后台") }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const cursor = new URL(request.url).searchParams.get("cursor");
  const res = await context
    .get(apiContext)
    .admin.suggestions.$get({ query: { cursor: cursor ?? undefined } });
  if (!res.ok) throw new Error("Suggestions failed");
  return res.json();
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const res = await context.get(apiContext).suggestions[":id"].$patch({
    param: { id: field("id") },
    json: { status: field("status") === "accepted" ? "accepted" : "rejected" },
  });
  return res.ok ? null : { message: (await res.json()).error.message };
}

// Changes L3 suggested for threads, waiting for a moderator unless the author decides first
// (design §6.6); decided ones leave the list.
export default function Suggestions({ loaderData, actionData }: Route.ComponentProps) {
  const { items, next_cursor } = loaderData;
  const busy = useNavigation().state !== "idle";
  return (
    <>
      <h1 className="text-xl font-semibold">修改建议</h1>
      {actionData && (
        <p role="alert" className="mt-3 text-meta text-destructive">
          {actionData.message}
        </p>
      )}
      {items.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">暂无待处理的修改建议</p>
      )}
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((s) => (
          <li key={s.id} className="rounded-2xl border bg-card p-4">
            <Link
              to={`/t/${s.thread.id}`}
              className="block truncate text-meta font-medium hover:underline"
            >
              {s.thread.title}
            </Link>
            <div className="mt-2.5">
              <SuggestionChanges
                suggestion={s}
                current={s.thread}
                when={<Time value={s.created_at} />}
              />
            </div>
            <Form method="post" className="mt-3 flex gap-2">
              <input type="hidden" name="id" value={s.id} />
              <Button name="status" value="accepted" size="sm" disabled={busy}>
                <Check /> 同意
              </Button>
              <Button name="status" value="rejected" size="sm" variant="outline" disabled={busy}>
                <X /> 不同意
              </Button>
            </Form>
          </li>
        ))}
      </ul>
      {next_cursor !== null && (
        <Link
          to={`?${new URLSearchParams({ cursor: next_cursor })}`}
          className="mt-4 block text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更早的
        </Link>
      )}
    </>
  );
}
