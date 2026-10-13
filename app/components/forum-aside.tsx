import { UsersRound } from "lucide-react";
import { Link } from "react-router";
import { group, threads } from "~/draft-data";

export function ForumAside() {
  const full = group.members / group.capacity;
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-4 xl:flex">
      <section className="rounded-2xl border bg-card p-4">
        <h2 className="text-sm font-semibold">{group.name}</h2>
        <p className="mt-1.5 flex items-center gap-1.5 text-meta text-muted-foreground tabular-nums">
          <UsersRound className="size-3.5" />
          {group.members.toLocaleString()} / {group.capacity.toLocaleString()}
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-brand" style={{ width: `${full * 100}%` }} />
        </div>
      </section>
      <section className="rounded-2xl border bg-card p-4">
        <h2 className="text-sm font-semibold">本周热门</h2>
        <ol className="mt-2 flex flex-col">
          {threads
            .filter((t) => !t.pinned)
            .toSorted((a, b) => b.views - a.views)
            .slice(0, 5)
            .map((t, i) => (
              <li key={t.id} className="flex gap-2.5 py-1.5 text-meta leading-snug">
                <span className="w-3 shrink-0 font-medium text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <Link to={`/t/${t.id}`} className="line-clamp-2 hover:text-link">
                  {t.title}
                </Link>
              </li>
            ))}
        </ol>
      </section>
    </aside>
  );
}
