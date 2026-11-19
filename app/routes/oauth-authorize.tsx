import { pageTitle } from "~/share-meta";
import { data, redirect } from "react-router";
import { apiContext } from "../api.server.ts";
import { LogoMark } from "~/components/logo";
import type { Route } from "./+types/oauth-authorize.ts";

export function meta() {
  return [{ title: pageTitle("登录应用") }];
}

// Where an app sends the browser to log in with the forum (docs/api.md §8.3). Our own sites get
// no page to approve on: the browser goes straight back, or to the login page first.
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const res = await context
    .get(apiContext)
    .oauth.authorize.$post({ json: Object.fromEntries(url.searchParams) });
  if (res.ok) return redirect((await res.json()).redirect_url);
  if (res.status === 401) {
    return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  return data({ error: (await res.json()).error.message }, res.status);
}

export default function OAuthAuthorize({ loaderData }: Route.ComponentProps) {
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
