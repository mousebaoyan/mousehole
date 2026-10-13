import { Form } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/home.ts";

export function meta() {
  return [{ title: "鼠洞" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).me.$get();
  return { me: res.ok ? await res.json() : null };
}

export default function Home({ loaderData: { me } }: Route.ComponentProps) {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">鼠洞</h1>
      <p className="mt-2 text-muted-foreground">四非计算机保研鼠群的论坛，正在建设中。</p>
      {me && (
        <Form method="post" action="/logout" className="mt-6 flex items-center gap-3">
          <span>已登录：{me.display_name}</span>
          <button type="submit" className="text-sm text-muted-foreground underline">
            退出
          </button>
        </Form>
      )}
    </main>
  );
}
