import {
  Link2,
  LoaderCircle,
  Mail,
  MessageSquareCode,
  MessageCircle,
  Smartphone,
} from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { useEffect, useState } from "react";
import { data, Form, redirect, useFetcher, useNavigation, useRevalidator } from "react-router";
import { apiContext, cookiesFrom } from "../api.server.ts";
import { LogoMark } from "~/components/logo";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import type { Route } from "./+types/login.ts";
import type { action as codeAction } from "./login-code.ts";
import { BOT_NAME, SITE_NAME } from "../../server/platform/site.ts";

export function meta() {
  return [{ title: pageTitle("登录") }];
}

// Also the code login's poll: it shows this browser's code until a bot confirms it, then logs in.
export async function loader({ context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const methods = await (await api.auth.methods.$get()).json();
  if (!methods.code) return { methods, code: null, codeError: null };
  const res = await api.auth.code.$get();
  if (res.status === 410) {
    return data({ methods, code: null, codeError: null }, { headers: cookiesFrom(res) });
  }
  if (!res.ok) return { methods, code: null, codeError: (await res.json()).error.message };
  const state = await res.json();
  if (state.status === "confirmed") return redirect("/", { headers: cookiesFrom(res) });
  return { methods, code: state, codeError: null };
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
  if (field("intent") === "send") {
    const res = await api.auth.email.$post({ json: { qq } });
    if (res.ok) return { qq, sent: true, error: null };
    return { qq, sent: false, error: (await res.json()).error.message };
  }
  const res = await api.auth.email.verify.$post({ json: { qq, code: field("code") } });
  if (res.ok) return redirect("/", { headers: cookiesFrom(res) });
  return { qq, sent: true, error: (await res.json()).error.message };
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const { methods } = loaderData;
  const first = methods.code ? "code" : methods.email ? "email" : "link";
  return (
    <>
      <LogoMark className="size-12" />
      <h1 className="mt-4 text-xl font-semibold">登录{SITE_NAME}</h1>
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
            <CodeLogin code={loaderData.code} error={loaderData.codeError} />
          </TabsContent>

          <TabsContent value="email" className="pt-4">
            <EmailLogin state={actionData} />
          </TabsContent>

          <TabsContent value="link" className="pt-4">
            <ol className="flex flex-col gap-3 text-sm">
              <li className="flex items-center gap-3">
                <MessageCircle className="size-5 shrink-0 text-brand-strong" />
                <span>
                  私聊{BOT_NAME} 发送<span className="mx-1 font-medium">登录</span>
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
        className="mt-4 py-2 text-meta text-muted-foreground hover:text-foreground"
      >
        加入鼠群
      </a>
    </>
  );
}

type CodeState = Route.ComponentProps["loaderData"]["code"];

// Shows this browser's code and polls until a bot confirms it. With no live code (first visit,
// or the last one expired) it asks for one, unless asking just failed.
function CodeLogin({ code, error }: { code: CodeState; error: string | null }) {
  const fetcher = useFetcher<typeof codeAction>();
  const { revalidate } = useRevalidator();
  // Unknown while rendering on the server, so the countdown appears once mounted.
  const [now, setNow] = useState<number | null>(null);
  const askFailed = fetcher.data?.error;

  useEffect(() => {
    if (!code && !error && !askFailed && fetcher.state === "idle") {
      void fetcher.submit(null, { method: "post", action: "/login/code" });
    }
  }, [code, error, askFailed, fetcher]);

  useEffect(() => {
    if (!code) return undefined;
    let ticks = 0;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (++ticks % 2 === 0 && document.visibilityState === "visible") void revalidate();
    }, 1000);
    return () => clearInterval(timer);
  }, [code, revalidate]);

  const message = error ?? askFailed;
  if (message) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
        <Button
          variant="outline"
          onClick={() => void fetcher.submit(null, { method: "post", action: "/login/code" })}
        >
          重新获取
        </Button>
      </div>
    );
  }
  if (!code) {
    return (
      <p className="flex items-center gap-1.5 py-8 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" /> 正在获取口令
      </p>
    );
  }

  const left = now === null ? null : Math.max(0, code.expires_at - Math.floor(now / 1000));
  return (
    <>
      <p className="text-sm text-muted-foreground">{code.hint}</p>
      <div className="mt-2 rounded-xl bg-secondary py-4 text-center font-mono text-3xl font-semibold tracking-[0.2em]">
        {code.code}
      </div>
      <div className="mt-3 flex items-center justify-between text-meta text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <LoaderCircle className="size-3.5 animate-spin" /> 等待确认
        </span>
        {left !== null && (
          <span className="tabular-nums">
            {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
          </span>
        )}
      </div>
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
