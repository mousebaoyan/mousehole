import { useState } from "react";
import { Link, NavLink } from "react-router";
import { cn } from "~/cn";
import {
  Award,
  Bookmark,
  CirclePlay,
  CircleQuestionMark,
  FilePen,
  History,
  Home,
  Library,
  Lock,
  MessagesSquare,
  NotebookPen,
} from "~/components/icons";
import { useDrafts } from "~/components/composer";
import { useBoards, useMe, useTags, type Board } from "~/forum";
import { MAIN_SITE, STAFF } from "../../server/platform/site.ts";

const item = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-foreground/80 hover:bg-accent hover:text-foreground",
    isActive && "bg-brand/15 font-medium text-foreground hover:bg-brand/20",
  );

// Where to look; how to sort and filter a list sits above the list itself.
const mine = [
  { to: "/my/posts", label: "我的帖子", icon: MessagesSquare, count: "posted" },
  { to: "/my/bookmarks", label: "收藏", icon: Bookmark, count: "bookmarked" },
  { to: "/my/read", label: "已读", icon: History, count: "read" },
] as const;

// The main site's sections, as its own header lists them.
const mainSite = [
  { path: "/resources", label: "保研资源", icon: Library },
  { path: "/experiences", label: "保研经验", icon: NotebookPen },
  { path: "/talks", label: "直播回放", icon: CirclePlay },
  { path: "/faq", label: "常见问题", icon: CircleQuestionMark },
];

// The topics with the most threads; the rest open on request.
const TOPICS_SHOWN = 10;

function Count({ n }: { n: number }) {
  return n > 0 && <span className="ml-auto text-xs text-muted-foreground tabular-nums">{n}</span>;
}

export function ForumNav() {
  const me = useMe();
  const drafts = useDrafts();
  const boards = useBoards();
  const [allTopics, setAllTopics] = useState(false);
  const staff = me !== null && STAFF.includes(me.role);
  // Out of reach until a level (design §6.6); the board's page says how to get there.
  const locked = (b: Board) => me !== null && !staff && b.read_level > me.level;
  // Schools and majors are many; they stay in the list's tag filter. Tags come most used first.
  const topics = useTags().filter((t) => t.kind === "topic");
  return (
    <nav className="flex flex-col gap-6 text-sm">
      <div className="flex flex-col gap-0.5">
        <NavLink to="/" end className={item}>
          <Home className="size-4" /> 全部帖子
          <Count n={boards.filter((b) => !locked(b)).reduce((sum, b) => sum + b.thread_count, 0)} />
        </NavLink>
        {me &&
          mine.map((m) => (
            <NavLink key={m.to} to={m.to} className={item}>
              <m.icon className="size-4" /> {m.label}
              <Count n={me.counts[m.count]} />
            </NavLink>
          ))}
        <NavLink to="/badges" className={item}>
          <Award className="size-4" /> 徽章
          {me && <Count n={me.counts.badges} />}
        </NavLink>
        {drafts.size > 0 && (
          <NavLink to="/drafts" className={item}>
            <FilePen className="size-4" /> 草稿
            <Count n={drafts.size} />
          </NavLink>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">版块</h2>
        {boards.map((b) => (
          <NavLink key={b.slug} to={`/b/${b.slug}`} className={item}>
            <span className="ml-1 size-2 rounded-full" style={{ backgroundColor: b.color }} />
            <span className="ml-0.5 flex-1">{b.name}</span>
            {locked(b) ? (
              <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                <Lock className="size-3" /> L{b.read_level}
              </span>
            ) : (
              <Count n={b.thread_count} />
            )}
          </NavLink>
        ))}
      </div>
      {/* Wider screens link to it from the header. */}
      <div className="flex flex-col gap-0.5 xl:hidden">
        <a
          href={MAIN_SITE}
          className="flex items-center gap-1.5 px-2.5 pb-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <img src="/mousebaoyan.webp" alt="" width={16} height={16} className="rounded" />
          鼠群官网
        </a>
        {mainSite.map((s) => (
          <a key={s.path} href={MAIN_SITE + s.path} className={item({ isActive: false })}>
            <s.icon className="size-4" /> {s.label}
          </a>
        ))}
      </div>
      {topics.length > 0 && (
        <div className="flex flex-col gap-1.5 px-2.5">
          <h2 className="pb-0.5 text-xs font-medium text-muted-foreground">标签</h2>
          <div className="flex flex-wrap gap-1.5">
            {(allTopics ? topics : topics.slice(0, TOPICS_SHOWN)).map((t) => (
              <Link
                key={t.id}
                to={`/?tag=${encodeURIComponent(t.name)}`}
                className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground hover:bg-accent"
              >
                {t.name}
                {t.thread_count > 0 && (
                  <span className="ml-1 text-muted-foreground tabular-nums">{t.thread_count}</span>
                )}
              </Link>
            ))}
            {topics.length > TOPICS_SHOWN && (
              <button
                type="button"
                onClick={() => setAllTopics(!allTopics)}
                className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {allTopics ? "收起" : "展开全部"}
              </button>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
