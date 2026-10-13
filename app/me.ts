import { useRouteLoaderData } from "react-router";
import type { loader } from "./routes/forum-layout.tsx";

// The signed-in reader under the forum layout; null for guests.
export function useMe() {
  return useRouteLoaderData<typeof loader>("routes/forum-layout")?.me ?? null;
}
