import { useSyncExternalStore } from "react";

function subscribe() {
  return () => {};
}

// False while rendering on the server and hydrating, true after: for state that only the browser
// has, such as drafts in localStorage.
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
