import { Copy } from "lucide-react";
import { useEffect, useRef } from "react";
import { Form, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Route } from "./+types/tokens.ts";
import { Badge, Field, readForm, Result, Section, Time } from "./parts.tsx";

export function meta() {
  return [{ title: "bot · 管理后台" }];
}

const SCOPES = [
  { scope: "read", hint: "读取全部内容，包括仅成员版块和 QQ 号" },
  { scope: "act", hint: "以群友身份发帖、回复、点赞等" },
  { scope: "moderate", hint: "版主操作：审核、置顶、锁定、禁言等" },
  { scope: "admin", hint: "管理员操作：封禁、设置角色、站点设置等" },
  { scope: "sync", hint: "推送 QQ 群资料和成员名单" },
  { scope: "auth", hint: "确认登录口令、签发登录链接" },
  { scope: "events", hint: "订阅事件流" },
] as const;

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin.tokens.$get();
  if (!res.ok) throw new Error("Admin tokens failed");
  return { tokens: (await res.json()).items };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext);
  if (field("intent") === "revoke") {
    const res = await api.admin.tokens[":id"].$delete({ param: { id: field("id") } });
    if (res.ok) return { ok: true, message: "已吊销", token: null };
    return { ok: false, message: (await res.json()).error.message, token: null };
  }
  const res = await api.admin.tokens.$post({
    json: {
      name: field("name"),
      bot_qq: Number(field("bot_qq")),
      scopes: SCOPES.map((s) => s.scope).filter((s) => field(s) === "on"),
    },
  });
  if (res.ok) return { ok: true, message: "已创建", token: (await res.json()).token };
  return { ok: false, message: (await res.json()).error.message, token: null };
}

export default function Tokens({ loaderData: { tokens }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const createForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (actionData?.token) createForm.current?.reset();
  }, [actionData]);
  return (
    <>
      <h1 className="text-xl font-semibold">bot</h1>
      <p className="mt-1 text-meta text-muted-foreground">
        插件用 token 调用论坛接口。每个 token 绑定一个 bot 账号，按需要勾选范围
      </p>
      {actionData?.token ? <NewToken token={actionData.token} /> : <Result result={actionData} />}

      <Section title="token">
        {tokens.length === 0 && <p className="text-sm text-muted-foreground">还没有创建 token</p>}
        <ul className="divide-y">
          {tokens.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
              <div className="min-w-56 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  {t.name}
                  {t.revoked_at !== null && <Badge>已吊销</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t.bot.display_name}（{t.bot.qq}）· {t.scopes.join("、")}
                </div>
                <div className="text-xs text-muted-foreground">
                  创建于 <Time value={t.created_at} /> · 最后使用{" "}
                  <Time value={t.last_used_at} never="从未" />
                </div>
              </div>
              {t.revoked_at === null && (
                <Form
                  method="post"
                  onSubmit={(e) => {
                    if (!confirm(`吊销「${t.name}」后，用它的插件会立刻无法调用接口。确定吗？`)) {
                      e.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="id" value={t.id} />
                  <Button
                    type="submit"
                    name="intent"
                    value="revoke"
                    variant="destructive"
                    size="sm"
                    disabled={busy}
                  >
                    吊销
                  </Button>
                </Form>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Form method="post" ref={createForm}>
        <Section title="新建 token" description="bot 的 QQ 号还没同步过也可以，会先建一个 bot 账号">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="名称" hint="例如 AstrBot 主插件">
              <Input name="name" required maxLength={40} />
            </Field>
            <Field label="bot 的 QQ 号">
              <Input name="bot_qq" inputMode="numeric" required />
            </Field>
          </div>
          <fieldset className="mt-4">
            <legend className="text-sm font-medium">范围</legend>
            <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
              {SCOPES.map((s) => (
                <label
                  key={s.scope}
                  className="grid grid-cols-[auto_1fr] items-start gap-x-3 py-1.5 text-sm"
                >
                  <input type="checkbox" name={s.scope} className="mt-0.5 size-4 accent-primary" />
                  <code className="font-mono">{s.scope}</code>
                  <span className="col-start-2 text-meta text-muted-foreground">{s.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" name="intent" value="create" className="mt-5" disabled={busy}>
            创建
          </Button>
        </Section>
      </Form>
    </>
  );
}

// Shown once: the server keeps only a hash of it.
function NewToken({ token }: { token: string }) {
  return (
    <output className="mt-4 block rounded-2xl border border-success/40 bg-success/5 p-4 text-sm">
      <p className="font-medium text-success">已创建。token 只显示这一次，请现在复制到插件里</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-card px-3 py-2 font-mono">
          {token}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(token)}
        >
          <Copy /> 复制
        </Button>
      </div>
    </output>
  );
}
