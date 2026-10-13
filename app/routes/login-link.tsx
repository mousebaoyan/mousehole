import { data, Form, redirect } from "react-router";
import { apiContext, cookiesFrom } from "../api.server.ts";
import type { Route } from "./+types/login-link.ts";

export function meta() {
  return [{ title: "确认登录 · 鼠洞" }];
}

// Opening the link only shows this page. QQ fetches links in chats for previews,
// so the link is spent only when the button is pressed.
export async function action({ request, context }: Route.ActionArgs) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const res = await context.get(apiContext).auth.link.$post({ json: { token } });
  if (res.ok) return redirect("/", { headers: cookiesFrom(res) });
  const { error } = await res.json();
  return data({ error: error.message }, 400);
}

export default function LoginLink({ actionData }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-xl font-semibold">登录鼠洞</h1>
      <p className="mt-2 text-muted-foreground">
        这是机器人发给你的一次性登录链接，10 分钟内有效。
      </p>
      <Form method="post" className="mt-6">
        <button
          type="submit"
          className="w-full rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-foreground"
        >
          确认登录
        </button>
      </Form>
      {actionData && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {actionData.error}
        </p>
      )}
    </main>
  );
}
