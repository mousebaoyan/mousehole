import { cn } from "~/cn";

// How far along something is (the next level's, a badge's), full once `have` reaches `need`. The
// numbers are written next to it, so it is only for looking at.
export function ProgressBar({
  have,
  need,
  className,
}: {
  have: number;
  need: number;
  className?: string;
}) {
  return (
    <div aria-hidden className={cn("h-1.5 overflow-hidden rounded-full bg-secondary", className)}>
      <div
        className={cn("h-full rounded-full", have >= need ? "bg-primary" : "bg-primary/50")}
        style={{ width: `${Math.min(100, (have / need) * 100)}%` }}
      />
    </div>
  );
}
