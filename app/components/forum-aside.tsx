import { Link } from "react-router";
import { group, threads } from "~/draft-data";

export function ForumAside() {
  const full = group.members / group.capacity;
  return (
    <aside className="hidden w-72 shrink-0 flex-col gap-4 xl:flex">
      <section className="rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">{group.name}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {group.members.toLocaleString()} / {group.capacity.toLocaleString()} 人
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
          <div className="h-full rounded-full bg-primary" style={{ width: `${full * 100}%` }} />
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          论坛账号就是你的 QQ 号。群快满了，满员后会开新群，两个群的账号互通。
        </p>
      </section>
      <section className="rounded-2xl border p-4">
        <h2 className="text-sm font-semibold">本周热门</h2>
        <ol className="mt-2 flex flex-col">
          {threads
            .filter((t) => !t.pinned)
            .toSorted((a, b) => b.views - a.views)
            .slice(0, 5)
            .map((t, i) => (
              <li key={t.id} className="flex gap-2.5 py-1.5 text-[13px] leading-snug">
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
