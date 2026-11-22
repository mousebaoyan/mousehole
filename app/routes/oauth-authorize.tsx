import { pageTitle } from "~/share-meta";
import { data, Form, redirect, useNavigation } from "react-router";
import { apiContext } from "../api.server.ts";
import { LogoMark } from "~/components/logo";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import type { Route } from "./+types/oauth-authorize.ts";
import { AGENT_POSTING_LEVEL } from "../../server/platform/access.ts";
import { SITE_NAME, STAFF } from "../../server/platform/site.ts";

export function meta() {
  return [{ title: pageTitle("授权应用") }];
}

function toLogin(url: URL) {
  return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
}

// Where an app sends the browser to log in with the forum (docs/api.md §8.3). Our own sites get
// no page to approve on: the browser goes straight back, or to the login page first. An Agent is
// shown here for the member to allow.
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams);
  const api = context.get(apiContext);
  const res = await api.oauth.authorize.$get({ query });
  if (res.status === 401) return toLogin(url);
  if (!res.ok) return data({ error: (await res.json()).error.message, agent: null }, res.status);
  const checked = await res.json();
  if ("redirect_url" in checked) return redirect(checked.redirect_url);
  if (!checked.app.first_party) return { error: null, agent: checked };
  const granted = await api.oauth.authorize.$post({ json: query });
  if (!granted.ok) {
    return data({ error: (await granted.json()).error.message, agent: null }, granted.status);
  }
  return redirect((await granted.json()).redirect_url);
}

// The member's answer. The request stays in the page's address as the Agent sent it.
export async function action({ request, context }: Route.ActionArgs) {
  const url = new URL(request.url);
  const form = await request.formData();
  const approve = form.get("intent") === "approve";
  const ticked = form.getAll("scope");
  const res = await context.get(apiContext).oauth.authorize.$post({
    json: {
      ...Object.fromEntries(url.searchParams),
      approve,
      scopes: approve
        ? (["profile", "read", "act"] as const).filter((s) => ticked.includes(s))
        : undefined,
    },
  });
  // Logged out on another tab while the page was open.
  if (res.status === 401) return toLogin(url);
  if (!res.ok) return data({ error: (await res.json()).error.message }, res.status);
  return redirect((await res.json()).redirect_url);
}

const ALLOWS: Record<string, string> = {
  profile: "查看你的名字、等级和角色",
  read: "搜索和读取你能看到的帖子",
  act: "以你的身份发帖、回复和互动，查看通知",
};

export default function OAuthAuthorize({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const { agent } = loaderData;
  if (!agent) {
    return (
      <>
        <LogoMark className="size-12" />
        <h1 className="mt-4 text-xl font-semibold">无法登录这个应用</h1>
        <p role="alert" className="mt-2 text-sm text-destructive">
          {loaderData.error}
        </p>
      </>
    );
  }
  // `read` covers `profile`; `act` is the one the member may leave unticked.
  const given = agent.scopes.filter(
    (s) => s !== "act" && !(s === "profile" && agent.scopes.includes("read")),
  );
  const belowLevel = agent.level < AGENT_POSTING_LEVEL && !STAFF.includes(agent.role);
  return (
    <>
      <LogoMark className="size-12" />
      <h1 className="mt-4 text-xl font-semibold">授权 Agent</h1>
      <p className="mt-1 max-w-xs text-center text-sm text-muted-foreground">
        「{agent.app.name}」想以你的身份使用{SITE_NAME}
      </p>
      <Form method="post" className="mt-6 flex w-full max-w-xs flex-col gap-3 text-sm">
        <p className="font-medium">允许它：</p>
        <ul className="flex flex-col gap-2">
          {given.map((s) => (
            <li key={s} className="flex items-start gap-2">
              <input type="hidden" name="scope" value={s} />
              <Checkbox checked readOnly disabled className="mt-0.5" aria-hidden />
              {ALLOWS[s]}
            </li>
          ))}
          {agent.scopes.includes("act") && (
            <li>
              <label className="flex items-start gap-2">
                <Checkbox name="scope" value="act" defaultChecked className="mt-0.5" />
                <span>
                  {ALLOWS.act}
                  {belowLevel && (
                    <span className="block text-meta text-muted-foreground">
                      通过 Agent 发内容需要 L{AGENT_POSTING_LEVEL}，你目前是 L{agent.level}
                    </span>
                  )}
                </span>
              </label>
            </li>
          )}
        </ul>
        <p className="text-meta text-muted-foreground">
          名称由应用自己填写。
          {agent.local
            ? "允许后回到你电脑上的 Agent，如果不是你刚在 Agent 里发起的连接，请拒绝"
            : `允许后跳转到 ${agent.redirect_host}`}
        </p>
        <div className="mt-3 flex gap-2">
          <Button
            type="submit"
            name="intent"
            value="deny"
            variant="outline"
            size="lg"
            className="flex-1"
            disabled={busy}
          >
            拒绝
          </Button>
          <Button
            type="submit"
            name="intent"
            value="approve"
            size="lg"
            className="flex-1"
            disabled={busy}
          >
            允许
          </Button>
        </div>
      </Form>
      {actionData?.error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {actionData.error}
        </p>
      )}
    </>
  );
}
