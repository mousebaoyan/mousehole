import { Bookmark, ExternalLink, History, Home, MessagesSquare } from "lucide-react";
import { Link, NavLink } from "react-router";
import { cn } from "cn";
import { useBoards, useMe, useTags } from "~/forum";

const item = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground/80 hover:bg-accent hover:text-foreground",
    isActive && "bg-brand/15 font-medium text-foreground hover:bg-brand/20",
  );

// Where to look; how to sort and filter a list sits above the list itself.
const mine = [
  { to: "/my/posts", label: "我的帖子", icon: MessagesSquare },
  { to: "/my/bookmarks", label: "收藏", icon: Bookmark },
  { to: "/my/read", label: "已读", icon: History },
];

export function ForumNav() {
  const me = useMe();
  const boards = useBoards();
  // Schools and majors are many; they stay in the list's tag filter.
  const topics = useTags().filter((t) => t.kind === "topic");
  return (
    <nav className="flex flex-col gap-6 text-sm">
      <div className="flex flex-col gap-0.5">
        <NavLink to="/" end className={item}>
          <Home className="size-4" /> 全部帖子
        </NavLink>
        {me &&
          mine.map((m) => (
            <NavLink key={m.to} to={m.to} className={item}>
              <m.icon className="size-4" /> {m.label}
            </NavLink>
          ))}
      </div>
      <div className="flex flex-col gap-0.5">
        <h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">版块</h2>
        {boards.map((b) => (
          <NavLink key={b.slug} to={`/b/${b.slug}`} className={item}>
            <span className="ml-1 size-2 rounded-full" style={{ backgroundColor: b.color }} />
            <span className="ml-0.5 flex-1">{b.name}</span>
          </NavLink>
        ))}
      </div>
      {topics.length > 0 && (
        <div className="flex flex-col gap-1.5 px-2.5">
          <h2 className="pb-0.5 text-xs font-medium text-muted-foreground">标签</h2>
          <div className="flex flex-wrap gap-1.5">
            {topics.map((t) => (
              <Link
                key={t.id}
                to={`/?tag=${encodeURIComponent(t.name)}`}
                className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-accent"
              >
                {t.name}
              </Link>
            ))}
          </div>
        </div>
      )}
      <a
        href="https://mousebaoyan.cn/"
        className="flex items-center gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
      >
        鼠群官网 <ExternalLink className="size-3" />
      </a>
    </nav>
  );
}
