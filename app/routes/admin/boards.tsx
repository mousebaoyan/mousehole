import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, Link, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import type { Route } from "./+types/boards.ts";
import { Badge, choice, Field, readForm, Result, Section } from "./parts.tsx";

export function meta() {
  return [{ title: "版块 · 管理后台" }];
}

const VISIBILITY = [
  { value: "public", label: "公开" },
  { value: "members", label: "仅成员" },
] as const;

const POST_ROLE = [
  { value: "user", label: "成员" },
  { value: "moderator", label: "版主" },
] as const;

const KIND = [
  { value: "discussion", label: "讨论" },
  { value: "question", label: "问答" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).boards.$get();
  // The board being edited, if any: ?edit=slug.
  return { boards: (await res.json()).items, edit: new URL(request.url).searchParams.get("edit") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext).boards;
  const intent = field("intent");
  const param = { slug: field("slug") };
  const fields = () => ({
    name: field("name"),
    description: field("description"),
    color: field("color"),
    visibility: choice(VISIBILITY, field("visibility")),
    post_role: choice(POST_ROLE, field("post_role")),
    default_kind: choice(KIND, field("default_kind")),
  });
  const res =
    intent === "create"
      ? await api.$post({ json: { slug: param.slug, ...fields() } })
      : intent === "delete"
        ? await api[":slug"].$delete({ param })
        : await api[":slug"].$patch({
            param,
            json: intent === "move" ? { position: Number(field("position")) } : fields(),
          });
  if (res.ok) {
    const message = intent === "create" ? "已创建" : intent === "delete" ? "已删除" : "已保存";
    return { ok: true, message, created: intent === "create" };
  }
  return { ok: false, message: (await res.json()).error.message, created: false };
}

export default function Boards({ loaderData: { boards, edit }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const createForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (actionData?.created) createForm.current?.reset();
  }, [actionData]);
  return (
    <>
      <h1 className="text-xl font-semibold">版块</h1>
      <p className="mt-1 text-meta text-muted-foreground">
        侧栏和筛选按这里的顺序排列；仅成员可见的版块，访客看不到
      </p>
      <Result result={actionData} />

      <Section title="全部版块">
        {boards.length === 0 && <p className="text-sm text-muted-foreground">还没有版块</p>}
        <ul className="divide-y">
          {boards.map((b, i) =>
            b.slug === edit ? (
              <li key={b.slug} className="py-4">
                {/* Posts to the bare page, so saving also leaves edit mode. */}
                <Form method="post" action="/admin/boards">
                  <input type="hidden" name="slug" value={b.slug} />
                  <BoardFields board={b} />
                  <div className="mt-4 flex items-center gap-2">
                    <Button type="submit" name="intent" value="update" disabled={busy}>
                      保存
                    </Button>
                    <Link to="/admin/boards" className={buttonVariants({ variant: "ghost" })}>
                      取消
                    </Link>
                    <Button
                      type="submit"
                      name="intent"
                      value="delete"
                      variant="destructive"
                      className="ml-auto"
                      formNoValidate
                      disabled={busy}
                      onClick={(e) => {
                        if (!confirm(`删除版块「${b.name}」？有过主题的版块不能删除。`)) {
                          e.preventDefault();
                        }
                      }}
                    >
                      删除
                    </Button>
                  </div>
                </Form>
              </li>
            ) : (
              <li key={b.slug} className="flex items-center gap-x-4 py-3">
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: b.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {b.name}
                    {b.visibility === "members" && <Badge>仅成员</Badge>}
                    {b.post_role === "moderator" && <Badge>版主发主题</Badge>}
                    {b.default_kind === "question" && <Badge>问答</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    /b/{b.slug} · {b.thread_count} 个主题
                    {b.description && ` · ${b.description}`}
                  </div>
                </div>
                <Form method="post" className="flex shrink-0 items-center gap-1">
                  <input type="hidden" name="slug" value={b.slug} />
                  <input type="hidden" name="intent" value="move" />
                  <Button
                    type="submit"
                    name="position"
                    value={i - 1}
                    variant="ghost"
                    size="icon-sm"
                    aria-label="上移"
                    disabled={busy || i === 0}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    type="submit"
                    name="position"
                    value={i + 1}
                    variant="ghost"
                    size="icon-sm"
                    aria-label="下移"
                    disabled={busy || i === boards.length - 1}
                  >
                    <ArrowDown />
                  </Button>
                  <Link
                    to={`?edit=${b.slug}`}
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                      className: "ml-1",
                    })}
                  >
                    编辑
                  </Link>
                </Form>
              </li>
            ),
          )}
        </ul>
      </Section>

      <Form method="post" action="/admin/boards" ref={createForm}>
        <Section title="新建版块" description="新版块排在最后">
          <Field label="地址" hint="链接里的 /b/地址：小写字母、数字和短横线，建好后不能改">
            <Input
              name="slug"
              required
              pattern="[a-z][a-z0-9\-]{0,31}"
              maxLength={32}
              className="w-56"
            />
          </Field>
          <div className="mt-4">
            <BoardFields />
          </div>
          <Button type="submit" name="intent" value="create" className="mt-5" disabled={busy}>
            创建
          </Button>
        </Section>
      </Form>
    </>
  );
}

type Board = Route.ComponentProps["loaderData"]["boards"][number];

function BoardFields({ board }: { board?: Board }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="名称">
        <Input name="name" defaultValue={board?.name} required maxLength={20} />
      </Field>
      <Field label="简介">
        <Input name="description" defaultValue={board?.description} maxLength={100} />
      </Field>
      <Field label="可见范围">
        <Options name="visibility" options={VISIBILITY} value={board?.visibility} />
      </Field>
      <Field label="谁能发主题" hint="回复不受限制">
        <Options name="post_role" options={POST_ROLE} value={board?.post_role} />
      </Field>
      <Field label="默认类型" hint="问答主题可以采纳答案">
        <Options name="default_kind" options={KIND} value={board?.default_kind} />
      </Field>
      <Field label="颜色" hint="列表和导航里的圆点">
        <input
          type="color"
          name="color"
          defaultValue={board?.color ?? "#55625f"}
          className="h-8 w-14 cursor-pointer rounded-lg border border-input bg-transparent p-1"
        />
      </Field>
    </div>
  );
}

function Options({
  name,
  options,
  value,
}: {
  name: string;
  options: readonly { value: string; label: string }[];
  value: string | undefined;
}) {
  return (
    <NativeSelect name={name} defaultValue={value}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </NativeSelect>
  );
}
