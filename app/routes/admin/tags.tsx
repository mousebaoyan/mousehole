import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, Link, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { cn } from "cn";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import type { Route } from "./+types/tags.ts";
import { choice, Field, readForm, Result, Section } from "~/components/form-parts";

export function meta() {
  return [{ title: "标签 · 管理后台" }];
}

const KINDS = [
  { value: "topic", label: "话题" },
  { value: "school", label: "院校" },
  { value: "major", label: "方向" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).tags.$get();
  // The tag being edited, if any: ?edit=id.
  return {
    tags: (await res.json()).items,
    edit: Number(new URL(request.url).searchParams.get("edit")),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext).tags;
  const intent = field("intent");
  const param = { id: field("id") };
  const tag = () => ({ name: field("name"), kind: choice(KINDS, field("kind")) });
  const res =
    intent === "create"
      ? await api.$post({ json: tag() })
      : intent === "merge"
        ? await api[":id"].merge.$post({ param, json: { into: Number(field("into")) } })
        : intent === "delete"
          ? await api[":id"].$delete({ param })
          : await api[":id"].$patch({ param, json: tag() });
  if (res.ok) {
    const message =
      intent === "create"
        ? "已添加"
        : intent === "merge"
          ? "已合并"
          : intent === "delete"
            ? "已删除"
            : "已保存";
    return { ok: true, message, created: intent === "create" };
  }
  return { ok: false, message: (await res.json()).error.message, created: false };
}

export default function Tags({ loaderData: { tags, edit }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const createForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (actionData?.created) createForm.current?.reset();
  }, [actionData]);
  const editing = tags.find((t) => t.id === edit);
  return (
    <>
      <h1 className="text-xl font-semibold">标签</h1>
      <p className="mt-1 text-meta text-muted-foreground">
        发帖时只能选这里的标签；意思重复的标签可以合并
      </p>
      <Result result={actionData} />

      {KINDS.map((k) => {
        const group = tags.filter((t) => t.kind === k.value);
        return (
          <Section key={k.value} title={k.label}>
            {group.length === 0 && <p className="text-sm text-muted-foreground">还没有标签</p>}
            <div className="flex flex-wrap gap-2">
              {group.map((t) => (
                <Link
                  key={t.id}
                  to={`?edit=${t.id}`}
                  aria-current={t.id === edit ? "true" : undefined}
                  className={cn(
                    "rounded-lg border px-2.5 py-1 text-sm hover:bg-accent",
                    t.id === edit && "border-primary bg-primary/10",
                  )}
                >
                  #{t.name}
                  <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">
                    {t.thread_count}
                  </span>
                </Link>
              ))}
            </div>
            {editing?.kind === k.value && (
              <EditTag key={editing.id} tag={editing} tags={tags} busy={busy} />
            )}
          </Section>
        );
      })}

      <Form method="post" action="/admin/tags" ref={createForm}>
        <Section title="添加标签">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="名称">
              <Input name="name" required maxLength={20} className="w-48" />
            </Field>
            <Field label="类别">
              <Kinds />
            </Field>
            <Button type="submit" name="intent" value="create" disabled={busy}>
              添加
            </Button>
          </div>
        </Section>
      </Form>
    </>
  );
}

type Tag = Route.ComponentProps["loaderData"]["tags"][number];

// Both forms post to the bare page, so a change also leaves edit mode.
function EditTag({ tag, tags, busy }: { tag: Tag; tags: Tag[]; busy: boolean }) {
  return (
    <div className="relative mt-4 flex flex-col gap-4 rounded-xl border bg-background p-4">
      <Link
        to="/admin/tags"
        aria-label="关闭"
        className="absolute top-2 right-2 flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" />
      </Link>
      <Form method="post" action="/admin/tags" className="flex flex-wrap items-end gap-2 pr-8">
        <input type="hidden" name="id" value={tag.id} />
        <Field label="名称">
          <Input name="name" defaultValue={tag.name} required maxLength={20} className="w-48" />
        </Field>
        <Field label="类别">
          <Kinds value={tag.kind} />
        </Field>
        <Button type="submit" name="intent" value="update" disabled={busy}>
          保存
        </Button>
      </Form>
      <Form method="post" action="/admin/tags" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={tag.id} />
        <Field label="合并到">
          <NativeSelect name="into" required defaultValue="" className="w-48">
            <option value="" disabled>
              选择标签
            </option>
            {KINDS.map((k) => (
              <optgroup key={k.value} label={k.label}>
                {tags
                  .filter((t) => t.kind === k.value && t.id !== tag.id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </NativeSelect>
        </Field>
        <Button type="submit" name="intent" value="merge" variant="outline" disabled={busy}>
          合并
        </Button>
        <Button
          type="submit"
          name="intent"
          value="delete"
          variant="destructive"
          className="ml-auto"
          formNoValidate
          disabled={busy}
          onClick={(e) => {
            if (!confirm(`删除标签「${tag.name}」？主题上的这个标签会一并去掉。`)) {
              e.preventDefault();
            }
          }}
        >
          删除
        </Button>
        <p className="w-full text-meta text-muted-foreground">
          合并后，「{tag.name}」的主题都改用选中的标签，「{tag.name}」删除
        </p>
      </Form>
    </div>
  );
}

function Kinds({ value }: { value?: string }) {
  return (
    <NativeSelect name="kind" defaultValue={value} className="w-28">
      {KINDS.map((k) => (
        <option key={k.value} value={k.value}>
          {k.label}
        </option>
      ))}
    </NativeSelect>
  );
}
