import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useNavigate, useSearchParams } from "react-router";
import { apiContext } from "../api.server.ts";
import { MarkdownEditor } from "~/components/markdown-editor";
import { TagPicker } from "~/components/tag-picker";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { useBoards, useMe } from "~/forum";
import { useHydrated } from "~/hydrated";
import type { Route } from "./+types/new-thread.ts";

export function meta() {
  return [{ title: "发帖 · 鼠洞" }];
}

const KINDS = [
  { kind: "discussion", label: "讨论" },
  { kind: "question", label: "问答" },
] as const;

type Kind = (typeof KINDS)[number]["kind"];

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).me.$get();
  return res.ok ? null : redirect("/login");
}

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
    },
  });
  if (res.ok) return { ok: true as const, id: (await res.json()).id };
  return { ok: false as const, message: (await res.json()).error.message };
}

// Kept in the browser until it is posted, like replies in the composer. Each field under its own
// key: plain strings need no parsing.
const DRAFT_KEY = "thread-draft";

type Draft = { title: string; board: string; kind: Kind; tags: string[]; markdown: string };

function loadDraft(fallback: Draft): Draft {
  const get = (field: keyof Draft) => localStorage.getItem(`${DRAFT_KEY}:${field}`);
  const kind = get("kind");
  return {
    title: get("title") ?? fallback.title,
    board: get("board") ?? fallback.board,
    kind: kind === "question" || kind === "discussion" ? kind : fallback.kind,
    tags: get("tags")?.split("\n").filter(Boolean) ?? fallback.tags,
    markdown: get("markdown") ?? fallback.markdown,
  };
}

function saveDraft(draft: Draft) {
  for (const [field, value] of Object.entries(draft)) {
    localStorage.setItem(`${DRAFT_KEY}:${field}`, Array.isArray(value) ? value.join("\n") : value);
  }
}

function clearDraft() {
  for (const field of ["title", "board", "kind", "tags", "markdown"]) {
    localStorage.removeItem(`${DRAFT_KEY}:${field}`);
  }
}

export default function NewThread() {
  // The server renders an empty form; once the page runs, a saved draft takes its place.
  const hydrated = useHydrated();
  return <ThreadForm key={String(hydrated)} restore={hydrated} />;
}

function ThreadForm({ restore }: { restore: boolean }) {
  const me = useMe();
  const boards = useBoards().filter(
    (b) => b.post_role === "user" || me?.role === "moderator" || me?.role === "admin",
  );
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const post = useFetcher<typeof action>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<Draft>(() => {
    const fromBoard = boards.find((b) => b.slug === params.get("board"));
    const empty: Draft = {
      title: "",
      board: fromBoard?.slug ?? "",
      kind: fromBoard?.default_kind === "question" ? "question" : "discussion",
      tags: [],
      markdown: "",
    };
    return restore ? loadDraft(empty) : empty;
  });
  const busy = post.state !== "idle";

  useEffect(() => {
    if (post.state !== "idle" || !post.data?.ok) return;
    clearDraft();
    void navigate(`/t/${post.data.id}`);
  }, [post.state, post.data, navigate]);

  function change(next: Partial<Draft>) {
    const updated = { ...draft, ...next };
    setDraft(updated);
    saveDraft(updated);
  }

  function send() {
    if (busy) return;
    const form = new FormData();
    form.set("title", draft.title);
    form.set("board", draft.board);
    form.set("kind", draft.kind);
    form.set("markdown", draft.markdown);
    for (const tag of draft.tags) form.append("tags", tag);
    void post.submit(form, { method: "post" });
  }

  return (
    <form
      className="mx-auto flex max-w-4xl flex-col gap-4 px-1"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <h1 className="text-xl font-semibold">发帖</h1>
      <Input
        value={draft.title}
        onChange={(e) => change({ title: e.target.value })}
        aria-label="标题"
        placeholder="标题：把问题写清楚，比如「rank 30% 能冲华五的夏令营吗」"
        required
        minLength={4}
        maxLength={80}
        className="h-11 text-base md:text-base"
      />
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect
          value={draft.board}
          onChange={(e) => {
            const board = boards.find((b) => b.slug === e.target.value);
            change({
              board: e.target.value,
              kind: board?.default_kind === "question" ? "question" : "discussion",
            });
          }}
          aria-label="版块"
          required
          className="w-44"
        >
          <option value="" disabled>
            选择版块
          </option>
          {boards.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.name}
            </option>
          ))}
        </NativeSelect>
        <fieldset className="flex rounded-full bg-secondary p-0.5 text-sm">
          <legend className="sr-only">类型</legend>
          {KINDS.map((k) => (
            <label
              key={k.kind}
              className="cursor-pointer rounded-full px-3.5 py-1 text-muted-foreground has-checked:bg-card has-checked:font-medium has-checked:text-foreground has-checked:shadow-sm"
            >
              <input
                type="radio"
                name="kind"
                value={k.kind}
                checked={draft.kind === k.kind}
                onChange={() => change({ kind: k.kind })}
                className="sr-only"
              />
              {k.label}
            </label>
          ))}
        </fieldset>
        <TagPicker chosen={draft.tags} onChange={(tags) => change({ tags })} />
      </div>
      <div className="flex h-[min(60svh,34rem)] min-h-80 flex-col overflow-hidden rounded-2xl border bg-card">
        <MarkdownEditor
          value={draft.markdown}
          onChange={(markdown) => change({ markdown })}
          onSubmit={send}
          label="正文"
          textarea={textarea}
          className="flex-1"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="lg" disabled={busy || !draft.markdown.trim()}>
          <Send /> {busy ? "发布中…" : "发布"}
        </Button>
        {post.data && !post.data.ok && (
          <p role="alert" className="text-meta text-destructive">
            {post.data.message}
          </p>
        )}
      </div>
    </form>
  );
}
