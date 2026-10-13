import {
  Link2,
  LoaderCircle,
  Mail,
  MessageSquareCode,
  MessageCircle,
  Smartphone,
} from "lucide-react";
import { Form, redirect, useNavigation } from "react-router";
import { apiContext, cookiesFrom } from "../api.server.ts";
import { LogoMark } from "~/components/logo";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import type { Route } from "./+types/login.ts";

export function meta() {
  return [{ title: "登录 · 鼠洞" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).auth.methods.$get();
  return { methods: await res.json() };
}

// The QQ mailbox form: one step sends the code, the next logs in with it.
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const api = context.get(apiContext);
  const qq = Number(field("qq"));
  if (form.get("intent") === "send") {
    const res = await api.auth.email.$post({ json: { qq } });
    if (res.ok) return { qq, sent: true, error: null };
    return { qq, sent: false, error: (await res.json()).error.message };
  }
  const res = await api.auth.email.verify.$post({ json: { qq, code: field("code") } });
  if (res.ok) return redirect("/", { headers: cookiesFrom(res) });
  return { qq, sent: true, error: (await res.json()).error.message };
}

export default function Login({ loaderData: { methods }, actionData }: Route.ComponentProps) {
  const first = methods.code ? "code" : methods.email ? "email" : "link";
  return (
    <>
      <LogoMark className="size-12" />
      <h1 className="mt-4 text-xl font-semibold">登录鼠洞</h1>
      <p className="mt-1 text-sm text-muted-foreground">仅限鼠群成员，使用 QQ 号登录</p>
      <div className="mt-6 w-full max-w-sm rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
        <Tabs defaultValue={actionData ? "email" : first}>
          <TabsList className="w-full">
            {methods.code && (
              <TabsTrigger value="code">
                <MessageSquareCode /> 口令
              </TabsTrigger>
            )}
            {methods.email && (
              <TabsTrigger value="email">
                <Mail /> QQ 邮箱
              </TabsTrigger>
            )}
            {methods.link && (
              <TabsTrigger value="link">
                <Link2 /> 链接
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="code" className="pt-4">
            <p className="text-sm text-muted-foreground">私聊机器人发送</p>
            <div className="mt-2 rounded-xl bg-secondary py-4 text-center">
              <span className="text-sm text-muted-foreground">登录 </span>
              <span className="font-mono text-3xl font-semibold tracking-[0.2em]">482913</span>
            </div>
            <div className="mt-3 flex items-center justify-between text-meta text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle className="size-3.5 animate-spin" /> 等待确认
              </span>
              <span className="tabular-nums">04:32</span>
            </div>
          </TabsContent>

          <TabsContent value="email" className="pt-4">
            <EmailLogin state={actionData} />
          </TabsContent>

          <TabsContent value="link" className="pt-4">
            <ol className="flex flex-col gap-3 text-sm">
              <li className="flex items-center gap-3">
                <MessageCircle className="size-5 shrink-0 text-brand-strong" />
                <span>
                  私聊机器人发送<span className="mx-1 font-medium">登录链接</span>
                </span>
              </li>
              <li className="flex items-center gap-3">
                <Smartphone className="size-5 shrink-0 text-brand-strong" />
                在手机 QQ 中打开收到的链接
              </li>
            </ol>
            <p className="mt-4 text-meta text-muted-foreground">链接 10 分钟内有效，仅可使用一次</p>
          </TabsContent>
        </Tabs>
      </div>
      <a
        href="https://mousebaoyan.cn/join"
        className="mt-6 text-meta text-muted-foreground hover:text-foreground"
      >
        加入鼠群
      </a>
    </>
  );
}

function EmailLogin({ state }: { state: Route.ComponentProps["actionData"] }) {
  const busy = useNavigation().state !== "idle";
  return (
    <Form method="post" className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Input
          name="qq"
          inputMode="numeric"
          autoComplete="username"
          placeholder="QQ 号"
          aria-label="QQ 号"
          defaultValue={state?.qq || undefined}
          required
        />
        <Button
          type="submit"
          name="intent"
          value="send"
          variant="outline"
          className="shrink-0"
          disabled={busy}
        >
          {state?.sent ? "重新发送" : "发送验证码"}
        </Button>
      </div>
      {state?.sent && (
        <>
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 位验证码"
            aria-label="验证码"
            maxLength={6}
          />
          <Button type="submit" name="intent" value="verify" className="w-full" disabled={busy}>
            登录
          </Button>
        </>
      )}
      {state?.error && (
        <p role="alert" className="text-meta text-destructive">
          {state.error}
        </p>
      )}
      <p className="text-meta text-muted-foreground">
        {state?.sent
          ? `验证码已发送至 ${state.qq}@qq.com，10 分钟内有效`
          : "验证码发送至 QQ 邮箱，10 分钟内有效"}
      </p>
    </Form>
  );
}
