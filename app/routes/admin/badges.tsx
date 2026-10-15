import { pageTitle } from "~/share-meta";
import { Award, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, Link, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { cn } from "cn";
import { TIER_NAMES, TIER_STYLES } from "~/components/badge-chip";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import type { Route } from "./+types/badges.ts";
import { choice, Field, readForm, Result, Section } from "~/components/form-parts";

export function meta() {
  return [{ title: pageTitle("徽章", "管理后台") }];
}

const TIERS = [
  { value: "gold", label: "金" },
  { value: "silver", label: "银" },
  { value: "bronze", label: "铜" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).badges.$get();
  // The event badge being looked after, if any: ?edit=id.
  return {
    badges: (await res.json()).items.filter((b) => b.manual),
    edit: Number(new URL(request.url).searchParams.get("edit")),
  };
}

// The QQ number someone typed, as the API names a user.
function byQq(qq: string) {
  return `qq:${qq}`;
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext).admin.badges;
  const intent = field("intent");
  const param = { id: field("id") };
  const res =
    intent === "create"
      ? await api.$post({
          json: {
            name: field("name"),
            description: field("description"),
            tier: choice(TIERS, field("tier")),
          },
        })
      : intent === "grant"
        ? await api[":id"].grants.$post({
            param,
            json: { user: byQq(field("qq")), reason: field("reason") },
          })
        : intent === "revoke"
          ? await api[":id"].grants[":user"].$delete({
              param: { ...param, user: byQq(field("qq")) },
              json: { reason: field("reason") || undefined },
            })
          : await api[":id"].$patch({
              param,
              json: { name: field("name"), description: field("description") },
            });
  if (res.ok) {
    const message = {
      create: "已新建",
      grant: "已授予，对方会收到通知",
      revoke: "已撤销",
    }[intent];
    return { ok: true, message: message ?? "已保存", done: intent };
  }
  return { ok: false, message: (await res.json()).error.message, done: null };
}

export default function Badges({ loaderData: { badges, edit }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const createForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (actionData?.done === "create") createForm.current?.reset();
  }, [actionData]);
  const editing = badges.find((b) => b.id === edit);
  return (
    <>
      <h1 className="text-xl font-semibold">徽章</h1>
      <p className="mt-1 text-meta text-muted-foreground">
        活动徽章用于征文、活动的名次和纪念，由管理员授予；其余徽章按规则自动授予，见
        <Link to="/badges" className="text-primary hover:underline">
          徽章页
        </Link>
      </p>
      <Result result={actionData} />

      <Section title="活动徽章">
        {badges.length === 0 && <p className="text-sm text-muted-foreground">暂无活动徽章</p>}
        <div className="flex flex-wrap gap-2">
          {badges.map((b) => (
            <Link
              key={b.id}
              to={`?edit=${b.id}`}
              aria-current={b.id === edit ? "true" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm hover:bg-accent",
                b.id === edit && "border-primary bg-primary/10",
              )}
            >
              <Award className={cn("size-4 rounded-full", TIER_STYLES[b.tier])} />
              {b.name}
              <span className="text-xs text-muted-foreground tabular-nums">{b.granted_count}</span>
            </Link>
          ))}
        </div>
        {editing && <EditBadge key={editing.id} badge={editing} busy={busy} />}
      </Section>

      <Form method="post" ref={createForm}>
        <Section title="新建活动徽章">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="名称">
              <Input name="name" required maxLength={12} className="w-40" />
            </Field>
            <Field label="说明">
              <Input name="description" required maxLength={60} className="w-72" />
            </Field>
            <Field label="档">
              <Select name="tier" options={TIERS} className="w-20" />
            </Field>
            <Button type="submit" name="intent" value="create" disabled={busy}>
              新建
            </Button>
          </div>
        </Section>
      </Form>
    </>
  );
}

type Badge = Route.ComponentProps["loaderData"]["badges"][number];

function EditBadge({ badge, busy }: { badge: Badge; busy: boolean }) {
  return (
    <div className="relative mt-4 flex flex-col gap-4 rounded-xl border bg-background p-4">
      <Link
        to="/admin/badges"
        aria-label="关闭"
        className="absolute top-2 right-2 flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" />
      </Link>
      <p className="text-meta text-muted-foreground">
        {TIER_NAMES[badge.tier]}徽章 · {badge.granted_count} 人获得 ·{" "}
        <Link to={`/badges/${badge.id}`} className="text-primary hover:underline">
          查看获得的人
        </Link>
      </p>
      <Form method="post" className="flex flex-wrap items-end gap-2 pr-8">
        <input type="hidden" name="id" value={badge.id} />
        <Field label="名称">
          <Input name="name" defaultValue={badge.name} required maxLength={12} className="w-40" />
        </Field>
        <Field label="说明">
          <Input
            name="description"
            defaultValue={badge.description}
            required
            maxLength={60}
            className="w-72"
          />
        </Field>
        <Button type="submit" name="intent" value="update" disabled={busy}>
          保存
        </Button>
      </Form>
      <Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="id" value={badge.id} />
        <Field label="QQ 号">
          <Input name="qq" required inputMode="numeric" pattern="\d{5,12}" className="w-36" />
        </Field>
        <Field label="理由">
          <Input name="reason" maxLength={200} className="w-56" />
        </Field>
        <Button type="submit" name="intent" value="grant" disabled={busy}>
          授予
        </Button>
        <Button type="submit" name="intent" value="revoke" variant="outline" disabled={busy}>
          撤销
        </Button>
        <p className="w-full text-meta text-muted-foreground">授予时须填写理由，会记入操作日志</p>
      </Form>
    </div>
  );
}
