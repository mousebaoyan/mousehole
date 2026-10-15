import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Route } from "./+types/email.ts";
import { Check, Field, readForm, Result, Section } from "~/components/form-parts";
import { Select } from "~/components/ui/select";
import { NOTIFICATION_TYPES } from "~/notification-types";

export function meta() {
  return [{ title: "邮件 · 管理后台" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin.settings.$get();
  if (!res.ok) throw new Error("Admin settings failed");
  const { smtp, notify } = await res.json();
  return { accounts: smtp.accounts, policies: notify.email };
}

const POLICIES = [
  { value: "on", label: "默认发送" },
  { value: "off", label: "默认不发" },
  { value: "never", label: "不发送" },
] as const;

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext);
  if (field("intent") === "test") {
    const res = await api.admin.settings["test-email"].$post({ json: { qq: Number(field("qq")) } });
    if (!res.ok) return { ok: false, message: (await res.json()).error.message };
    const { results } = await res.json();
    return {
      ok: results.every((r) => r.error === null),
      message: results
        .map((r) => (r.error === null ? `${r.user} 已发送` : `${r.user} 发送失败：${r.error}`))
        .join("；"),
    };
  }
  if (field("intent") === "notify") {
    const email = Object.fromEntries(
      NOTIFICATION_TYPES.map(({ type }) => [
        type,
        POLICIES.find((p) => p.value === field(`email.${type}`))?.value,
      ]),
    );
    const res = await api.admin.settings.$patch({ json: { notify: { email } } });
    if (!res.ok) return { ok: false, message: (await res.json()).error.message };
    return { ok: true, message: "已保存" };
  }
  const accounts = Array.from({ length: Number(field("count")) }, (_, i) => {
    const password = field(`password.${i}`);
    return {
      host: field(`host.${i}`),
      port: Number(field(`port.${i}`)),
      secure: field(`secure.${i}`) === "on",
      user: field(`user.${i}`),
      // Left empty, the password stored for this address stays.
      ...(password && { password }),
    };
  });
  const res = await api.admin.settings.$patch({ json: { smtp: { accounts } } });
  if (!res.ok) return { ok: false, message: (await res.json()).error.message };
  // Read back here: the page gets this before the loader has run again.
  const stored = await api.admin.settings.$get();
  if (!stored.ok) throw new Error("Admin settings failed");
  return {
    ok: true,
    message: "已保存",
    stored: { at: Date.now(), accounts: (await stored.json()).smtp.accounts },
  };
}

export default function Email({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  // Each save starts the list over from what was stored, which empties the password boxes; a
  // failed save keeps what was typed.
  const [shown, setShown] = useState({ at: 0, accounts: loaderData.accounts });
  if (actionData?.stored && actionData.stored.at !== shown.at) setShown(actionData.stored);
  return (
    <>
      <h1 className="text-xl font-semibold">邮件</h1>
      <p className="mt-1 text-meta text-muted-foreground">
        通知邮件和 QQ 邮箱验证码都从这里发。建议用 QQ 邮箱，发往 qq.com 不容易进垃圾箱
      </p>
      <Result result={actionData} />

      <Mailboxes key={shown.at} accounts={shown.accounts} busy={busy} />

      <Form method="post">
        <Section
          title="邮件通知"
          description="每类通知是否发邮件。成员没改过的按这里的默认；选「不发送」后，成员也不能自己打开"
        >
          <ul className="divide-y text-sm">
            {NOTIFICATION_TYPES.map(({ type, label }) => (
              <li key={type} className="flex items-center gap-3 py-1.5">
                <span className="flex-1">{label}</span>
                <Select
                  name={`email.${type}`}
                  defaultValue={loaderData.policies[type]}
                  options={POLICIES}
                  aria-label={`${label}的邮件`}
                  className="w-32"
                />
              </li>
            ))}
          </ul>
          <Button type="submit" name="intent" value="notify" disabled={busy} className="mt-4">
            保存
          </Button>
        </Section>
      </Form>

      <Form method="post">
        <Section title="发送测试邮件" description="上面保存的每个邮箱各发一封">
          <div className="flex items-end gap-2">
            <Field label="收件 QQ 号">
              <Input name="qq" inputMode="numeric" required className="w-56" />
            </Field>
            <Button type="submit" name="intent" value="test" variant="outline" disabled={busy}>
              发送
            </Button>
          </div>
        </Section>
      </Form>
    </>
  );
}

type Mailbox = Route.ComponentProps["loaderData"]["accounts"][number];

function Mailboxes({ accounts, busy }: { accounts: Mailbox[]; busy: boolean }) {
  // Keys stay with their rows while rows are added, moved and removed, and so do the typed values.
  const [rows, setRows] = useState(() => accounts.map((a, key) => ({ ...a, key })));
  const move = (from: number, to: number) => {
    const next = [...rows];
    next.splice(to, 0, ...next.splice(from, 1));
    setRows(next);
  };
  const add = () => {
    const key = Math.max(-1, ...rows.map((r) => r.key)) + 1;
    const fresh = { host: "smtp.qq.com", port: 465, secure: true, user: "", password_set: false };
    setRows([...rows, { ...fresh, key }]);
  };
  return (
    <Form method="post">
      <Section
        title="发信邮箱"
        description="按顺序用，一个发不出去就自动换下一个。出错的先歇 10 分钟，接连出错歇得越来越久"
      >
        <input type="hidden" name="count" value={rows.length} />
        {rows.length === 0 && <p className="text-sm text-muted-foreground">还没有发信邮箱</p>}
        <ol className="flex flex-col gap-3">
          {rows.map((r, i) => (
            <li key={r.key} className="rounded-xl border p-4">
              <div className="mb-3 flex items-center gap-1">
                <span className="mr-auto text-sm font-medium">邮箱 {i + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="上移"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="下移"
                  disabled={i === rows.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除"
                  onClick={() => setRows(rows.filter((other) => other.key !== r.key))}
                >
                  <X />
                </Button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="服务器">
                  <Input name={`host.${i}`} defaultValue={r.host} required />
                </Field>
                <Field label="端口">
                  <Input name={`port.${i}`} inputMode="numeric" defaultValue={r.port} required />
                </Field>
                <Field label="账号">
                  <Input name={`user.${i}`} defaultValue={r.user} autoComplete="off" required />
                </Field>
                <Field
                  label="密码（授权码）"
                  hint={r.password_set ? "已设置，不改就留空" : "还没有设置"}
                >
                  <Input name={`password.${i}`} type="password" autoComplete="new-password" />
                </Field>
              </div>
              <div className="mt-3">
                <Check name={`secure.${i}`} label="使用 SSL/TLS" checked={r.secure} />
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex gap-2">
          <Button type="button" variant="outline" onClick={add}>
            <Plus />
            添加邮箱
          </Button>
          <Button type="submit" name="intent" value="save" disabled={busy}>
            保存
          </Button>
        </div>
      </Section>
    </Form>
  );
}
