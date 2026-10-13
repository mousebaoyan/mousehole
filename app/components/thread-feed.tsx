import { PenSquare } from "lucide-react";
import { Link } from "react-router";
import { cn } from "cn";
import { ThreadList } from "~/components/thread-list";
import type { Thread } from "~/draft-data";

const sorts = [
  { key: "latest", label: "最新" },
  { key: "hot", label: "热门" },
  { key: "unsolved", label: "待解答" },
];

export function ThreadFeed({
  threads,
  sort,
  showBoard = true,
}: {
  threads: Thread[];
  sort: string;
  showBoard?: boolean;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-1 px-1">
        {sorts.map((s) => (
          <Link
            key={s.key}
            to={s.key === "latest" ? "?" : `?sort=${s.key}`}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground",
              sort === s.key && "bg-secondary font-medium text-foreground",
            )}
          >
            {s.label}
          </Link>
        ))}
      </div>
      <ThreadList threads={threads} showBoard={showBoard} />
      <Link
        to="/new"
        aria-label="发帖"
        className="fixed right-5 bottom-6 z-30 flex size-13 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg sm:hidden"
      >
        <PenSquare className="size-5" />
      </Link>
    </section>
  );
}
