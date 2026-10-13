import { useEffect, useRef } from "react";
import { Form, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Route } from "./+types/email.ts";
import { Field, readForm, Result, Section } from "./parts.tsx";

export function meta() {
  return [{ title: "邮件 · 管理后台" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin.settings.$get();
  if (!res.ok) throw new Error("Admin settings failed");
  return { smtp: (await res.json()).smtp };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext);
  if (field("intent") === "test") {
    const res = await api.admin.settings["test-email"].$post({ json: { qq: Number(field("qq")) } });
    if (res.ok) return { ok: true, message: "已发送，请查收" };
    return { ok: false, message: (await res.json()).error.message };
  }
  const password = field("password");
  const res = await api.admin.settings.$patch({
    json: {
      smtp: {
        host: field("host"),
        port: Number(field("port")),
        secure: field("secure") === "on",
        user: field("user"),
        from: field("from"),
        // Left empty, the stored password stays.
        ...(password && { password }),
      },
    },
  });
  if (res.ok) return { ok: true, message: "已保存" };
  return { ok: false, message: (await res.json()).error.message };
}

export default function Email({ loaderData: { smtp }, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const smtpForm = useRef<HTMLFormElement>(null);
  // After a save the fields show what was stored, and the password box empties again.
  useEffect(() => {
    if (actionData?.ok) smtpForm.current?.reset();
  }, [actionData]);
  return (
    <>
      <h1 className="text-xl font-semibold">邮件</h1>
      <p className="mt-1 text-meta text-muted-foreground">
        用于 QQ 邮箱验证码登录。建议用一个 QQ 邮箱发信，发往 qq.com 不容易进垃圾箱
      </p>
      <Result result={actionData} />

      <Form method="post" ref={smtpForm}>
        <Section title="SMTP">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="服务器" hint="QQ 邮箱是 smtp.qq.com">
              <Input name="host" defaultValue={smtp.host} />
            </Field>
            <Field label="端口" hint="SSL 一般是 465">
              <Input name="port" inputMode="numeric" defaultValue={smtp.port} />
            </Field>
            <Field label="账号">
              <Input name="user" defaultValue={smtp.user} autoComplete="off" />
            </Field>
            <Field
              label="密码（授权码）"
              hint={smtp.password_set ? "已设置，不改就留空" : "还没有设置"}
            >
              <Input name="password" type="password" autoComplete="new-password" />
            </Field>
            <Field label="发件人" hint="例如 鼠洞 <bot@qq.com>，留空则用账号">
              <Input name="from" defaultValue={smtp.from} />
            </Field>
          </div>
          <label className="mt-4 flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              name="secure"
              defaultChecked={smtp.secure}
              className="size-4 accent-primary"
            />
            使用 SSL/TLS
          </label>
          <Button type="submit" name="intent" value="save" className="mt-5" disabled={busy}>
            保存
          </Button>
        </Section>
      </Form>

      <Form method="post">
        <Section title="发送测试邮件" description="用上面保存的设置发信">
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
