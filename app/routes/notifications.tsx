import {
  Award,
  AtSign,
  BellRing,
  CheckCheck,
  CircleCheck,
  FilePen,
  Gift,
  Heart,
  Reply,
  Rocket,
  ShieldCheck,
  TrendingUp,
  UserPlus,
} from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { data, Form, Link, redirect, useNavigation, useSubmit } from "react-router";
import { cn } from "cn";
import { apiContext } from "../api.server.ts";
import { type Loaded, Pages } from "~/components/pages";
import { Button } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { useMe } from "~/forum";
import { ago, unixNow } from "~/time";
import type { Route } from "./+types/notifications.ts";
import { levelName } from "../../server/platform/site.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData.unread ? pageTitle("未读", "通知") : pageTitle("通知") }];
}

// All of them, or ?unread for the unread ones only; a page at a time.
export async function loader({ request, context }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const unread = search.has("unread");
  const res = await context.get(apiContext).notifications.$get({
    query: { unread_only: unread ? "true" : "false", cursor: search.get("cursor") ?? undefined },
  });
  if (res.status === 401) return redirect("/login");
  if (!res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = await res.json();
  return { unread, items: page.items, next_cursor: page.next_cursor, now: unixNow() };
}

// One read as it is opened, then on to where it points; or all of them at once. Going through
// here, the unread count in the header is loaded again.
export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();
  const read = context.get(apiContext).notifications.read;
  if (!form.has("id")) {
    await read.$post({ json: { all: true } });
    return null;
  }
  await read.$post({ json: { ids: [Number(form.get("id"))] } });
  const to = form.get("to");
  return redirect(
    typeof to === "string" && /^\/(t\/\d+(\?floor=\d+)?|u\/\d+|badges\/\d+)$/.test(to)
      ? to
      : "/notifications",
  );
}

type Item = Route.ComponentProps["loaderData"]["items"][number];

const ICONS: Record<string, typeof Reply> = {
  reply: Reply,
  mention: AtSign,
  like: Heart,
  boost: Rocket,
  watching: BellRing,
  following: UserPlus,
  solved: CircleCheck,
  moderation: ShieldCheck,
  suggestion: FilePen,
  level: TrendingUp,
  lottery: Gift,
  badge: Award,
};

// How a lottery went, for whom; see design §8.13.
const LOTTERY: Record<string, string> = {
  won: "你中奖了",
  lost: "你参与的抽奖已开奖，未中奖",
  drawn: "你发起的抽奖已开奖",
  cancelled: "你参与的抽奖已取消",
};

// What a moderator did; see design §8.4.
const MODERATED: Record<string, string> = {
  approve: "通过了你的",
  reject: "未通过你的",
  hide: "隐藏了你的",
  unhide: "恢复了你的",
};

// What became of a change suggested for a thread; see design §6.6.
const SUGGESTED: Record<string, string> = {
  new: "建议修改你的帖子",
  accepted: "同意了你的修改建议",
  rejected: "未同意你的修改建议",
  applied: "按修改建议修改了你的帖子",
};

// What happened, in a sentence; merged ones count people or floors.
function headline(n: Item) {
  const who = n.actor?.display_name ?? "有人";
  const many = n.count > 1;
  switch (n.type) {
    case "reply":
      return `${who} 回复了你`;
    case "thread_reply":
      return many ? `你的帖子有 ${n.count} 条新回复` : `${who} 回复了你的帖子`;
    case "mention":
      return `${who} 提到了你`;
    case "like":
      return many ? `${who} 等 ${n.count} 人赞了你` : `${who} 赞了你`;
    case "boost":
      return `${many ? `${who} 等 ${n.count} 人` : who} 给你留了短评：${n.data.body}`;
    case "watching":
      return many ? `你关注的帖子有 ${n.count} 条新回复` : `${who} 回复了你关注的帖子`;
    case "solved":
      return `${who} 采纳了你的回答`;
    case "moderation":
      if (n.data.action === "merge") return `${who} 把你的帖子合并到了另一个帖子`;
      return `${who} ${MODERATED[n.data.action] ?? "处理了你的"}${n.post?.floor === 1 ? "帖子" : "回复"}${n.data.reason ? `：${n.data.reason}` : ""}`;
    case "suggestion":
      return `${who} ${SUGGESTED[n.data.kind]}`;
    case "level":
      return `你已升级到 ${levelName(Number(n.data.level))}`;
    case "lottery":
      return `${LOTTERY[n.data.result]}${n.data.prize ? `：${n.data.prize}` : ""}`;
    case "badge":
      return `你获得了徽章「${n.data.name}」`;
    default:
      return `${who} 发了新帖`;
  }
}

// The pages of notifications each entry of the history showed (components/pages.tsx).
const kept = new Map<string, Loaded<typeof loader>[]>();

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { unread, items } = loaderData;
  const navigation = useNavigation();
  return (
    <section>
      <div className="mb-4 flex flex-wrap items-center gap-2 px-1">
        <h1 className="mr-2 text-xl font-semibold">通知</h1>
        <nav aria-label="通知" className="flex gap-1">
          {[
            { to: ".", label: "全部", current: !unread },
            { to: "?unread", label: "未读", current: unread },
          ].map((t) => (
            <Link
              key={t.label}
              to={t.to}
              aria-current={t.current ? "page" : undefined}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                t.current && "bg-secondary font-medium text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <Form method="post" className="ml-auto">
          <Button variant="ghost" size="sm" disabled={navigation.state !== "idle"}>
            <CheckCheck /> 全部标为已读
          </Button>
        </Form>
      </div>
      {items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {unread ? "暂无未读通知" : "暂无通知"}
        </p>
      ) : (
        <ul className="stagger">
          <Pages<typeof loader> kept={kept} first={loaderData} next={(page) => page.next_cursor}>
            {(page) => <Rows items={page.items} now={page.now} />}
          </Pages>
        </ul>
      )}
    </section>
  );
}

function Rows({ items, now }: { items: Item[]; now: number }) {
  return items.map((n) => <Row key={n.id} item={n} now={now} />);
}

// Opening an unread one marks it read on the way.
// Opened in this tab: a list that Back brings back as it was (components/pages.tsx) was loaded
// before.
const readHere = new Set<number>();

function Row({ item: n, now }: { item: Item; now: number }) {
  const submit = useSubmit();
  const me = useMe();
  const Icon = ICONS[n.type] ?? Reply;
  const read = n.read || readHere.has(n.id);
  // A lottery goes to its thread, and a badge earned for a floor to that floor; other badges to
  // the badge's page; a level to one's profile, where the next one's progress is.
  const to = n.thread
    ? `/t/${n.thread.id}${n.post ? `?floor=${n.post.floor}` : ""}`
    : n.type === "badge"
      ? `/badges/${n.data.badge_id}`
      : `/u/${me?.id}`;
  return (
    <li
      className={cn(
        "relative flex gap-3 rounded-xl px-3 py-3.5 before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden transition-colors hover:bg-accent/60 sm:px-4",
        !read && "bg-brand/[0.06]",
      )}
    >
      {/* Levels, lotteries and badges have nobody behind them, so their icon takes the avatar's place. */}
      {n.actor ? (
        <span className="relative shrink-0 self-start">
          <UserAvatar user={n.actor} thread={n.thread?.id} className="size-9" />
          <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
            <Icon className="size-3" />
          </span>
        </span>
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center self-start rounded-full bg-brand/15 text-brand-strong">
          <Icon className="size-4.5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <Link
          to={to}
          onClick={(e) => {
            if (read) return;
            e.preventDefault();
            readHere.add(n.id);
            void submit({ id: n.id, to }, { method: "post", action: "/notifications" });
          }}
          className={cn("text-body after:absolute after:inset-0", !read && "font-medium")}
        >
          {!read && <span className="sr-only">未读：</span>}
          {headline(n)}
        </Link>
        {n.thread && <p className="mt-0.5 truncate text-meta font-medium">{n.thread.title}</p>}
        {n.excerpt && (
          <p className="mt-0.5 truncate text-meta text-muted-foreground">{n.excerpt}</p>
        )}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{ago(n.created_at, now)}</span>
    </li>
  );
}
