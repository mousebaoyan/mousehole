import { Bell, LogOut, Menu, PenSquare, Search, Settings, Shield, User } from "lucide-react";
import { Form, Link, useLocation } from "react-router";
import { Drawer, Dropdown } from "~/components/disclosure";
import { ForumNav } from "~/components/forum-nav";
import { Logo } from "~/components/logo";
import { ThemeToggle } from "~/components/theme-toggle";
import { UserAvatar } from "~/components/user-avatar";
import { Button, buttonVariants } from "~/components/ui/button";

type Me = { id: number; display_name: string; role: string };

const menuItem =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground";

export function SiteHeader({ me }: { me: Me | null }) {
  const { pathname } = useLocation();
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-3 sm:px-5">
        <Drawer key={pathname} label="导航" trigger={<Menu className="size-5" />}>
          <ForumNav />
        </Drawer>
        <Logo />
        <label className="ml-6 hidden h-9 w-full max-w-sm items-center gap-2 rounded-full bg-secondary px-3.5 text-sm text-muted-foreground focus-within:ring-2 focus-within:ring-ring/40 md:flex">
          <Search className="size-4 shrink-0" />
          <input
            type="search"
            placeholder="搜索主题、回复、用户"
            className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border bg-background px-1.5 font-sans text-[11px]">/</kbd>
        </label>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="搜索">
            <Search />
          </Button>
          <ThemeToggle />
          {me ? (
            <>
              <Button variant="ghost" size="icon" className="relative" aria-label="通知">
                <Bell />
                <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-red-500 ring-2 ring-background" />
              </Button>
              <Link
                to="/new"
                className={buttonVariants({ className: "mx-1 hidden sm:inline-flex" })}
              >
                <PenSquare /> 发帖
              </Link>
              <Dropdown
                key={pathname}
                label="我的账号"
                trigger={
                  <UserAvatar user={{ id: me.id, name: me.display_name }} className="size-8" />
                }
              >
                <div className="px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground">
                  {me.display_name}
                </div>
                <Link to={`/u/${me.id}`} className={menuItem}>
                  <User /> 我的主页
                </Link>
                <Link to="/settings" className={menuItem}>
                  <Settings /> 设置
                </Link>
                {me.role === "admin" && (
                  <Link to="/admin" className={menuItem}>
                    <Shield /> 管理后台
                  </Link>
                )}
                <Form method="post" action="/logout" className="mt-1 border-t pt-1">
                  <button type="submit" className={menuItem}>
                    <LogOut /> 退出
                  </button>
                </Form>
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
