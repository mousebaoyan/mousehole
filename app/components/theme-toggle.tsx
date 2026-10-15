import { Moon, Sun } from "lucide-react";
import type { MouseEvent } from "react";
import { Button } from "~/components/ui/button";

function apply() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
}

// The new theme spreads in a circle from the button. Browsers without view transitions, such as
// older QQ ones, fade the colors instead.
function toggle(e: MouseEvent) {
  const root = document.documentElement;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();
  if (!("startViewTransition" in document)) {
    root.dataset.themeFade = "";
    apply();
    setTimeout(() => delete root.dataset.themeFade, 400);
    return;
  }
  const { clientX: x, clientY: y } = e;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  void document
    .startViewTransition(apply)
    .ready.then(() =>
      root.animate(
        { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 500, easing: "ease-in-out", pseudoElement: "::view-transition-new(root)" },
      ),
    );
}

export function ThemeToggle() {
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换深色模式">
      {/* Each turns in as it's shown: an animation starts again when display stops being none. */}
      <Sun className="animate-in spin-in-90 zoom-in-50 duration-500 dark:hidden" />
      <Moon className="hidden animate-in spin-in-90 zoom-in-50 duration-500 dark:block" />
    </Button>
  );
}
