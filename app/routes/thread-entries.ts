import { data } from "react-router";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/thread-entries.ts";

// Who entered a lottery, for the list under its count; once drawn, in the order drawn. Each with
// the user ID that checking the draw takes.
export async function loader({ params, context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).threads[":id"].lottery.entries.$get({
    param: { id: params.id },
  });
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  return {
    items: (await res.json()).items.map(({ user, prize }) => ({
      user,
      note: `${prize === null ? "" : "中奖 · "}ID ${user.id}`,
    })),
  };
}
