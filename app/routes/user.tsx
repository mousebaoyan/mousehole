import { Heart, Snowflake } from "lucide-react";
import { useRef } from "react";
import { data, Link, useFetcher, useLocation } from "react-router";
import { cn } from "cn";
import { apiContext } from "../api.server.ts";
import { More } from "~/components/thread-feed";
import { ThreadList } from "~/components/thread-list";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { RelationButtons, useRelations } from "~/components/user-card";
import { useMe } from "~/forum";
import { restrictionText } from "~/restriction";
import { useNearView } from "~/near-view";
import { ago, unixNow } from "~/time";
import type { Route } from "./+types/user.ts";
import { ModerationButtons } from "./user-moderation.tsx";
import { SITE_NAME } from "../../server/platform/site.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData.user.display_name} · ${SITE_NAME}` }];
}

const TABS = [
  { tab: "threads", label: "帖子" },
  { tab: "posts", label: "回复" },
] as const;

// The profile, then the threads or the replies, ?tab=posts, a page at a time.
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const search = new URL(request.url).searchParams;
  const tab = search.get("tab") === "posts" ? "posts" : "threads";
  const cursor = search.get("cursor") ?? undefined;
  const param = { user: params.id };
  const [userRes, threadsRes, postsRes] = await Promise.all([
    api.users[":user"].$get({ param }),
    tab === "threads" ? api.users[":user"].threads.$get({ param, query: { cursor } }) : null,
    tab === "posts" ? api.users[":user"].posts.$get({ param, query: { cursor } }) : null,
  ]);
  if (!userRes.ok) throw data("用户不存在", { status: 404 });
  const threads = threadsRes?.ok ? await threadsRes.json() : null;
  const posts = postsRes?.ok ? await postsRes.json() : null;
  // Shaped like the thread lists' pages, which `More` loads the next of.
  return {
    user: await userRes.json(),
    tab,
    threads: threads?.items ?? null,
    posts: posts?.items ?? null,
    next_cursor: (threads ?? posts)?.next_cursor ?? null,
    now: unixNow(),
  };
}

type UserPost = NonNullable<Route.ComponentProps["loaderData"]["posts"]>[number];

// Following and 认可, from this page or the profile card anywhere; see useRelations.
export async function action({ params, request, context }: Route.ActionArgs) {
  const api = context.get(apiContext).users[":user"];
  const form = await request.formData();
  const param = { user: params.id };
  const intent = form.get("intent");
  if (intent === "restrict" || intent === "lift") {
    const days = Number(form.get("days"));
    const reason = form.get("reason");
    const res =
      intent === "lift"
        ? await api.restriction.$delete({ param, json: {} })
        : await api.restriction.$put({
            param,
            json: {
              type: form.get("type") === "ban" ? "ban" : "mute",
              until: days > 0 ? unixNow() + days * 86_400 : null,
              reason: typeof reason === "string" ? reason : "",
            },
          });
    if (res.ok) return { ok: true as const, saved: true };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  const follow = intent === "follow";
  const on = form.get(follow ? "followed" : "endorsed") === "true";
  const res = follow
    ? await (on ? api.follow.$put({ param }) : api.follow.$delete({ param }))
    : await (on ? api.endorsement.$put({ param }) : api.endorsement.$delete({ param }));
  if (res.ok) return { ok: true as const, saved: on };
  return { ok: false as const, message: (await res.json()).error.message };
}

// "3.5 小时", "40 分钟".
function duration(seconds: number) {
  return seconds >= 3600
    ? `${Math.round(seconds / 360) / 10} 小时`
    : `${Math.round(seconds / 60)} 分钟`;
}

// How long ago, in the largest whole unit: "2 年", "5 个月", "12 天".
function age(unix: number, now: number) {
  const days = Math.floor((now - unix) / 86_400);
  if (days >= 365) return `${Math.floor(days / 365)} 年`;
  if (days >= 30) return `${Math.floor(days / 30)} 个月`;
  return `${days} 天`;
}

const ROLES: Record<string, string> = { admin: "管理员", moderator: "版主" };

type LoaderData = Route.ComponentProps["loaderData"];

export default function User({ loaderData, actionData }: Route.ComponentProps) {
  const { user } = loaderData;
  if (!user.members_only) return <Profile {...loaderData} user={user} actionData={actionData} />;
  // Someone who keeps their content from guests, seen by a guest (design §8.10).
  return (
    <header className="flex items-center gap-4 px-1 sm:gap-5">
      <UserAvatar user={user} className="size-16 text-2xl sm:size-20 sm:text-3xl" />
      <div className="min-w-0">
        <h1 className="text-xl font-semibold break-all">{user.display_name}</h1>
        <p className="mt-1 text-meta text-muted-foreground">
          TA 的资料和发言仅成员可见，
          <Link to="/login" className="text-primary hover:underline">
            登录
          </Link>
          后查看
        </p>
      </div>
    </header>
  );
}

function Profile({
  user,
  tab,
  threads,
  posts,
  next_cursor,
  now,
  actionData,
}: Omit<LoaderData, "user"> & {
  user: Extract<LoaderData["user"], { members_only: false }>;
  actionData: Route.ComponentProps["actionData"];
}) {
  const me = useMe();
  const staff = me?.role === "moderator" || me?.role === "admin";
  const { stats } = user;
  const relations = useRelations(user);
  // What the group shows about them; the QQ number only to members.
  const facts: string[] = [];
  if (user.qq !== undefined) facts.push(`QQ ${user.qq}`);
  if (user.card && user.card !== user.display_name) facts.push(`群名片 ${user.card}`);
  if (user.joined_at !== null) facts.push(`群龄 ${age(user.joined_at, now)}`);
  if (user.last_sent_at !== null) facts.push(`${ago(user.last_sent_at, now)}在群里发言`);
  const numbers = [
    { label: "帖子", value: stats.threads },
    { label: "回复", value: stats.posts },
    { label: "获赞", value: stats.likes },
    { label: "访问天数", value: stats.days_visited },
    { label: "阅读时间", value: duration(stats.read_seconds) },
    { label: "读过的帖子", value: stats.threads_read },
    { label: "读过的回复", value: stats.posts_read },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start gap-4 px-1 sm:gap-5">
        <UserAvatar user={user} className="size-16 text-2xl sm:size-20 sm:text-3xl" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="text-xl font-semibold break-all">{user.display_name}</h1>
            <UserBadges user={user} />
            {ROLES[user.role] && (
              <span className="rounded bg-brand/15 px-1.5 py-px text-2xs font-medium text-brand-strong">
                {ROLES[user.role]}
              </span>
            )}
            {user.member_status === "frozen" && (
              <span className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-2xs text-muted-foreground">
                <Snowflake className="size-3" /> 已冻结
              </span>
            )}
          </div>
          {user.bio && <p className="mt-2 text-body">{user.bio}</p>}
          {facts.length > 0 && (
            <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-meta text-muted-foreground">
              {facts.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </p>
          )}
          <p className="mt-2 flex gap-4 text-meta text-muted-foreground">
            {[
              { label: "关注", value: relations.following },
              { label: "粉丝", value: relations.followers },
              { label: "认可", value: relations.endorsements },
            ].map((n) => (
              <span key={n.label}>
                <span className="font-semibold text-foreground tabular-nums">{n.value}</span>{" "}
                {n.label}
              </span>
            ))}
          </p>
          <RelationButtons relations={relations} className="mt-4 max-w-72" />
          {user.restriction && (
            <p className="mt-3 text-meta text-destructive">{restrictionText(user.restriction)}</p>
          )}
          {staff && user.role === "user" && (
            <ModerationButtons restriction={user.restriction ?? null} admin={me.role === "admin"} />
          )}
          {actionData?.ok === false && (
            <p role="alert" className="mt-2 text-meta text-destructive">
              {actionData.message}
            </p>
          )}
        </div>
      </header>

      {/* On phones, posting in a row of four and reading in a row of three. */}
      <dl className="grid grid-cols-12 gap-2 px-1 lg:grid-cols-7">
        {numbers.map((n, i) => (
          <div
            key={n.label}
            className={cn(
              "rounded-xl border bg-card px-2.5 py-2.5 sm:px-3 lg:col-span-1",
              i < 4 ? "col-span-3" : "col-span-4",
            )}
          >
            <dd className="text-lg font-semibold tabular-nums">{n.value}</dd>
            <dt className="text-xs text-muted-foreground">{n.label}</dt>
          </div>
        ))}
      </dl>

      <section>
        <nav aria-label="发过的内容" className="mb-3 flex gap-1 px-1">
          {TABS.map((t) => (
            <Link
              key={t.tab}
              to={t.tab === "threads" ? "." : "?tab=posts"}
              aria-current={t.tab === tab ? "page" : undefined}
              className={cn(
                "rounded-full px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                t.tab === tab && "bg-secondary font-medium text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {threads &&
          (threads.length === 0 ? (
            <Empty />
          ) : (
            <ThreadList threads={threads} now={now} showBoard>
              {next_cursor !== null && <More cursor={next_cursor} showBoard />}
            </ThreadList>
          ))}
        {posts &&
          (posts.length === 0 ? (
            <Empty />
          ) : (
            <ul>
              <PostRows posts={posts} now={now} />
              {next_cursor !== null && <MorePosts cursor={next_cursor} />}
            </ul>
          ))}
      </section>
    </div>
  );
}

function Empty() {
  return <p className="py-16 text-center text-sm text-muted-foreground">还没有内容</p>;
}

function PostRows({ posts, now }: { posts: UserPost[]; now: number }) {
  return posts.map((p) => (
    <li
      key={p.id}
      className="relative rounded-xl px-3 py-3.5 before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden hover:bg-accent/60 sm:px-4"
    >
      <Link
        to={`/t/${p.thread.id}?floor=${p.floor}`}
        className="font-medium after:absolute after:inset-0"
      >
        {p.thread.title}
      </Link>
      <p className="mt-1 line-clamp-2 text-meta text-foreground/80">{p.excerpt}</p>
      <p className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
        <span>#{p.floor}</span>
        <span>{ago(p.created_at, now)}</span>
        {p.like_count > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Heart className="size-3" /> {p.like_count}
          </span>
        )}
      </p>
    </li>
  ));
}

// The next page of replies loads when its link comes near the screen, as lists of threads do.
function MorePosts({ cursor }: { cursor: string }) {
  const { load, state, data: page } = useFetcher<typeof loader>();
  const link = useRef<HTMLAnchorElement>(null);
  const { pathname } = useLocation();
  const href = `${pathname}?tab=posts&cursor=${cursor}`;
  useNearView(link, state === "idle" && !page, () => void load(href));

  if (!page?.posts) {
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
      <PostRows posts={page.posts} now={page.now} />
      {page.next_cursor !== null && <MorePosts cursor={page.next_cursor} />}
    </>
  );
}
