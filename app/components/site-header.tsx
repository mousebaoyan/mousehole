import { Bell, LogOut, Menu, Search, Settings, User, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useLocation, useParams } from "react-router";
import { NewThreadButton } from "~/components/composer";
import { Drawer, Dropdown, menuItem } from "~/components/disclosure";
import { ForumNav } from "~/components/forum-nav";
import { Logo } from "~/components/logo";
import { ThemeToggle } from "~/components/theme-toggle";
import { UserAvatar } from "~/components/user-avatar";
import { buttonVariants } from "~/components/ui/button";

type Me = { id: number; display_name: string; avatar_url: string | null; role: string };

// The unread count as the page was loaded, then as the server tells it live.
function useUnread(initial: number, signedIn: boolean) {
  const [live, setLive] = useState<number | null>(null);
  useEffect(() => {
    if (!signedIn) return undefined;
    const stream = new EventSource("/api/v1/stream");
    stream.addEventListener("unread", (e) => setLive(Number(e.data)));
    return () => stream.close();
  }, [signedIn]);
  return live ?? initial;
}

// "/" anywhere but in a text field goes to the search box, as the hint in it says.
function useSlashToSearch() {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if (e.key !== "/" || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      box.current?.focus();
    }
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return box;
}

// `unread` is how many notifications the reader hasn't read.
export function SiteHeader({ me, unread: loaded }: { me: Me | null; unread: number }) {
  const unread = useUnread(loaded, me !== null);
  const searchBox = useSlashToSearch();
  const { pathname } = useLocation();
  // On a board's page, a new thread starts in that board.
  const { slug } = useParams();
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-md">
      {/* The outer columns share the leftover width, so the search box sits in the middle. */}
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-3 sm:px-5 md:grid md:grid-cols-[1fr_minmax(0,30rem)_1fr]">
        <div className="flex items-center gap-2">
          <Drawer key={pathname} label="导航" trigger={<Menu className="size-5" />}>
            <ForumNav />
          </Drawer>
          <Logo />
        </div>
        {/* The browser's own clear button is hidden: it ignores the theme. Ours is a reset button,
            shown in place of the shortcut hint once something is typed. */}
        <form
          action="/search"
          className="hidden h-9 w-full items-center gap-2 rounded-full bg-secondary px-3.5 text-sm text-muted-foreground focus-within:ring-2 focus-within:ring-ring/40 md:flex"
        >
          <Search className="size-4 shrink-0" />
          <input
            ref={searchBox}
            type="search"
            name="q"
            aria-label="搜索"
            placeholder="搜索帖子、回复、用户"
            className="peer w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          <kbd className="rounded border bg-background px-1.5 font-sans text-2xs peer-[:not(:placeholder-shown)]:hidden">
            /
          </kbd>
          <button
            type="reset"
            aria-label="清空"
            className="-mr-1 rounded-full p-0.5 hover:bg-background hover:text-foreground peer-placeholder-shown:hidden"
          >
            <X className="size-3.5" />
          </button>
        </form>
        <div className="ml-auto flex items-center gap-1 md:justify-self-end">
          <Link
            to="/search"
            aria-label="搜索"
            className={buttonVariants({ variant: "ghost", size: "icon", className: "md:hidden" })}
          >
            <Search />
          </Link>
          <ThemeToggle />
          {me ? (
            <>
              {(me.role === "admin" || me.role === "moderator") && (
                <Link
                  to="/admin"
                  aria-label="管理后台"
                  title="管理后台"
                  className={buttonVariants({
                    variant: "ghost",
                    size: "icon",
                    className: "hidden sm:inline-flex",
                  })}
                >
                  <Wrench />
                </Link>
              )}
              <Link
                to="/notifications"
                aria-label={unread > 0 ? `通知，${unread} 条未读` : "通知"}
                title="通知"
                className={buttonVariants({
                  variant: "ghost",
                  size: "icon",
                  className: "relative",
                })}
              >
                <Bell />
                {unread > 0 && (
                  <span className="absolute top-0.5 right-0 min-w-4 rounded-full bg-brand px-1 text-center text-2xs leading-4 font-semibold text-white tabular-nums ring-2 ring-background">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </Link>
              <NewThreadButton board={slug ?? null} className="mx-1 hidden sm:inline-flex" />
              <Dropdown
                key={pathname}
                label="我的账号"
                triggerClassName="flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                trigger={<UserAvatar user={me} className="size-8" />}
              >
                {() => (
                  <>
                    <div className="px-2.5 py-1.5 text-meta font-medium text-muted-foreground">
                      {me.display_name}
                    </div>
                    <Link to={`/u/${me.id}`} className={menuItem}>
                      <User /> 我的主页
                    </Link>
                    <Link to="/settings" className={menuItem}>
                      <Settings /> 设置
                    </Link>
                    {(me.role === "admin" || me.role === "moderator") && (
                      <Link to="/admin" className={menuItem}>
                        <Wrench /> 管理后台
                      </Link>
                    )}
                    <Form method="post" action="/logout" className="mt-1 border-t pt-1">
                      <button type="submit" className={menuItem}>
                        <LogOut /> 退出
                      </button>
                    </Form>
                  </>
                )}
              </Dropdown>
            </>
          ) : (
            <Link to="/login" className={buttonVariants({ className: "ml-1" })}>
              登录
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
