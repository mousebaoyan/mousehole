import { Form, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Route } from "./+types/groups.ts";
import { Badge, Field, readForm, Result, Section, Time } from "~/components/form-parts";

export function meta() {
  return [{ title: "QQ 群 · 管理后台" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin.groups.$get();
  if (!res.ok) throw new Error("Admin groups failed");
  return { groups: (await res.json()).items };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext);
  const groupId = Number(field("group_id"));
  const intent = field("intent");
  const res =
    intent === "link"
      ? await api.admin.groups.$post({ json: { group_id: groupId } })
      : await api.admin.groups[":group_id"].$patch({
          param: { group_id: String(groupId) },
          json: intent === "primary" ? { is_primary: true } : { enabled: intent === "enable" },
        });
  if (res.ok) {
    const message =
      intent === "link" ? "已关联，等 bot 推送成员名单" : "已修改，相关成员的身份已重算";
    return { ok: true, message };
  }
  return { ok: false, message: (await res.json()).error.message };
}

export default function Groups({ loaderData: { groups }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <>
      <h1 className="text-xl font-semibold">QQ 群</h1>
      <p className="mt-1 text-meta text-muted-foreground">
        在任意一个启用的群里就是成员；主群决定显示名和等级
      </p>
      <Result result={actionData} />

      <Section title="已关联的群">
        {groups.length === 0 && <p className="text-sm text-muted-foreground">还没有关联 QQ 群</p>}
        <ul className="divide-y">
          {groups.map((g) => (
            <li key={g.group_id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
              <div className="min-w-48 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  {g.name || "（未同步群资料）"}
                  {g.is_primary && <Badge>主群</Badge>}
                  {!g.enabled && <Badge>已停用</Badge>}
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {g.group_id} · {g.member_count ?? "—"} / {g.max_member_count ?? "—"} 人 · 全量{" "}
                  <Time value={g.full_synced_at} never="从未" />
                </div>
              </div>
              <Form method="post" className="flex gap-2">
                <input type="hidden" name="group_id" value={g.group_id} />
                {!g.is_primary && (
                  <Button
                    type="submit"
                    name="intent"
                    value="primary"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                  >
                    设为主群
                  </Button>
                )}
                <Button
                  type="submit"
                  name="intent"
                  value={g.enabled ? "disable" : "enable"}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                >
                  {g.enabled ? "停用" : "启用"}
                </Button>
              </Form>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="关联新群"
        description="第一个关联的群自动成为主群。关联后由 bot 推送成员名单。"
      >
        <Form method="post" className="flex items-end gap-2">
          <input type="hidden" name="intent" value="link" />
          <Field label="群号">
            <Input name="group_id" inputMode="numeric" required className="w-56" />
          </Field>
          <Button type="submit" disabled={busy}>
            关联
          </Button>
        </Form>
      </Section>
    </>
  );
}
