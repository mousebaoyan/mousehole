import { ArrowDown, ArrowUp, Plus, X } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Route } from "./+types/email.ts";
import { Check, Field, readForm, Result, Section } from "~/components/form-parts";
import { Select } from "~/components/ui/select";
import { SettingsForm } from "~/components/settings-form";
import { NOTIFICATION_TYPES } from "~/notification-types";

export function meta() {
  return [{ title: pageTitle("邮件", "管理后台") }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin.settings.$get();
  if (!res.ok) throw new Error("Admin settings failed");
  const { smtp, notify, weekly } = await res.json();
  return { accounts: smtp.accounts, policies: notify.email, weekly };
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
    if (!res.ok) return { ok: false, message: (await res.json()).error.message, notify: true };
    return { ok: true, message: "已保存", notify: true };
  }
  if (field("intent") === "weekly") {
    const res = await api.admin.settings.$patch({
      json: {
        weekly: {
          enabled: field("enabled") === "on",
          min_reads: Number(field("min_reads")),
          min_likes: Number(field("min_likes")),
          top_likes: Number(field("top_likes")),
        },
      },
    });
    if (!res.ok) return { ok: false, message: (await res.json()).error.message, weekly: true };
    return { ok: true, message: "已保存", weekly: true };
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
        通知邮件和登录验证码都从这里的邮箱发出。建议使用 QQ 邮箱，发往 qq.com
        的邮件不易被判为垃圾邮件
      </p>
      <Result
        result={
          actionData && !("notify" in actionData) && !("weekly" in actionData)
            ? actionData
            : undefined
        }
      />

      <Mailboxes key={shown.at} accounts={shown.accounts} busy={busy} />

      <SettingsForm result={actionData && "notify" in actionData ? actionData : undefined}>
        <input type="hidden" name="intent" value="notify" />
        <Section
          title="邮件通知"
          description="设置每类通知是否发送邮件。成员未修改过的开关使用这里的默认值；选择「不发送」后，成员也不能自行开启"
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
        </Section>
      </SettingsForm>

      <SettingsForm result={actionData && "weekly" in actionData ? actionData : undefined}>
        <input type="hidden" name="intent" value="weekly" />
        <Section
          title="每周来信"
          description="每周一 9 点起，给上周被读和获赞都达到门槛、或有回答被采纳的成员发一封信，告诉他们自己的分享帮到了多少人。成员可以在设置中关闭"
        >
          <Check name="enabled" label="发送每周来信" checked={loaderData.weekly.enabled} />
          <div className="mt-3 flex flex-wrap gap-4">
            <Field label="被读至少（次）">
              <Input
                name="min_reads"
                type="number"
                min={0}
                defaultValue={loaderData.weekly.min_reads}
                required
                className="w-28"
              />
            </Field>
            <Field label="同时获赞至少（次）">
              <Input
                name="min_likes"
                type="number"
                min={0}
                defaultValue={loaderData.weekly.min_likes}
                required
                className="w-28"
              />
            </Field>
            <Field label="写进信里的楼层获赞至少（次）">
              <Input
                name="top_likes"
                type="number"
                min={1}
                defaultValue={loaderData.weekly.top_likes}
                required
                className="w-28"
              />
            </Field>
          </div>
        </Section>
      </SettingsForm>

      <Form method="post">
        <Section title="发送测试邮件" description="用每个已保存的邮箱各发送一封">
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
        description="按顺序使用，一个发送失败时自动换用下一个。出错的邮箱暂停 10 分钟，连续出错时暂停时间逐次加倍"
      >
        <input type="hidden" name="count" value={rows.length} />
        {rows.length === 0 && <p className="text-sm text-muted-foreground">暂无发信邮箱</p>}
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
                  hint={r.password_set ? "已设置；不修改请留空" : "未设置"}
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
