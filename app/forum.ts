import { useRouteLoaderData } from "react-router";
import type { loader } from "./routes/forum-layout.tsx";

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

export function useTags() {
  return useForum().tags;
}
