import { Moon, Sun } from "lucide-react";
import { Button } from "~/components/ui/button";

function toggle() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
}

export function ThemeToggle() {
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换深色模式">
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  );
}
