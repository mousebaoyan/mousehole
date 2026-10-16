import { pageTitle } from "~/share-meta";
import { data, Form, Link } from "react-router";
import { apiContext } from "../api.server.ts";
import { LogoMark } from "~/components/logo";
import { Button, buttonVariants } from "~/components/ui/button";
import type { Route } from "./+types/unsubscribe.ts";
import {
  NOTIFICATION_LABELS,
  NOTIFICATION_TYPES,
} from "../../server/modules/notifications/types.ts";

export function meta() {
  return [{ title: pageTitle("关闭邮件提醒") }];
}

// What the link turns off: a notification type, or the weekly letters.
function kindOf(request: Request) {
  const k = new URL(request.url).searchParams.get("k");
  const kind = [...NOTIFICATION_TYPES, "weekly" as const].find((t) => t === k);
  if (!kind) throw data("链接无效", { status: 404 });
  return kind;
}

export function loader({ request }: Route.LoaderArgs) {
  const kind = kindOf(request);
  return { what: kind === "weekly" ? "每周来信" : `「${NOTIFICATION_LABELS[kind]}」的邮件提醒` };
}

// Opening the link only shows this page: QQ Mail opens links to check them. Mail apps with their
// own unsubscribe button post here as the button does (RFC 8058).
export async function action({ request, context }: Route.ActionArgs) {
  const query = new URL(request.url).searchParams;
  const res = await context.get(apiContext).mail.unsubscribe.$post({
    json: {
      user_id: Number(query.get("u")),
      kind: kindOf(request),
      sig: query.get("s") ?? "",
    },
  });
  if (res.ok) return { error: null };
  return data({ error: (await res.json()).error.message }, 400);
}

export default function Unsubscribe({ loaderData, actionData }: Route.ComponentProps) {
  const done = actionData?.error === null;
  return (
    <>
      <LogoMark className="size-12" />
      <h1 className="mt-4 text-xl font-semibold">{done ? "已关闭" : "关闭邮件提醒"}</h1>
      <p className="mt-1 max-w-xs text-center text-sm text-muted-foreground">
        {done
          ? `以后不再给你发送${loaderData.what}。站内通知不受影响，可以在设置中重新打开`
          : `不再给你发送${loaderData.what}？`}
      </p>
      {!done && (
        <Form method="post" className="mt-6 w-full max-w-xs">
          <Button type="submit" size="lg" className="w-full">
            关闭
          </Button>
        </Form>
      )}
      {actionData?.error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {actionData.error}
        </p>
      )}
      <Link
        to="/settings#notify"
        className={buttonVariants({ variant: "link", className: "mt-2" })}
      >
        管理全部邮件提醒
      </Link>
    </>
  );
}
