import { Copy } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { useEffect, useRef } from "react";
import { Form, Link, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button, buttonVariants } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { confirmSubmit } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { Badge, Field, readForm, Result, Section, Time } from "~/components/form-parts";
import type { Route } from "./+types/apps.ts";

export function meta() {
  return [{ title: pageTitle("应用", "管理后台") }];
}

const SCOPES = [
  { scope: "profile", hint: "读取本人的资料，登录用" },
  { scope: "read", hint: "读取本人能看到的全部内容" },
  { scope: "act", hint: "以本人的身份发帖、回复和互动" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin.apps.$get();
  if (!res.ok) throw new Error("Admin apps failed");
  const edit = Number(new URL(request.url).searchParams.get("edit"));
  return { apps: (await res.json()).items, edit };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext).admin.apps;
  const intent = field("intent");
  const param = { id: field("id") };
  const fields = () => ({
    name: field("name"),
    redirect_uris: field("redirect_uris").split(/\s+/).filter(Boolean),
    scopes: SCOPES.map((s) => s.scope).filter((s) => field(s) === "on"),
  });
  if (intent === "create") {
    const res = await api.$post({ json: fields() });
    if (!res.ok) return { ok: false, message: (await res.json()).error.message, secret: null };
    const { client_id, client_secret } = await res.json();
    return { ok: true, message: "已登记", secret: { client_id, client_secret } };
  }
  if (intent === "secret") {
    const res = await api[":id"].secret.$post({ param });
    if (!res.ok) return { ok: false, message: (await res.json()).error.message, secret: null };
    const { client_secret } = await res.json();
    return {
      ok: true,
      message: "已换密钥",
      secret: { client_id: field("client_id"), client_secret },
    };
  }
  const res = await api[":id"].$patch({
    param,
    json: intent === "update" ? fields() : { disabled: intent === "disable" },
  });
  if (res.ok) return { ok: true, message: "已保存", secret: null };
  return { ok: false, message: (await res.json()).error.message, secret: null };
}

type App = Route.ComponentProps["loaderData"]["apps"][number];

export default function Apps({ loaderData: { apps, edit }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const createForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (actionData?.secret) createForm.current?.reset();
  }, [actionData]);
  return (
    <>
      <h1 className="text-xl font-semibold">应用</h1>
      <p className="mt-1 text-meta text-muted-foreground">
        鼠钟等自家网站用论坛的账号登录，不显示授权页。登记后把 client_id 和密钥填进应用的配置
      </p>
      {actionData?.secret ? <NewSecret {...actionData.secret} /> : <Result result={actionData} />}

      <Section title="自家应用">
        {apps.length === 0 && <p className="text-sm text-muted-foreground">暂无应用</p>}
        <ul className="divide-y">
          {apps.map((app) =>
            app.id === edit ? (
              <li key={app.id} className="py-4">
                {/* Posts to the bare page, so saving also leaves edit mode. */}
                <Form method="post" action="/admin/apps">
                  <input type="hidden" name="id" value={app.id} />
                  <AppFields app={app} />
                  <div className="mt-4 flex items-center gap-2">
                    <Button type="submit" name="intent" value="update" disabled={busy}>
                      保存
                    </Button>
                    <Link to="/admin/apps" className={buttonVariants({ variant: "ghost" })}>
                      取消
                    </Link>
                  </div>
                </Form>
              </li>
            ) : (
              <li key={app.id} className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3">
                <div className="min-w-56 flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {app.name}
                    {app.disabled && <Badge>已停用</Badge>}
                  </div>
                  <div className="mt-0.5 font-mono text-xs break-all text-muted-foreground">
                    {app.client_id}
                  </div>
                  <div className="text-xs break-all text-muted-foreground">
                    {app.redirect_uris.join("、")} · {app.scopes.join("、")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {app.tokens} 人的令牌有效 · 最后使用{" "}
                    <Time value={app.last_used_at} never="从未" />
                  </div>
                </div>
                <Form method="post" className="flex shrink-0 items-center gap-1">
                  <input type="hidden" name="id" value={app.id} />
                  <input type="hidden" name="client_id" value={app.client_id} />
                  <Link
                    to={`/admin/apps?edit=${app.id}`}
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    修改
                  </Link>
                  <Button
                    type="submit"
                    name="intent"
                    value="secret"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={confirmSubmit(
                      `给「${app.name}」换一个密钥？旧密钥立即失效，要马上把新的填进应用的配置。`,
                      "换密钥",
                    )}
                  >
                    换密钥
                  </Button>
                  {app.disabled ? (
                    <Button
                      type="submit"
                      name="intent"
                      value="enable"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                    >
                      启用
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      name="intent"
                      value="disable"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={confirmSubmit(
                        `停用「${app.name}」？它的令牌立即失效，大家在那边都会退出，也不能再登录。`,
                        "停用",
                      )}
                    >
                      停用
                    </Button>
                  )}
                </Form>
              </li>
            ),
          )}
        </ul>
      </Section>

      <Form method="post" ref={createForm}>
        <Section title="登记应用" description="密钥只显示一次，忘了可以换一个">
          <AppFields />
          <Button type="submit" name="intent" value="create" className="mt-5" disabled={busy}>
            登记
          </Button>
        </Section>
      </Form>
    </>
  );
}

function AppFields({ app }: { app?: App }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="名称" hint="例如 鼠钟">
          <Input name="name" required maxLength={40} defaultValue={app?.name} />
        </Field>
        <Field
          label="回调地址"
          hint="每行一个，最多 5 个；用 https，本地开发可以是本机的 http 地址"
        >
          <Textarea
            name="redirect_uris"
            required
            rows={2}
            defaultValue={app?.redirect_uris.join("\n")}
          />
        </Field>
      </div>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium">范围</legend>
        <p className="mt-1 text-meta text-muted-foreground">鼠钟只要 profile</p>
        <div className="mt-2 grid gap-x-6 sm:grid-cols-3">
          {SCOPES.map((s) => (
            <label
              key={s.scope}
              className="grid grid-cols-[auto_1fr] items-start gap-x-3 py-1.5 text-sm"
            >
              <Checkbox
                name={s.scope}
                defaultChecked={app ? app.scopes.includes(s.scope) : s.scope === "profile"}
                className="mt-0.5"
              />
              <code className="font-mono">{s.scope}</code>
              <span className="col-start-2 text-meta text-muted-foreground">{s.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
}

// Shown once: the server keeps only a hash of the secret.
function NewSecret({ client_id, client_secret }: { client_id: string; client_secret: string }) {
  return (
    <output className="mt-4 block rounded-2xl border border-success/40 bg-success/5 p-4 text-sm">
      <p className="font-medium text-success">密钥只显示这一次，请立即复制到应用的配置中</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <CopyRow label="client_id" value={client_id} />
        <CopyRow label="密钥" value={client_secret} />
      </dl>
    </output>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate rounded-lg bg-card px-3 py-2 font-mono">{value}</dd>
      <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(value)}>
        <Copy /> 复制
      </Button>
    </>
  );
}
