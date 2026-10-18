import {
  Award,
  ChevronDown,
  ChevronUp,
  Heart,
  MessageSquare,
  Pin,
  Search,
  Snowflake,
  Sparkles,
} from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { useEffect, useRef, useState } from "react";
import { data, Link, useFetcher, useLocation } from "react-router";
import { cn } from "cn";
import { apiContext } from "../api.server.ts";
import { BadgeChip, TIER_STYLES } from "~/components/badge-chip";
import { Backdrop } from "~/components/backdrop";
import { BoardBadge } from "~/components/board-badge";
import { PostBody } from "~/components/post-body";
import { PROSE } from "~/components/prose";
import { ThreadPages } from "~/components/thread-feed";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { StatusLine } from "~/components/user-status";
import { RelationButtons, useRelations } from "~/components/user-card";
import { useMe } from "~/forum";
import { restrictionText } from "~/restriction";
import { useNearView } from "~/near-view";
import { ago, unixNow } from "~/time";
import type { InferResponseType } from "hono/client";
import type { Api } from "~/api-types";
import type { Route } from "./+types/user.ts";
import { ClearButtons, ModerationButtons } from "./user-moderation.tsx";
import { REACTIONS } from "./reactions.tsx";
import { levelName, readTime, STAFF, TIER_NAMES } from "../../server/platform/site.ts";
import { CLEARABLE } from "../../server/modules/users/customization.ts";
import { RECENT_DAYS } from "../../server/modules/levels/rules.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  const { user, tab, list } = loaderData;
  const shown =
    tab === "threads"
      ? []
      : tab === "people"
        ? [PEOPLE.find((p) => p.list === list)?.label ?? list, "关系"]
        : [TABS.find((t) => t.tab === tab)?.label ?? tab];
  return [{ title: pageTitle(...shown, user.display_name) }];
}

// What the page lists below the profile, ?tab=; likes and people only for members, and only
// when the person shows them (design §9).
const TABS = [
  { tab: "threads", label: "帖子", relations: false },
  { tab: "posts", label: "回复", relations: false },
  { tab: "solved", label: "被采纳", relations: false },
  { tab: "badges", label: "徽章", relations: false },
  { tab: "likes", label: "赞过", relations: true },
  { tab: "summary", label: "概要", relations: false },
  { tab: "people", label: "关系", relations: true },
] as const;
type Tab = (typeof TABS)[number]["tab"];

const PEOPLE = [
  { list: "following", label: "TA 关注的" },
  { list: "followers", label: "粉丝" },
  { list: "endorsing", label: "TA 认可的" },
  { list: "endorsers", label: "认可 TA 的" },
] as const;
type PeopleList = (typeof PEOPLE)[number]["list"];

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext).users[":user"];
  const search = new URL(request.url).searchParams;
  const tab: Tab = TABS.find((t) => t.tab === search.get("tab"))?.tab ?? "threads";
  const list: PeopleList = PEOPLE.find((p) => p.list === search.get("list"))?.list ?? "following";
  const cursor = search.get("cursor") ?? undefined;
  const param = { user: params.id };
  const [
    userRes,
    showcaseRes,
    levelRes,
    threadsRes,
    postsRes,
    likesRes,
    summaryRes,
    peopleRes,
    badgesRes,
  ] = await Promise.all([
    api.$get({ param }),
    api.showcase.$get({ param }),
    // Only for themselves and admins.
    api.level.$get({ param }),
    tab === "threads" ? api.threads.$get({ param, query: { cursor } }) : null,
    tab === "posts" || tab === "solved"
      ? api.posts.$get({
          param,
          query: { cursor, solved: tab === "solved" ? "true" : undefined },
        })
      : null,
    tab === "likes" ? api.likes.$get({ param, query: { cursor } }) : null,
    tab === "summary" ? api.summary.$get({ param }) : null,
    tab === "people" ? api.relations.$get({ param, query: { list, cursor } }) : null,
    tab === "badges" ? api.badges.$get({ param }) : null,
  ]);
  if (!userRes.ok || !showcaseRes.ok) throw data("用户不存在", { status: 404 });
  const threads = threadsRes?.ok ? await threadsRes.json() : null;
  const posts = postsRes?.ok ? await postsRes.json() : null;
  const likes = likesRes?.ok ? await likesRes.json() : null;
  const people = peopleRes?.ok ? await peopleRes.json() : null;
  // Shaped like the thread lists' pages, which `ThreadPages` loads the next of.
  return {
    user: await userRes.json(),
    showcase: await showcaseRes.json(),
    progress: levelRes.ok ? await levelRes.json() : null,
    tab,
    list,
    threads: threads?.items ?? null,
    posts: posts?.items ?? likes?.items ?? null,
    summary: summaryRes?.ok ? await summaryRes.json() : null,
    people: people?.items ?? null,
    badges: badgesRes?.ok ? (await badgesRes.json()).items : null,
    next_cursor: (threads ?? posts ?? likes ?? people)?.next_cursor ?? null,
    now: unixNow(),
  };
}

type LoaderData = Route.ComponentProps["loaderData"];
// A floor of theirs, or one they liked, which says with what and when.
type UserPost = InferResponseType<Api["users"][":user"]["posts"]["$get"], 200>["items"][number] & {
  emoji?: string;
  liked_at?: number;
};
type Person = NonNullable<LoaderData["people"]>[number];

// Following and 认可, from this page or the profile card anywhere; see useRelations.
export async function action({ params, request, context }: Route.ActionArgs) {
  const api = context.get(apiContext).users[":user"];
  const form = await request.formData();
  const param = { user: params.id };
  const intent = form.get("intent");
  if (intent === "clear") {
    const reason = form.get("reason");
    const item = CLEARABLE.find((i) => i === form.get("item"));
    if (!item) throw data("无法清除这一项", { status: 400 });
    const res = await api.customization[":item"].$delete({
      param: { ...param, item },
      json: { reason: typeof reason === "string" ? reason : "" },
    });
    if (res.ok) return { ok: true as const, saved: true };
    return { ok: false as const, message: (await res.json()).error.message };
  }
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
  const time = readTime(seconds);
  return `${time.n} ${time.unit}`;
}

// How long ago, in the largest whole unit: "2 年", "5 个月", "12 天".
function age(unix: number, now: number) {
  const days = Math.floor((now - unix) / 86_400);
  if (days >= 365) return `${Math.floor(days / 365)} 年`;
  if (days >= 30) return `${Math.floor(days / 30)} 个月`;
  return `${days} 天`;
}

const ROLES: Record<string, string> = { admin: "管理员", moderator: "版主" };

export default function User({ loaderData, actionData }: Route.ComponentProps) {
  const { user } = loaderData;
  if (!user.members_only) return <Profile {...loaderData} user={user} actionData={actionData} />;
  // Someone who keeps their content from guests, seen by a guest (design §8.10).
  return (
    <header className="flex items-center gap-4 px-1 sm:gap-5">
      <UserAvatar user={user} className="size-16 text-2xl sm:size-20 sm:text-3xl" frame />
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
  showcase,
  progress,
  tab,
  list,
  threads,
  posts,
  summary,
  people,
  badges,
  next_cursor,
  now,
  actionData,
}: Omit<LoaderData, "user"> & {
  user: Extract<LoaderData["user"], { members_only: false }>;
  actionData: Route.ComponentProps["actionData"];
}) {
  const me = useMe();
  const staff = me !== null && STAFF.includes(me.role);
  const self = me?.id === user.id;
  // Members only, and only when they show them; theirs to themselves always.
  const relationsShown = user.relations_public === true || self;
  const { stats } = user;
  const relations = useRelations(user);
  // What the group shows about them, only to members; the QQ number to guests too if the site
  // says so.
  const facts: string[] = [];
  if (typeof user.qq === "number") facts.push(`QQ ${user.qq}`);
  if (user.card && user.card !== user.display_name) facts.push(`群名片 ${user.card}`);
  if (typeof user.joined_at === "number") facts.push(`群龄 ${age(user.joined_at, now)}`);
  if (typeof user.last_sent_at === "number") {
    facts.push(`${ago(user.last_sent_at, now)}在群里发言`);
  }
  const numbers = [
    { label: "帖子", value: stats.threads },
    { label: "回复", value: stats.posts },
    { label: "获赞", value: stats.likes },
    { label: "访问天数", value: stats.days_visited },
    { label: "阅读时间", value: duration(stats.read_seconds) },
    { label: "读过的帖子", value: stats.threads_read },
    { label: "读过的回复", value: stats.posts_read },
  ];
  const tabCounts: Partial<Record<Tab, number>> = {
    threads: stats.threads,
    posts: stats.posts,
    solved: stats.solved,
    badges: stats.badges,
  };

  return (
    <div className={cn("flex flex-col gap-6", user.theme && `theme-${user.theme}`)}>
      {/* With a background, a panel it lies under whole; its menus open past the panel's edge,
          so the backdrop clips itself. */}
      <header
        className={cn(
          "relative isolate flex items-start gap-4 sm:gap-5",
          user.background ? "on-backdrop rounded-2xl border bg-card p-4 sm:p-5" : "px-1",
        )}
      >
        {user.background && (
          <Backdrop
            background={user.background}
            place="profile"
            opacity={user.background_opacity}
            className="-z-10 rounded-2xl"
          />
        )}
        <UserAvatar
          user={user}
          className={cn(
            "size-16 text-2xl sm:size-20 sm:text-3xl",
            user.background && "ring-4 ring-card",
          )}
          frame
        />
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
          {user.user_status && <StatusLine status={user.user_status} className="mt-2" />}
          {user.bio && <p className="mt-2 text-body">{user.bio}</p>}
          {user.badges.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {user.badges.map((b) => (
                <BadgeChip key={b.id} badge={b} />
              ))}
            </div>
          )}
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
          {self && (
            <p className="mt-3 flex gap-4 text-meta">
              {[
                { to: "/my/bookmarks", label: "我的收藏" },
                { to: "/my/read", label: "已读" },
                { to: "/drafts", label: "草稿" },
              ].map((l) => (
                <Link key={l.to} to={l.to} className="text-primary hover:underline">
                  {l.label}
                </Link>
              ))}
            </p>
          )}
          {user.restriction && (
            <p className="mt-3 text-meta text-destructive">{restrictionText(user.restriction)}</p>
          )}
          {staff && user.role === "user" && (
            <ModerationButtons
              restriction={user.restriction ?? null}
              admin={me.role === "admin" || me.role === "owner"}
            />
          )}
          {staff && !self && (
            <ClearButtons
              background={user.background !== null}
              status={user.user_status !== null}
              showcase={showcase.showcase_html !== null}
            />
          )}
          {actionData?.ok === false && (
            <p role="alert" className="mt-2 text-meta text-destructive">
              {actionData.message}
            </p>
          )}
        </div>
      </header>

      {showcase.showcase_html !== null && <Showcase key={user.id} html={showcase.showcase_html} />}
      {showcase.pins.length > 0 && <Pins pins={showcase.pins} />}

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

      {stats.reads > 0 && (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-1 text-meta text-muted-foreground">
          <Sparkles className="size-4 text-brand-strong" aria-hidden />
          {self ? "你的" : "TA 的"}分享帮到了
          <span className="font-semibold text-foreground tabular-nums">{stats.people_reached}</span>
          人，被读
          <span className="font-semibold text-foreground tabular-nums">{stats.reads}</span>次
          {stats.reads_week !== undefined && `，最近 7 天 ${stats.reads_week} 次`}
        </p>
      )}

      {progress && <LevelProgress progress={progress} />}

      <section>
        {/* Switching lists keeps the reader where they are, below the profile. */}
        <nav
          aria-label="TA 的内容和关系"
          className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-2 [scrollbar-width:none]"
        >
          {TABS.filter((t) => !t.relations || relationsShown).map((t) => (
            <Link
              key={t.tab}
              to={t.tab === "threads" ? "." : `?tab=${t.tab}`}
              preventScrollReset
              aria-current={t.tab === tab ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground",
                t.tab === tab && "bg-secondary font-medium text-foreground",
              )}
            >
              {t.label}
              {(tabCounts[t.tab] ?? 0) > 0 && (
                <span className="ml-1 text-muted-foreground tabular-nums">{tabCounts[t.tab]}</span>
              )}
            </Link>
          ))}
          <Link
            to={`/search?author=${user.id}`}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <Search className="size-4" /> 搜索 TA 的帖子
          </Link>
        </nav>
        {threads &&
          (threads.length === 0 ? (
            <Empty />
          ) : (
            <ThreadPages first={{ threads, next_cursor, now }} showBoard />
          ))}
        {posts &&
          (posts.length === 0 ? (
            <Empty />
          ) : (
            <ul className="stagger">
              <PostRows posts={posts} now={now} />
              {next_cursor !== null && <MoreRows cursor={next_cursor} />}
            </ul>
          ))}
        {summary && <Summary summary={summary} now={now} />}
        {badges && (badges.length === 0 ? <Empty /> : <BadgeList badges={badges} now={now} />)}
        {people && (
          <>
            <nav aria-label="名单" className="mb-2 flex flex-wrap gap-1 px-1">
              {PEOPLE.map((p) => (
                <Link
                  key={p.list}
                  to={`?tab=people&list=${p.list}`}
                  preventScrollReset
                  aria-current={p.list === list ? "page" : undefined}
                  className="rounded-full border px-3 py-1 text-meta text-muted-foreground hover:text-foreground aria-[current]:border-foreground/30 aria-[current]:text-foreground"
                >
                  {p.label}
                </Link>
              ))}
            </nav>
            {people.length === 0 ? (
              <Empty />
            ) : (
              <ul className="stagger">
                <PeopleRows people={people} now={now} />
                {next_cursor !== null && <MoreRows cursor={next_cursor} />}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// What they wrote about themselves (design §8.16). A long one is folded until opened; keyed by
// the person, so it measures again on someone else's page.
function Showcase({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 1);
  }, []);
  return (
    <section aria-label="展柜" className="rounded-2xl border bg-card px-4 py-3 sm:px-5">
      <div
        ref={box}
        className={cn(!open && "max-h-64 overflow-hidden", long && !open && "mask-b-from-70%")}
      >
        <PostBody html={html} className={cn(PROSE, "mt-0 [&>:first-child]:mt-0!")} />
      </div>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-1 inline-flex items-center gap-0.5 text-meta text-link"
        >
          {open ? "收起" : "展开全文"}
          {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      )}
    </section>
  );
}

// The threads they pinned to their page, like a GitHub profile's.
function Pins({ pins }: { pins: LoaderData["showcase"]["pins"] }) {
  return (
    <section aria-labelledby="pins">
      <h2 id="pins" className="flex items-center gap-1.5 px-1 text-sm font-medium">
        <Pin className="size-4 text-brand-strong" aria-hidden /> 代表作
      </h2>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {pins.map((t) => (
          <li
            key={t.id}
            className="relative flex flex-col gap-2 rounded-2xl border bg-card px-4 py-3 transition-colors hover:border-primary/40"
          >
            <Link
              to={`/t/${t.id}`}
              className="line-clamp-2 font-medium after:absolute after:inset-0"
            >
              {t.title}
            </Link>
            <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
              <BoardBadge board={t.board} />
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="size-3.5" aria-label="回复" /> {t.reply_count}
              </span>
              <span className="inline-flex items-center gap-1">
                <Heart className="size-3.5" aria-label="获赞" /> {t.like_count}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Every badge they have, gold first; those earned per floor list the latest floors.
function BadgeList({ badges, now }: { badges: NonNullable<LoaderData["badges"]>; now: number }) {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {badges.map((b) => (
        <li key={b.id} className="min-w-0 rounded-2xl border bg-card px-4 py-3">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full",
                TIER_STYLES[b.tier],
              )}
            >
              <Award className="size-5" aria-label={`${TIER_NAMES[b.tier]}徽章`} />
            </span>
            <div className="min-w-0 flex-1">
              <Link to={`/badges/${b.id}`} className="font-medium hover:underline">
                {b.name}
                {b.count > 1 && (
                  <span className="ml-1 text-meta font-normal text-muted-foreground">
                    ×{b.count}
                  </span>
                )}
              </Link>
              <p className="text-meta text-muted-foreground">{b.description}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{ago(b.granted_at, now)}获得</p>
              {b.posts.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-0.5">
                  {b.posts.map((p) => (
                    <li key={p.post_id} className="truncate text-meta">
                      <Link
                        to={`/t/${p.thread_id}?floor=${p.floor}`}
                        className="text-link hover:underline"
                      >
                        {p.title} #{p.floor}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Empty() {
  return <p className="py-16 text-center text-sm text-muted-foreground">暂无内容</p>;
}

// Liked floors say with what, and when rather than when they were written.
function PostRows({ posts, now }: { posts: UserPost[]; now: number }) {
  return posts.map((p) => (
    <li
      key={p.id}
      className="relative rounded-xl px-3 py-3.5 before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden transition-colors hover:bg-accent/60 sm:px-4"
    >
      <Link
        to={`/t/${p.thread.id}?floor=${p.floor}`}
        className="line-clamp-2 font-medium after:absolute after:inset-0"
      >
        {p.thread.title}
      </Link>
      <p className="mt-1 line-clamp-2 text-meta text-foreground/80">{p.excerpt}</p>
      <p className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
        {p.emoji !== undefined && <span>{REACTIONS.find((r) => r.key === p.emoji)?.emoji}</span>}
        <span>#{p.floor}</span>
        <span>{ago(p.liked_at ?? p.created_at, now)}</span>
        {p.like_count > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Heart className="size-3" /> {p.like_count}
          </span>
        )}
      </p>
    </li>
  ));
}

// The next page of a list loads when its link comes near the screen, as lists of threads do.
function MoreRows({ cursor }: { cursor: string }) {
  const { load, state, data: page } = useFetcher<typeof loader>();
  const link = useRef<HTMLAnchorElement>(null);
  const { pathname, search } = useLocation();
  const query = new URLSearchParams(search);
  query.set("cursor", cursor);
  const href = `${pathname}?${query}`;
  useNearView(link, state === "idle" && !page, () => void load(href));

  if (!page) {
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
      {page.posts && <PostRows posts={page.posts} now={page.now} />}
      {page.people && <PeopleRows people={page.people} now={page.now} />}
      {page.next_cursor !== null && <MoreRows cursor={page.next_cursor} />}
    </>
  );
}

function PeopleRows({ people, now }: { people: Person[]; now: number }) {
  return people.map((p) => (
    <li key={p.user.id}>
      <Link
        to={`/u/${p.user.id}`}
        className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-accent/60 sm:px-4"
      >
        <UserAvatar user={p.user} className="size-9" />
        <span className="min-w-0 flex-1 truncate font-medium">{p.user.display_name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{ago(p.created_at, now)}</span>
      </Link>
    </li>
  ));
}

function Summary({ summary, now }: { summary: NonNullable<LoaderData["summary"]>; now: number }) {
  const { top_posts, likers, liked } = summary;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="px-1 text-sm font-medium">获赞最多</h2>
        {top_posts.length === 0 ? (
          <Empty />
        ) : (
          <ul className="mt-1">
            <PostRows posts={top_posts} now={now} />
          </ul>
        )}
      </div>
      {likers && liked && (
        <div className="grid gap-6 sm:grid-cols-2">
          <Tally title="最常赞 TA 的人" people={likers} />
          <Tally title="TA 最常赞的人" people={liked} />
        </div>
      )}
    </div>
  );
}

function Tally({
  title,
  people,
}: {
  title: string;
  people: NonNullable<NonNullable<LoaderData["summary"]>["likers"]>;
}) {
  return (
    <div>
      <h2 className="px-1 text-sm font-medium">{title}</h2>
      {people.length === 0 ? (
        <p className="px-1 py-6 text-meta text-muted-foreground">暂无</p>
      ) : (
        <ul className="mt-1">
          {people.map((p) => (
            <li key={p.user.id}>
              <Link
                to={`/u/${p.user.id}`}
                className="flex items-center gap-3 rounded-xl px-1 py-1.5 hover:bg-accent/60"
              >
                <UserAvatar user={p.user} className="size-7" />
                <span className="min-w-0 flex-1 truncate text-sm">{p.user.display_name}</span>
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                  <Heart className="size-3" /> {p.count}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The next level's requirements with how far along they are, or what keeps L4 (design §6.6).
function LevelProgress({ progress }: { progress: NonNullable<LoaderData["progress"]> }) {
  const { level, locked, next } = progress;
  if (!next) {
    return locked ? (
      <p className="px-1 text-meta text-muted-foreground">
        等级已由管理员设为 {levelName(level)}，不再自动调整
      </p>
    ) : null;
  }
  const keep = next.level === level;
  return (
    <section aria-label="升级进度" className="rounded-2xl border bg-card px-4 py-3.5">
      <h2 className="text-sm font-medium">
        {keep ? `保持 ${levelName(level)}` : `升到 ${levelName(next.level)}`}
        <span className="ml-2 text-meta font-normal text-muted-foreground">
          {next.level === 4 ? `按最近 ${RECENT_DAYS} 天计算` : "累计"}
        </span>
      </h2>
      <ul className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {next.items.map((item) => {
          const shown = (n: number) => (item.key === "read_seconds" ? duration(n) : n);
          const done = item.have >= item.need;
          return (
            <li key={item.key}>
              <div className="flex justify-between gap-2 text-meta">
                <span>{item.label}</span>
                <span
                  className={cn(
                    "tabular-nums",
                    done ? "font-medium text-primary" : "text-muted-foreground",
                  )}
                >
                  {shown(Math.min(item.have, item.need))} / {shown(item.need)}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn("h-full rounded-full", done ? "bg-primary" : "bg-primary/50")}
                  style={{ width: `${Math.min(100, (item.have / item.need) * 100)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
