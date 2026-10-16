import { ArrowDown, ArrowUp } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { useEffect, useRef } from "react";
import { Form, Link, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import type { Route } from "./+types/boards.ts";
import { Badge, choice, Field, readForm, Result, Section } from "~/components/form-parts";
import { confirmSubmit } from "~/components/ui/dialog";
import { LEVEL_NAMES, levelName } from "../../../server/platform/site.ts";

export function meta() {
  return [{ title: pageTitle("版块", "管理后台") }];
}

// Thresholds as one choice each: who reads the board, and who starts threads in it (design §8.1).
const LEVELS = LEVEL_NAMES.slice(1).map((_, i) => ({
  value: String(i + 1),
  label: `${levelName(i + 1)} 起`,
}));
const READ = [{ value: "public", label: "访客（公开）" }, { value: "0", label: "成员" }, ...LEVELS];
const POST = [{ value: "0", label: "成员" }, ...LEVELS, { value: "moderator", label: "只有版主" }];

function readFields(value: string) {
  return value === "public"
    ? { visibility: "public" as const, read_level: 0 }
    : { visibility: "members" as const, read_level: Number(choice(READ, value)) };
}

function postFields(value: string) {
  return value === "moderator"
    ? { post_role: "moderator" as const, post_level: 0 }
    : { post_role: "user" as const, post_level: Number(choice(POST, value)) };
}

const KIND = [
  { value: "discussion", label: "讨论" },
  { value: "question", label: "问答" },
] as const;

const REVIEW = [
  { value: "after", label: "先发后审" },
  { value: "before", label: "先审后发" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).boards.$get();
  return {
    boards: (await res.json()).items,
    // The board being edited, if any: ?edit=slug.
    edit: new URL(request.url).searchParams.get("edit"),
  };
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
    ...readFields(field("read")),
    ...postFields(field("post")),
    default_kind: choice(KIND, field("default_kind")),
    review_mode: choice(REVIEW, field("review_mode")),
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
      <p className="mt-1 text-meta text-muted-foreground">侧栏和筛选按这里的顺序排列</p>
      <Result result={actionData} />

      <Section title="全部版块">
        {boards.length === 0 && <p className="text-sm text-muted-foreground">暂无版块</p>}
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
                      onClick={confirmSubmit(
                        `删除版块「${b.name}」？有过帖子的版块不能删除。`,
                        "删除",
                      )}
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
                    {b.visibility === "members" && (
                      <Badge>{b.read_level > 0 ? `L${b.read_level} 起可看` : "仅成员"}</Badge>
                    )}
                    {b.post_role === "moderator" && <Badge>版主发帖</Badge>}
                    {b.post_level > 0 && <Badge>L{b.post_level} 起发帖</Badge>}
                    {b.default_kind === "question" && <Badge>问答</Badge>}
                    {b.review_mode === "before" && <Badge>先审后发</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    /b/{b.slug} · {b.thread_count} 个帖子
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
          <Field
            label="地址"
            hint="版块链接 /b/ 后面的部分：小写字母、数字和短横线，创建后不能修改"
          >
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
      <Field label="阅读权限" hint="版主和管理员不受等级限制">
        <Select
          name="read"
          options={READ}
          defaultValue={
            board && (board.visibility === "public" ? "public" : String(board.read_level))
          }
        />
      </Field>
      <Field label="发帖权限" hint="能查看版块的成员都可以回复">
        <Select
          name="post"
          options={POST}
          defaultValue={
            board && (board.post_role === "moderator" ? "moderator" : String(board.post_level))
          }
        />
      </Field>
      <Field label="默认类型" hint="问答帖子可以采纳答案">
        <Select name="default_kind" options={KIND} defaultValue={board?.default_kind} />
      </Field>
      <Field label="审核方式" hint="先审后发：除版主外，其他人发布的内容审核通过后才公开">
        <Select name="review_mode" options={REVIEW} defaultValue={board?.review_mode} />
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
