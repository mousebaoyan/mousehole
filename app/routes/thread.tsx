import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { data, redirect, useFetcher, useNavigate } from "react-router";
import { ArrowDown, Reply } from "~/components/icons";
import { apiContext } from "../api.server.ts";
import type { PostItem, UserBrief } from "~/api-types";
import { useComposer } from "~/components/composer";
import { CopyLinkButton } from "~/components/copy-link-button";
import { ThreadList, ThreadRows } from "~/components/thread-list";
import { Button } from "~/components/ui/button";
import { useMe } from "~/forum";
import { useNearView } from "~/near-view";
import { shareMeta } from "~/share-meta";
import { stamp, unixNow } from "~/time";
import type { Route } from "./+types/thread.ts";
import { FloorNav, FloorProgress, useCurrentFloor, type Floors } from "./floor-timeline.tsx";
import { BookmarkButton, NOTIFY_LEVELS, NotifyButton } from "./follow-buttons.tsx";
import { LotteryCard } from "./lottery-card.tsx";
import { PollCard } from "./poll-card.tsx";
import { PostCard } from "./post-card.tsx";
import { REACTIONS } from "./reactions.tsx";
import { useReading } from "./reading.ts";
import { ThreadHeader } from "./thread-header.tsx";
import { confirmDialog } from "~/components/ui/dialog";
import { toast } from "~/components/ui/toast";
import { browserApi } from "~/browser-api";
import { isMine, levelPower, RevealContext, sameWriter } from "~/components/writer";
import { STAFF } from "../../server/platform/site.ts";

// Floors come 20 at a time; see design §9.
const BATCH = 20;

export function meta({ loaderData }: Route.MetaArgs) {
  const { thread } = loaderData;
  return [
    ...shareMeta([thread.title, thread.board.name], thread.excerpt),
    { property: "og:type", content: "article" },
    { property: "og:url", content: thread.url },
  ];
}

// The largest floor number the API takes, so a ?floor= past it still opens on the last floors.
const LAST_FLOOR = 2 ** 31 - 1;

// The page opens at ?floor=N, or the opening post, and shows the 20 floors from there. Near the
// end it takes the floors before too, so it doesn't open on a lone floor.
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const asked = Math.trunc(Number(new URL(request.url).searchParams.get("floor")) || 1);
  const start = Math.min(LAST_FLOOR, Math.max(1, asked));
  const param = { id: params.id };
  const [threadRes, afterRes, latestRes] = await Promise.all([
    api.threads[":id"].$get({ param }),
    api.threads[":id"].posts.$get({ param, query: { after: String(start - 1) } }),
    // Enough for the five suggestions below, this one and pinned ones aside.
    api.threads.$get({ query: { limit: "6" } }),
  ]);
  // Its author keeps it from guests, or its board wants a higher level (design §8.10).
  if (threadRes.status === 401 || threadRes.status === 403) {
    throw data((await threadRes.json()).error.message, { status: threadRes.status });
  }
  // Merged into another (design §8.20): on to where the floor asked for is now.
  if (afterRes.status === 404) {
    const { thread_id, floor } = await afterRes.json();
    if (thread_id !== undefined && floor !== undefined) {
      return redirect(`/t/${thread_id}${floor > 1 ? `?floor=${floor}` : ""}`, 301);
    }
  }
  if (!threadRes.ok || !afterRes.ok) throw data("帖子不存在", { status: 404 });
  const thread = await threadRes.json();
  const after = (await afterRes.json()).items;
  let posts = after;
  if (after.length < BATCH && start > 1) {
    const beforeRes = await api.threads[":id"].posts.$get({
      param,
      query: { before: String(after.at(0)?.floor ?? start) },
    });
    if (beforeRes.ok) posts = [...(await beforeRes.json()).items, ...after];
  }
  const latest = latestRes.ok ? (await latestRes.json()).items : [];
  return {
    thread,
    posts,
    start: after.at(0)?.floor ?? posts.at(-1)?.floor ?? 1,
    moreAfter: after.length === BATCH,
    suggested: latest.filter((t) => t.id !== thread.id && t.pinned === 0).slice(0, 5),
    now: unixNow(),
  };
}

// Changes to the floors on this page. They answer with the floor to show next, so the page can
// open there with fresh data; a deleted thread leaves for its board.
export async function action({ params, request, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const form = await request.formData();
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  // A moderator's review, from the thread's or a floor's menu.
  const review = () =>
    form.has("status")
      ? {
          status: text("status") === "hidden" ? ("hidden" as const) : ("visible" as const),
          reason: text("reason") || undefined,
        }
      : {};
  const post = { id: text("post_id") };
  const floor = Number(text("floor"));
  const thread = { id: params.id };
  if (text("intent") === "edit-thread") {
    const res = await api.threads[":id"].$patch({
      param: thread,
      json: {
        title: form.has("title") ? text("title") : undefined,
        tags: form.has("tags_set")
          ? form.getAll("tags").filter((t) => typeof t === "string")
          : undefined,
        board: form.has("board") ? text("board") : undefined,
        pinned: form.has("pinned") ? Number(text("pinned")) : undefined,
        featured: form.has("featured") ? text("featured") === "true" : undefined,
        locked: form.has("locked") ? text("locked") === "true" : undefined,
        ...review(),
      },
    });
    if (res.ok) return { ok: true as const, floor };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "suggest") {
    const res = await api.threads[":id"].suggestions.$post({
      param: thread,
      json: {
        title: text("title"),
        board: text("board"),
        tags: form.getAll("tags").filter((t) => typeof t === "string"),
        reason: text("reason") || undefined,
      },
    });
    if (res.ok)
      return { ok: true as const, floor, message: "修改建议已提交，楼主或版主同意后生效" };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "summary") {
    const res = await api.threads[":id"].summary.$patch({
      param: thread,
      json: { disabled: text("disabled") === "true" },
    });
    if (res.ok) return { ok: true as const, floor };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "decide-suggestion") {
    const res = await api.suggestions[":id"].$patch({
      param: { id: text("suggestion_id") },
      json: { status: text("decision") === "accepted" ? "accepted" : "rejected" },
    });
    if (res.ok) return { ok: true as const, floor };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "react") {
    const emoji = REACTIONS.find((r) => r.key === text("emoji"))?.key;
    const res = emoji
      ? await api.posts[":id"].reaction.$put({ param: post, json: { emoji } })
      : await api.posts[":id"].reaction.$delete({ param: post });
    if (res.ok) return { ok: true as const, saved: emoji ?? null };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "boost") {
    const body = text("body");
    const res = body
      ? await api.posts[":id"].boost.$put({ param: post, json: { body } })
      : await api.posts[":id"].boost.$delete({ param: post });
    if (res.ok) return { ok: true as const, saved: body || null };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "remove-boost") {
    const res = await api.boosts[":id"].$delete({ param: { id: text("boost_id") }, json: {} });
    if (res.ok) return { ok: true as const };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "archive-flag") {
    const flagged = text("flagged") === "true";
    const flag = api.posts[":id"]["archive-flag"];
    const res = flagged ? await flag.$put({ param: post }) : await flag.$delete({ param: post });
    if (res.ok) return { ok: true as const, saved: flagged };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "bookmark") {
    const bookmarked = text("bookmarked") === "true";
    const res = bookmarked
      ? await api.threads[":id"].bookmark.$put({ param: thread })
      : await api.threads[":id"].bookmark.$delete({ param: thread });
    if (res.ok) return { ok: true as const, saved: bookmarked };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "notify") {
    const level = NOTIFY_LEVELS.find((l) => l.level === text("level"))?.level;
    if (!level) throw data("关注级别无效", { status: 400 });
    const res = await api.threads[":id"].subscription.$put({ param: thread, json: { level } });
    if (res.ok) return { ok: true as const, saved: level };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "report") {
    const note = text("note").trim();
    const json = { reason: (note ? `${text("reason")}：${note}` : text("reason")).slice(0, 200) };
    const res = form.has("boost_id")
      ? await api.boosts[":id"].report.$post({ param: { id: text("boost_id") }, json })
      : await api.posts[":id"].report.$post({ param: post, json });
    if (res.ok) return { ok: true as const, message: "举报已提交，版主会尽快处理" };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "accept" || text("intent") === "unaccept") {
    const answer = api.threads[":id"].answers[":post"];
    const param = { ...thread, post: text("post_id") };
    const res =
      text("intent") === "accept" ? await answer.$put({ param }) : await answer.$delete({ param });
    if (res.ok) return { ok: true as const, floor };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "vote" || text("intent") === "close-poll") {
    const res =
      text("intent") === "vote"
        ? await api.threads[":id"].poll.vote.$put({
            param: thread,
            json: { options: form.getAll("options").map(Number) },
          })
        : await api.threads[":id"].poll.close.$post({ param: thread });
    if (res.ok) return { ok: true as const, poll: await res.json() };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "enter-lottery" || text("intent") === "leave-lottery") {
    const res =
      text("intent") === "enter-lottery"
        ? await api.threads[":id"].lottery.entry.$put({ param: thread })
        : await api.threads[":id"].lottery.entry.$delete({ param: thread });
    if (res.ok) return { ok: true as const, lottery: await res.json() };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "cancel-lottery") {
    const res = await api.threads[":id"].lottery.cancel.$post({ param: thread });
    if (res.ok) return { ok: true as const, lottery: await res.json() };
    return { ok: false as const, message: (await res.json()).error.message };
  }
  if (text("intent") === "delete-thread") {
    const res = await api.threads[":id"].$delete({ param: thread });
    if (res.ok) return redirect(`/b/${text("board")}`);
    return { ok: false as const, message: (await res.json()).error.message };
  }
  const res =
    text("intent") === "delete-post"
      ? await api.posts[":id"].$delete({ param: post })
      : await api.posts[":id"].$patch({
          param: post,
          json:
            text("intent") === "review-post"
              ? review()
              : { content: { markdown: text("markdown") } },
        });
  if (res.ok) return { ok: true as const, floor };
  return { ok: false as const, message: (await res.json()).error.message };
}

export default function Thread({ loaderData }: Route.ComponentProps) {
  // Out here, so what was read carries over the page's fresh starts.
  const read = useReading(loaderData.thread.id, loaderData.thread.read_floors);
  // Each load starts afresh: a jump to a floor that isn't on the page, or a change to one.
  return (
    <ThreadPage
      key={`${loaderData.thread.id}:${loaderData.start}:${loaderData.now}`}
      {...loaderData}
      read={read}
    />
  );
}

// `read` is null for guests, whose reading isn't tracked.
function ThreadPage({
  thread,
  posts: initial,
  start,
  moreAfter,
  suggested,
  now,
  read,
}: Route.ComponentProps["loaderData"] & { read: Set<number> | null }) {
  const openComposer = useComposer();
  const navigate = useNavigate();
  const me = useMe();
  const staff = me !== null && STAFF.includes(me.role);
  // How the reader writes here (design §8.12).
  const myAlias = thread.my_alias ?? null;
  const authored = isMine(thread.author, me, myAlias);
  const power = levelPower(thread.author, me);
  const self = {
    alias: myAlias,
    anonymous: authored ? thread.author_anonymous : thread.anonymous_replies,
  };
  // Who the anonymous people are, once an admin asks; logged on the server.
  const [revealed, setRevealed] = useState<Map<number, UserBrief> | null>(null);
  const anonymity = thread.author_anonymous || thread.anonymous_replies;
  async function toggleReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    const res = await browserApi.threads[":id"].aliases.$get({ param: { id: String(thread.id) } });
    if (res.ok) setRevealed(new Map((await res.json()).items.map((a) => [a.number, a.user])));
    else toast((await res.json()).error.message);
  }
  // Deletions: the page then reopens at the floor, with the change in it.
  const changes = useFetcher<typeof action>();
  useEffect(() => {
    if (changes.state !== "idle" || !changes.data) return;
    if (changes.data.ok) void navigate(`?floor=${changes.data.floor}`, { replace: true });
    else toast(changes.data.message);
  }, [changes.state, changes.data, navigate]);
  const later = useFetcher<PostItem[]>();
  const earlier = useFetcher<PostItem[]>();
  const [loaded, setLoaded] = useState({
    posts: initial,
    atEnd: !moreAfter,
    later: later.data,
    earlier: earlier.data,
  });
  // Floors fetched as the reader scrolls join the ones on the page, as soon as they arrive.
  if (later.data !== loaded.later || earlier.data !== loaded.earlier) {
    let { posts, atEnd } = loaded;
    if (later.data && later.data !== loaded.later) {
      const tail = posts.at(-1)?.floor ?? 0;
      posts = [...posts, ...later.data.filter((p) => p.floor > tail)];
      atEnd = later.data.length < BATCH;
    }
    if (earlier.data && earlier.data !== loaded.earlier) {
      const head = posts.at(0)?.floor ?? Infinity;
      posts = [...earlier.data.filter((p) => p.floor < head), ...posts];
    }
    setLoaded({ posts, atEnd, later: later.data, earlier: earlier.data });
  }
  const { posts, atEnd } = loaded;
  const top = useRef<HTMLLIElement>(null);
  const bottom = useRef<HTMLLIElement>(null);
  const first = posts.at(0)?.floor ?? 1;
  const last = posts.at(-1)?.floor ?? 0;

  // Before the current floor is measured, so it is measured from here. In a microtask: on a
  // navigation, <ScrollRestoration> scrolls to the top in a layout effect that runs after this
  // one, and the microtask comes after the whole commit but still before the page is painted.
  useLayoutEffect(() => {
    const element = start > 1 && document.getElementById(`floor-${start}`);
    if (element) {
      queueMicrotask(() => element.scrollIntoView());
      flash(element);
    }
  }, [start]);
  const [current, setCurrent] = useCurrentFloor(start);
  const newest = useNewestFloor(thread.id, thread.floor_count);

  // The address follows the floor being read, so a refresh, a shared link or Back returns to it.
  // Replaced directly: a router navigation would load the page again.
  useEffect(() => {
    const url = new URL(location.href);
    if (current > 1) url.searchParams.set("floor", String(current));
    else url.searchParams.delete("floor");
    history.replaceState(history.state, "", url);
  }, [current]);

  useNearView(bottom, !atEnd && later.state === "idle", () => {
    void later.load(`/t/${thread.id}/floors?after=${last}`);
  });
  useNearView(top, first > 1 && earlier.state === "idle", () => {
    void earlier.load(`/t/${thread.id}/floors?before=${first}`);
  });

  // Floors put above keep what was being read in place: the first floor that was on the page is
  // moved back to where it was. Done here rather than by the browser's scroll anchoring, which
  // Safari, and so QQ on iPhones, doesn't have. Offsets are from the top of the document, so
  // scrolling while the floors load doesn't matter.
  const firstOffset = useRef<{ floor: number; offset: number } | null>(null);
  useLayoutEffect(() => {
    const before = firstOffset.current;
    const old = before && document.getElementById(`floor-${before.floor}`);
    if (before && old && first < before.floor) scrollBy(0, documentTop(old) - before.offset);
    const element = document.getElementById(`floor-${first}`);
    firstOffset.current = element && { floor: first, offset: documentTop(element) };
  }, [first]);

  function jump(floor: number) {
    const element = document.getElementById(`floor-${floor}`);
    if (element) {
      element.scrollIntoView();
      flash(element);
      setCurrent(floor);
    } else {
      void navigate(`?floor=${floor}`, { preventScrollReset: true });
    }
  }

  const target = { id: thread.id, title: thread.title, my_anonymity: thread.my_anonymity };
  // Replies, and answers to accept, wait until the thread itself is public.
  const published = thread.status === "visible";
  const accept = thread.kind === "question" && published && (staff || (authored && !thread.locked));
  const acceptHint =
    accept &&
    authored &&
    thread.accepted_floors.length === 0 &&
    posts.some(
      (p) =>
        p.floor > 1 && p.status === "visible" && !p.deleted && !sameWriter(p.author, thread.author),
    );
  const floors: Floors = {
    posts,
    total: thread.floor_count,
    current,
    jump,
    first: stamp(thread.created_at, now),
    last: stamp(thread.last_post_at, now),
    now,
  };

  return (
    <RevealContext value={revealed}>
      <div className="flex gap-8">
        <article className="min-w-0 flex-1">
          <ThreadHeader
            thread={thread}
            current={current}
            now={now}
            editable={
              staff ||
              (authored && !thread.locked) ||
              (power >= 4 && (!thread.locked || power >= 5))
            }
            staff={staff}
            power={power}
            acceptHint={acceptHint}
            reveal={
              me?.role === "admin" && anonymity
                ? { shown: revealed !== null, toggle: () => void toggleReveal() }
                : null
            }
          />

          {/* No browser scroll anchoring: floors put above are compensated for by hand. */}
          <ol className="flex flex-col [overflow-anchor:none]">
            {first > 1 && (
              <li ref={top} className="py-3 text-center text-meta">
                <a
                  href={`?floor=${Math.max(1, first - BATCH)}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {earlier.state === "loading"
                    ? "加载中…"
                    : `加载前 ${Math.min(first - 1, BATCH)} 层`}
                </a>
              </li>
            )}
            {posts.map((post) => (
              <PostCard
                key={post.id}
                post={post}
                threadId={thread.id}
                op={sameWriter(post.author, thread.author)}
                accepted={post.accepted}
                unread={read === null ? undefined : !read.has(post.floor)}
                now={now}
                parent={posts.find((p) => p.id === post.reply_to?.id)}
                self={self}
                manage={{
                  edit:
                    staff ||
                    (isMine(post.author, me, myAlias) && !thread.locked) ||
                    levelPower(post.author, me) >= 5,
                  remove: staff || (isMine(post.author, me, myAlias) && !thread.locked),
                  history: staff || isMine(post.author, me, myAlias),
                  deleteThread:
                    staff ||
                    (isMine(post.author, me, myAlias) &&
                      !thread.locked &&
                      thread.reply_count === 0),
                  moderate: staff,
                  accept: accept && post.floor > 1,
                  // The opening post is reviewed with its thread, above.
                  review: staff && published && post.floor > 1,
                }}
                onJump={jump}
                onEdit={(markdown) =>
                  openComposer({
                    mode: "edit",
                    thread: target,
                    post: { id: post.id, floor: post.floor, markdown },
                  })
                }
                onAccept={() =>
                  void changes.submit(
                    {
                      intent: post.accepted ? "unaccept" : "accept",
                      post_id: post.id,
                      floor: post.floor,
                    },
                    { method: "post", defaultShouldRevalidate: false },
                  )
                }
                onDelete={async () => {
                  const question = post.floor === 1 ? "删除这个帖子？" : `删除 #${post.floor}？`;
                  if (!(await confirmDialog(question, "删除"))) return;
                  void changes.submit(
                    post.floor === 1
                      ? { intent: "delete-thread", board: thread.board.slug }
                      : { intent: "delete-post", post_id: post.id, floor: post.floor },
                    { method: "post", defaultShouldRevalidate: false },
                  );
                }}
                onReview={(review) =>
                  void changes.submit(
                    { intent: "review-post", post_id: post.id, floor: post.floor, ...review },
                    { method: "post", defaultShouldRevalidate: false },
                  )
                }
                card={
                  post.floor !== 1 ? null : thread.poll ? (
                    <PollCard
                      poll={thread.poll}
                      threadId={thread.id}
                      canVote={me !== null && published && !thread.locked}
                      canClose={staff || authored}
                      now={now}
                    />
                  ) : thread.lottery ? (
                    <LotteryCard
                      lottery={thread.lottery}
                      threadId={thread.id}
                      me={me && { id: me.id, level: me.level, staff }}
                      canEnter={me !== null && published && !thread.locked && !authored}
                      canCancel={staff || authored}
                      now={now}
                    />
                  ) : null
                }
                onReply={
                  published
                    ? () =>
                        openComposer({
                          mode: "reply",
                          thread: target,
                          replyTo: {
                            id: post.id,
                            floor: post.floor,
                            name: post.author.display_name,
                          },
                        })
                    : undefined
                }
              />
            ))}
            {!atEnd && (
              <li ref={bottom} className="py-3 text-center text-meta">
                <a
                  href={`?floor=${last + 1}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {later.state === "loading" ? "加载中…" : "加载后 20 层"}
                </a>
              </li>
            )}
          </ol>

          {/* Lined up with the avatars above. */}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t px-3 pt-5 sm:px-4">
            {published && (
              <Button
                size="lg"
                onClick={() => openComposer({ mode: "reply", thread: target, replyTo: null })}
              >
                <Reply /> 回复
              </Button>
            )}
            <BookmarkButton threadId={thread.id} initial={thread.bookmarked ?? false} />
            <NotifyButton threadId={thread.id} initial={thread.notify_level} />
            <CopyLinkButton path={`/t/${thread.id}`} size="icon-lg" />
          </div>

          {suggested.length > 0 && (
            <section className="mt-12">
              <h2 className="px-3 font-semibold sm:px-4">推荐帖子</h2>
              <div className="mt-3">
                <ThreadList>
                  <ThreadRows threads={suggested} now={now} showBoard />
                </ThreadList>
              </div>
            </section>
          )}
        </article>

        <aside className="hidden w-56 shrink-0 xl:block">
          <nav aria-label="楼层" className="sticky top-20 rounded-2xl border bg-card p-3 text-meta">
            <FloorNav floors={floors} />
          </nav>
        </aside>
        <FloorProgress floors={floors} />
        {newest > thread.floor_count && (
          // Opens the page again from the first new floor, with all that came since.
          <button
            type="button"
            onClick={() => void navigate(`?floor=${thread.floor_count + 1}`)}
            className="fixed bottom-6 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg animate-in fade-in slide-in-from-bottom-2"
          >
            <ArrowDown className="size-4" /> {newest - thread.floor_count} 条新回复
          </button>
        )}
      </div>
    </RevealContext>
  );
}

// The highest floor of the thread, as it was loaded and then as the server tells of new ones.
function useNewestFloor(threadId: number, loaded: number) {
  const [newest, setNewest] = useState(loaded);
  useEffect(() => {
    const stream = new EventSource(`/api/v1/threads/${threadId}/stream`);
    stream.addEventListener("post.created", (e) => {
      setNewest((n) => Math.max(n, Number(e.data)));
    });
    return () => stream.close();
  }, [threadId]);
  return newest;
}

// Plays the glow again even when the same floor is jumped to twice.
function flash(element: HTMLElement) {
  element.classList.remove("floor-flash");
  void element.offsetWidth;
  element.classList.add("floor-flash");
}

function documentTop(element: HTMLElement) {
  return element.getBoundingClientRect().top + scrollY;
}
