import { Link } from "react-router";

export function BoardBadge({ board }: { board: { slug: string; name: string; color: string } }) {
  return (
    <Link
      to={`/b/${board.slug}`}
      className="inline-flex items-center gap-1.5 text-foreground/80 hover:text-foreground"
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: board.color }} />
      {board.name}
    </Link>
  );
}
