import { data } from "react-router";
import { apiContext, cookiesFrom } from "../api.server.ts";
import type { Route } from "./+types/login-code.ts";

// Asks for a login code for this browser. A POST from the login page rather than part of its
// loader: a page load carries no Origin header and must not create anything.
export async function action({ context }: Route.ActionArgs) {
  const res = await context.get(apiContext).auth.code.$post();
  if (res.ok) return data({ error: null }, { headers: cookiesFrom(res) });
  return { error: (await res.json()).error.message };
}
