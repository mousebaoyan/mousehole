import { useRouteLoaderData } from "react-router";
import type { loader } from "./routes/forum-layout.tsx";
import { STAFF } from "../server/platform/site.ts";

// What the forum layout loads once for every page under it.
function useForum() {
  const data = useRouteLoaderData<typeof loader>("routes/forum-layout");
  if (!data) throw new Error("Used outside the forum layout");
  return data;
}

export type Board = ReturnType<typeof useBoards>[number];

// The signed-in reader; null for guests.
export function useMe() {
  return useForum().me;
}

export function useBoards() {
  return useForum().boards;
}

// The boards the reader may start threads in, or move them to (design §8.1): moderators all of
// them, members those open to members at their level.
export function usePostableBoards() {
  const me = useMe();
  const staff = me !== null && STAFF.includes(me.role);
  const level = me?.level ?? 0;
  return useBoards().filter(
    (b) => staff || (b.post_role === "user" && Math.max(b.read_level, b.post_level) <= level),
  );
}

export function useTags() {
  return useForum().tags;
}
