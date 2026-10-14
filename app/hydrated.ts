import { useSyncExternalStore } from "react";

function subscribe() {
  return () => {};
}

// False while rendering on the server and hydrating, true after: for what only the browser
// shows, such as the composer, which reads its height from localStorage.
export function useHydrated() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
