import {
  AtSign,
  BellRing,
  CheckCheck,
  CircleCheck,
  Heart,
  Reply,
  Rocket,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { useRef } from "react";
import {
  Form,
  Link,
  redirect,
  useFetcher,
  useLocation,
  useNavigation,
  useSubmit,
} from "react-router";
import { cn } from "cn";
import { apiContext } from "../api.server.ts";
import { Button } from "~/components/ui/button";
import { UserAvatar } from "~/components/user-avatar";
import { useNearView } from "~/near-view";
import { ago, unixNow } from "~/time";
import type { Route } from "./+types/notifications.ts";

export function meta() {
  return [{ title: "通知 · 鼠洞" }];
}

// All of them, or ?unread for the unread ones only; a page at a time.
export async function loader({ request, context }: Route.LoaderArgs) {
  const search = new URL(request.url).searchParams;
  const unread = search.has("unread");
  const res = await context.get(apiContext).notifications.$get({
    query: { unread_only: unread ? "true" : "false", cursor: search.get("cursor") ?? undefined },
  });
  if (!res.ok) return redirect("/login");
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
    typeof to === "string" && /^\/t\/\d+\?floor=\d+$/.test(to) ? to : "/notifications",
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
};

// What a moderator did; see design §8.4.
const MODERATED: Record<string, string> = {
  approve: "通过了你的",
  reject: "没有通过你的",
  hide: "隐藏了你的",
  unhide: "恢复了你的",
};

// What happened, in a sentence; merged ones count people or floors.
function headline(n: Item) {
  const who = n.actor?.display_name ?? "有人";
  const many = n.count > 1;
  switch (n.type) {
    case "reply":
      return `${who} 回复了你`;
    case "mention":
      return `${who} 提到了你`;
    case "like":
      return many ? `${who} 等 ${n.count} 人赞了你` : `${who} 赞了你`;
    case "boost":
      return `${many ? `${who} 等 ${n.count} 人` : who} 给你留了短评：${n.data.body}`;
    case "watching":
      return many ? `关注的主题有 ${n.count} 层新回复` : `${who} 回复了你关注的主题`;
    case "solved":
      return `${who} 采纳了你的回答`;
    case "moderation":
      return `${who} ${MODERATED[n.data.action] ?? "处理了你的"}${n.post.floor === 1 ? "主题" : "回复"}${n.data.reason ? `：${n.data.reason}` : ""}`;
    default:
      return `${who} 发了新主题`;
  }
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const { unread, items, next_cursor, now } = loaderData;
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
          {unread ? "没有未读的通知" : "还没有通知"}
        </p>
      ) : (
        <ul>
          <Rows items={items} now={now} />
          {next_cursor !== null && <More cursor={next_cursor} />}
        </ul>
      )}
    </section>
  );
}

function Rows({ items, now }: { items: Item[]; now: number }) {
  return items.map((n) => <Row key={n.id} item={n} now={now} />);
}

// Opening an unread one marks it read on the way.
function Row({ item: n, now }: { item: Item; now: number }) {
  const submit = useSubmit();
  const Icon = ICONS[n.type] ?? Reply;
  const to = `/t/${n.thread.id}?floor=${n.post.floor}`;
  return (
    <li
      className={cn(
        "relative flex gap-3 rounded-xl px-3 py-3.5 before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden hover:bg-accent/60 sm:px-4",
        !n.read && "bg-brand/[0.06]",
      )}
    >
      <span className="relative shrink-0 self-start">
        {n.actor ? (
          <UserAvatar user={n.actor} className="size-9" />
        ) : (
          <span className="block size-9 rounded-full bg-muted" />
        )}
        <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-background text-muted-foreground ring-1 ring-border">
          <Icon className="size-3" />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <Link
          to={to}
          onClick={(e) => {
            if (n.read) return;
            e.preventDefault();
            void submit({ id: n.id, to }, { method: "post", action: "/notifications" });
          }}
          className={cn("text-body after:absolute after:inset-0", !n.read && "font-medium")}
        >
          {!n.read && <span className="sr-only">未读：</span>}
          {headline(n)}
        </Link>
        <p className="mt-0.5 truncate text-meta font-medium">{n.thread.title}</p>
        {n.excerpt && (
          <p className="mt-0.5 truncate text-meta text-muted-foreground">{n.excerpt}</p>
        )}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{ago(n.created_at, now)}</span>
    </li>
  );
}

// The next page loads when its link comes near the screen, as the thread lists do.
function More({ cursor }: { cursor: string }) {
  const { load, state, data } = useFetcher<typeof loader>();
  const link = useRef<HTMLAnchorElement>(null);
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("cursor", cursor);
  const href = `/notifications?${params}`;
  useNearView(link, state === "idle" && !data, () => void load(href));

  if (!data) {
    return (
      <li className="py-4 text-center text-meta">
        <a ref={link} href={href} className="text-muted-foreground hover:text-foreground">
          {state === "loading" ? "加载中…" : "加载更多"}
        </a>
      </li>
    );
  }
  return (
    <>
      <Rows items={data.items} now={data.now} />
      {data.next_cursor !== null && <More cursor={data.next_cursor} />}
    </>
  );
}
