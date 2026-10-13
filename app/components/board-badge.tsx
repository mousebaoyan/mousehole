import { Link } from "react-router";

export function BoardBadge({ board }: { board: { slug: string; name: string; color: string } }) {
  return (
    <Link
      to={`/b/${board.slug}`}
      className="relative inline-flex items-center gap-1.5 rounded-full px-2 py-px text-xs font-medium text-foreground/80 after:absolute after:-inset-x-1 after:-inset-y-1.5 hover:text-foreground"
      style={{ backgroundColor: `color-mix(in oklab, ${board.color} 15%, transparent)` }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: board.color }} />
      {board.name}
    </Link>
  );
}
