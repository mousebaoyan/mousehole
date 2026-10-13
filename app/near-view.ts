import { useEffect, type RefObject } from "react";

// Calls `onNear` when the element comes within a screen or so of the viewport, while `active`:
// lists load their next part before the reader reaches the end.
export function useNearView(ref: RefObject<Element | null>, active: boolean, onNear: () => void) {
  useEffect(() => {
    const element = ref.current;
    if (!active || !element) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) onNear();
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active, onNear]);
}
