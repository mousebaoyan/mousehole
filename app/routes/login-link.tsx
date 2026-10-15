import { pageTitle } from "~/share-meta";
import { data, Form, redirect } from "react-router";
import { apiContext, cookiesFrom } from "../api.server.ts";
import { LogoMark } from "~/components/logo";
import { Button } from "~/components/ui/button";
import type { Route } from "./+types/login-link.ts";
import { SITE_NAME } from "../../server/platform/site.ts";

export function meta() {
  return [{ title: pageTitle("确认登录") }];
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
    <>
      <LogoMark className="size-12" />
      <h1 className="mt-4 text-xl font-semibold">确认登录</h1>
      <p className="mt-1 text-sm text-muted-foreground">确认后，此设备将登录{SITE_NAME}</p>
      <Form method="post" className="mt-6 w-full max-w-xs">
        <Button type="submit" size="lg" className="w-full">
          确认登录
        </Button>
      </Form>
      {actionData && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {actionData.error}
        </p>
      )}
    </>
  );
}
