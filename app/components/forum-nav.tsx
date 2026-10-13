import { Bookmark, CircleHelp, ExternalLink, Flame, Home } from "lucide-react";
import { Link, NavLink, useLocation } from "react-router";
import { cn } from "cn";
import { boards } from "~/draft-data";

const item = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground/80 hover:bg-accent hover:text-foreground",
    isActive && "bg-brand/15 font-medium text-foreground hover:bg-brand/20",
  );

const feeds = [
  { sort: null, label: "最新", icon: Home },
  { sort: "hot", label: "热门", icon: Flame },
  { sort: "unsolved", label: "待解答", icon: CircleHelp },
];

export function ForumNav() {
  const { pathname, search } = useLocation();
  const sort = pathname === "/" ? new URLSearchParams(search).get("sort") : undefined;
  return (
    <nav className="flex flex-col gap-6 text-sm">
      <div className="flex flex-col gap-0.5">
        {feeds.map((f) => (
          <Link
            key={f.label}
            to={f.sort ? `/?sort=${f.sort}` : "/"}
            className={item({ isActive: sort === f.sort })}
          >
            <f.icon className="size-4" /> {f.label}
          </Link>
        ))}
        <NavLink to="/bookmarks" className={item}>
          <Bookmark className="size-4" /> 收藏
        </NavLink>
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
      <div className="flex flex-col gap-1.5 px-2.5">
        <h2 className="pb-0.5 text-xs font-medium text-muted-foreground">常用标签</h2>
        <div className="flex flex-wrap gap-1.5">
          {["夏令营", "预推免", "简历", "机试", "导师", "定位"].map((t) => (
            <a
              key={t}
              href={`/tags/${t}`}
              className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-accent"
            >
              {t}
            </a>
          ))}
        </div>
      </div>
      <a
        href="https://mousebaoyan.cn/"
        className="flex items-center gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
      >
        鼠群官网 <ExternalLink className="size-3" />
      </a>
    </nav>
  );
}
