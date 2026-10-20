import { useState } from "react";
import { data, Form, Link, redirect, useFetcher } from "react-router";
import { ArrowLeft, ExternalLink, Merge, Search } from "~/components/icons";
import { Field } from "~/components/form-parts";
import { MAX_TAGS, TagPicker } from "~/components/tag-picker";
import { Button, buttonVariants } from "~/components/ui/button";
import { Radio } from "~/components/ui/checkbox";
import { confirmDialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import type { ThreadDetail } from "~/api-types";
import { usePostableBoards } from "~/forum";
import { pageTitle } from "~/share-meta";
import { stamp, unixNow } from "~/time";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/thread-merge.ts";
import { whyUnmergeable } from "../../server/modules/threads/merge-rules.ts";
import { STAFF } from "../../server/platform/site.ts";

export function meta() {
  return [{ title: pageTitle("合并帖子") }];
}

const KINDS = [
  { value: "discussion", label: "讨论" },
  { value: "question", label: "问答" },
] as const;

// The other thread by its link or its number, as a moderator pastes or types it.
function threadIdOf(ref: string) {
  return (/\/t\/(\d+)/.exec(ref) ?? /^#?(\d+)$/.exec(ref))?.[1] ?? null;
}

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const me = await api.me.$get();
  if (!me.ok) return redirect("/login");
  if (!STAFF.includes((await me.json()).role)) {
    throw data("只有版主可以合并帖子", { status: 403 });
  }
  const res = await api.threads[":id"].$get({ param: { id: params.id } });
  if (!res.ok) throw data("帖子不存在", { status: 404 });
  const thread = await res.json();
  const ref = new URL(request.url).searchParams.get("with")?.trim() ?? "";
  const page = { thread, ref, now: unixNow() };
  if (ref === "") return { ...page, other: null, problem: null };
  const id = threadIdOf(ref);
  if (id === null) return { ...page, other: null, problem: "请填写帖子的链接或编号" };
  if (id === String(thread.id)) {
    return { ...page, other: null, problem: "这就是当前的帖子，请填写另一个帖子" };
  }
  const found = await api.threads[":id"].$get({ param: { id } });
  if (!found.ok) return { ...page, other: null, problem: (await found.json()).error.message };
  const other = await found.json();
  return { ...page, other, problem: whyUnmergeable(other) };
}

// The one not kept goes into the one kept; the page of the merged thread opens where its opening
// post is now.
export async function action({ params, request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const kept = text("kept");
  const kind = KINDS.find((k) => k.value === text("kind"))?.value;
  const res = await context.get(apiContext).threads[":id"].merge.$post({
    param: { id: kept === params.id ? text("other") : params.id },
    json: {
      into: Number(kept),
      title: text("title"),
      board: text("board"),
      tags: form.getAll("tags").filter((t) => typeof t === "string"),
      kind,
    },
  });
  if (!res.ok) return { message: (await res.json()).error.message };
  const { thread_id, floor } = await res.json();
  return redirect(`/t/${thread_id}?floor=${floor}`);
}

export default function ThreadMerge({ loaderData }: Route.ComponentProps) {
  const { thread, other, ref, problem, now } = loaderData;
  const unmergeable = whyUnmergeable(thread);
  return (
    <section>
      <Link
        to={`/t/${thread.id}`}
        className="mb-3 inline-flex items-center gap-1 px-1 text-meta text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> 返回帖子
      </Link>
      <h1 className="px-1 text-xl font-semibold">合并帖子</h1>
      <p className="mt-1 px-1 text-meta text-muted-foreground">
        把讲同一件事的两个帖子合成一个，楼层按发布时间重新编号。合并后不能撤销。
      </p>
      {unmergeable ? (
        <p role="alert" className="mt-4 rounded-xl bg-warning/10 px-3 py-2 text-meta text-warning">
          {unmergeable}
        </p>
      ) : (
        <>
          <Form action={`/t/${thread.id}/merge`} className="mt-4 rounded-2xl border bg-card p-4">
            <label htmlFor="merge-with" className="text-sm font-medium">
              另一个帖子
            </label>
            <div className="mt-1.5 flex gap-2">
              <Input
                id="merge-with"
                name="with"
                defaultValue={ref}
                placeholder="帖子链接或编号"
                required
                className="flex-1"
              />
              <Button type="submit" variant="outline">
                <Search /> 查找
              </Button>
            </div>
            {problem && (
              <p role="alert" className="mt-2 text-meta text-destructive">
                {problem}
              </p>
            )}
          </Form>
          {other && !problem && (
            <MergeForm key={other.id} thread={thread} other={other} now={now} />
          )}
        </>
      )}
    </section>
  );
}

function MergeForm({
  thread,
  other,
  now,
}: {
  thread: ThreadDetail;
  other: ThreadDetail;
  now: number;
}) {
  const merging = useFetcher<{ message: string }>();
  const boards = usePostableBoards();
  // The earlier one is kept by default: its opening post stays the first floor.
  const [keptId, setKeptId] = useState(other.created_at < thread.created_at ? other.id : thread.id);
  const [kept, gone] = keptId === thread.id ? [thread, other] : [other, thread];
  const [title, setTitle] = useState(kept.title);
  const [board, setBoard] = useState(kept.board.slug);
  const [kind, setKind] = useState(kept.kind);
  const [tags, setTags] = useState([...new Set([...thread.tags, ...other.tags])]);
  const accepted = thread.accepted_floors.length + other.accepted_floors.length > 0;

  // What the moderator left as it was follows the thread kept.
  function keep(t: ThreadDetail) {
    if (title === kept.title) setTitle(t.title);
    if (board === kept.board.slug) setBoard(t.board.slug);
    if (kind === kept.kind) setKind(t.kind);
    setKeptId(t.id);
  }

  return (
    <merging.Form
      method="post"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = e.currentTarget;
        if (await confirmDialog("合并后不能撤销，确定合并这两个帖子吗？", "合并")) {
          void merging.submit(form, { method: "post" });
        }
      }}
    >
      <input type="hidden" name="other" value={other.id} />
      <fieldset aria-labelledby="merge-kept" className="mt-4 rounded-2xl border bg-card p-4">
        <h2 id="merge-kept" className="text-sm font-medium">
          保留的帖子
        </h2>
        <p className="mt-1 text-meta text-muted-foreground">
          保留的帖子的主楼仍是 1 楼，另一个帖子的主楼成为其中一层回复。
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[thread, other].map((t) => (
            <div
              key={t.id}
              className="flex gap-3 rounded-xl border p-3 has-checked:border-brand has-checked:bg-brand/5"
            >
              <label htmlFor={`kept-${t.id}`} className="flex min-w-0 flex-1 cursor-pointer gap-3">
                <Radio
                  id={`kept-${t.id}`}
                  name="kept"
                  value={t.id}
                  checked={keptId === t.id}
                  onChange={() => keep(t)}
                  className="mt-0.5 shrink-0 checked:border-brand"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-meta text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: t.board.color }}
                      />
                      {t.board.name}
                    </span>
                    <span>{KINDS.find((k) => k.value === t.kind)?.label}</span>
                    {t.id === thread.id && <span>当前帖子</span>}
                  </span>
                  <span className="mt-1 block font-medium break-words">{t.title}</span>
                  <span className="mt-1 block text-meta text-muted-foreground tabular-nums">
                    {t.author.display_name} · {stamp(t.created_at, now)} · {t.reply_count} 条回复
                  </span>
                </span>
              </label>
              <a
                href={`/t/${t.id}`}
                target="_blank"
                rel="noreferrer"
                aria-label="在新标签页查看这个帖子"
                title="查看帖子"
                className="-m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ExternalLink className="size-4" />
              </a>
            </div>
          ))}
        </div>
      </fieldset>

      <section className="mt-4 flex flex-col gap-4 rounded-2xl border bg-card p-4">
        <h2 className="text-sm font-medium">合并后的帖子</h2>
        <div className="flex flex-col gap-1.5">
          <Field label="标题">
            <Input
              name="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              minLength={4}
              maxLength={80}
            />
          </Field>
          {title !== gone.title && (
            <button
              type="button"
              onClick={() => setTitle(gone.title)}
              className="self-start text-left text-meta text-brand-strong hover:underline"
            >
              使用另一个帖子的标题
            </button>
          )}
        </div>
        <Field label="版块">
          <Select
            name="board"
            value={board}
            onValueChange={setBoard}
            options={boards.map((b) => ({ value: b.slug, label: b.name }))}
            aria-label="版块"
            className="sm:w-56"
          />
        </Field>
        {thread.kind !== other.kind && (
          <Field
            label="类型"
            hint={kind === "discussion" && accepted ? "选择讨论帖会取消已采纳的回答" : undefined}
          >
            <Select
              name="kind"
              value={kind}
              onValueChange={setKind}
              options={KINDS}
              aria-label="类型"
              className="sm:w-56"
            />
          </Field>
        )}
        <div className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">标签</span>
          <TagPicker chosen={tags} onChange={setTags} />
          {tags.map((t) => (
            <input key={t} type="hidden" name="tags" value={t} />
          ))}
          {tags.length > MAX_TAGS && (
            <span role="alert" className="text-meta text-destructive">
              最多 {MAX_TAGS} 个标签，请去掉 {tags.length - MAX_TAGS} 个
            </span>
          )}
        </div>
      </section>

      <p className="mt-4 px-1 text-meta text-muted-foreground">
        合并后共 {thread.floor_count + other.floor_count} 层。「{gone.title}
        」原来的链接会跳到合并后的帖子里对应的楼层。
      </p>
      {merging.data && (
        <p role="alert" className="mt-2 px-1 text-meta text-destructive">
          {merging.data.message}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Link to={`/t/${thread.id}`} className={buttonVariants({ variant: "ghost" })}>
          取消
        </Link>
        <Button
          type="submit"
          variant="destructive"
          disabled={tags.length > MAX_TAGS || merging.state !== "idle"}
        >
          <Merge /> 合并
        </Button>
      </div>
    </merging.Form>
  );
}
