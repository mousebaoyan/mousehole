import { Search as SearchIcon, X } from "lucide-react";
import { Fragment, useRef } from "react";
import { data, Form, Link, useFetcher, useLocation } from "react-router";
import { apiContext } from "../api.server.ts";
import { cn } from "cn";
import { BoardBadge } from "~/components/board-badge";
import { Dot, FILTER, FilterMenu } from "~/components/filter-menu";
import { tagChoices } from "~/components/thread-feed";
import { UserAvatar } from "~/components/user-avatar";
import { useBoards, useTags } from "~/forum";
import { useNearView } from "~/near-view";
import { ago, unixNow } from "~/time";
import type { Route } from "./+types/search.ts";
import { SITE_NAME } from "../../server/platform/site.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData.filters.q
        ? `${loaderData.filters.q} · 搜索 · ${SITE_NAME}`
        : `搜索 · ${SITE_NAME}`,
    },
  ];
}

const KINDS = [
  { value: "", label: "全部类型" },
  { value: "discussion", label: "讨论" },
  { value: "question", label: "问答" },
] as const;

const SOLVED = [
  { value: "", label: "全部状态" },
  { value: "true", label: "已解决" },
  { value: "false", label: "待解答" },
] as const;

const SINCE = [
  { value: "", label: "不限时间" },
  { value: "week", label: "一周内" },
  { value: "month", label: "一个月内" },
  { value: "year", label: "一年内" },
] as const;

const SORTS = [
  { value: "", label: "相关度" },
  { value: "created", label: "最新发布" },
  { value: "last_post", label: "最新回复" },
  { value: "replies", label: "回复最多" },
  { value: "likes", label: "点赞最多" },
] as const;

function pick<T extends string>(options: readonly { value: T }[], value: string | null) {
  return options.find((o) => o.value === value)?.value ?? options[0].value;
}

// The filters in the address (design §8.5); defaults are left out.
function readSearch(url: string) {
  const params = new URL(url).searchParams;
  return {
    q: params.get("q")?.trim().slice(0, 100) ?? "",
    board: params.get("board") ?? "",
    tag: params.get("tag") ?? "",
    author: params.get("author") ?? "",
    kind: pick(KINDS, params.get("kind")),
    solved: pick(SOLVED, params.get("solved")),
    since: pick(SINCE, params.get("since")),
    title_only: params.get("title_only") === "true" ? ("true" as const) : ("" as const),
    sort: pick(SORTS, params.get("sort")),
  };
}

type Filters = ReturnType<typeof readSearch>;

function searchUrl(filters: Filters, change: Partial<Filters>) {
  const params = new URLSearchParams(
    Object.entries({ ...filters, ...change }).filter(([, v]) => v !== ""),
  );
  return `/search?${params}`;
}

// Threads and replies for ?q= and the filters, a page at a time; on the first page, also members
// by name for those signed in, and the 楼主 filtered on.
export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const filters = readSearch(request.url);
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  const { q } = filters;
  const [res, people, author] = await Promise.all([
    q === ""
      ? null
      : api.search.$get({
          query: {
            q,
            board: filters.board || undefined,
            tag: filters.tag || undefined,
            author: filters.author || undefined,
            kind: filters.kind || undefined,
            solved: filters.solved || undefined,
            since: filters.since || undefined,
            title_only: filters.title_only || undefined,
            sort: filters.sort || undefined,
            cursor,
          },
        }),
    q === "" || cursor !== undefined ? null : api.users.$get({ query: { q: q.slice(0, 20) } }),
    filters.author === "" ? null : api.users[":user"].$get({ param: { user: filters.author } }),
  ]);
  if (res && !res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = res ? await res.json() : { items: [], next_cursor: null };
  return {
    filters,
    authorName: author?.ok ? (await author.json()).display_name : null,
    results: page.items,
    users: people?.ok ? (await people.json()).items : [],
    next_cursor: page.next_cursor,
    now: unixNow(),
  };
}

type Result = Route.ComponentProps["loaderData"]["results"][number];

export default function Search({ loaderData }: Route.ComponentProps) {
  const { filters, authorName, results, users, next_cursor, now } = loaderData;
  const { q } = filters;
  return (
    <section>
      <Form className="mb-3 flex h-11 items-center gap-2 rounded-full bg-secondary px-4 focus-within:ring-2 focus-within:ring-ring/40">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          type="search"
          name="q"
          defaultValue={q}
          key={q}
          aria-label="搜索"
          placeholder="搜索帖子、回复、用户"
          maxLength={100}
          className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
        />
        {/* Searching again keeps the filters. */}
        {Object.entries(filters).map(
          ([name, value]) =>
            name !== "q" &&
            value !== "" && <input key={name} type="hidden" name={name} value={value} />,
        )}
      </Form>
      <SearchFilters filters={filters} authorName={authorName} />
      {users.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2 px-1">
          {users.map((u) => (
            <Link
              key={u.id}
              to={`/u/${u.id}`}
              className="inline-flex items-center gap-1.5 rounded-full border bg-card py-1 pr-3 pl-1 text-sm hover:bg-accent"
            >
              <UserAvatar user={u} className="size-6 text-2xs" />
              {u.display_name}
            </Link>
          ))}
        </div>
      )}
      {q !== "" && results.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">没有找到相关的内容</p>
      )}
      <ul className="stagger">
        <Results results={results} q={q} now={now} />
        {next_cursor !== null && <More cursor={next_cursor} />}
      </ul>
    </section>
  );
}

// A filter menu over fixed options, each a link to the search with that option.
function OptionMenu<T extends string>({
  label,
  options,
  value,
  to,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  to: (value: T) => string;
}) {
  return (
    <FilterMenu
      label={label}
      trigger={options.find((o) => o.value === value)?.label}
      choices={options.map((o) => ({ to: to(o.value), label: o.label, chosen: o.value === value }))}
    />
  );
}

function SearchFilters({ filters, authorName }: { filters: Filters; authorName: string | null }) {
  const boards = useBoards();
  const tags = useTags();
  const url = (change: Partial<Filters>) => searchUrl(filters, change);
  const board = boards.find((b) => b.slug === filters.board);
  return (
    <div className="mb-4 flex flex-wrap gap-2 px-1">
      <FilterMenu
        label="按版块筛选"
        trigger={
          <>
            {board && <Dot color={board.color} />}
            {board ? board.name : "全部版块"}
          </>
        }
        choices={[
          { to: url({ board: "" }), label: "全部版块", chosen: !board },
          ...boards.map((b) => ({
            to: url({ board: b.slug }),
            label: b.name,
            color: b.color,
            chosen: b === board,
          })),
        ]}
      />
      <FilterMenu
        label="按标签筛选"
        trigger={filters.tag === "" ? "全部标签" : `#${filters.tag}`}
        choices={[
          { to: url({ tag: "" }), label: "全部标签", chosen: filters.tag === "" },
          ...tagChoices(tags, filters.tag, (tag) => url({ tag })),
        ]}
      />
      <OptionMenu
        label="按类型筛选"
        options={KINDS}
        value={filters.kind}
        to={(kind) => url({ kind })}
      />
      <OptionMenu
        label="按是否解决筛选"
        options={SOLVED}
        value={filters.solved}
        to={(solved) => url({ solved })}
      />
      <OptionMenu
        label="按发布时间筛选"
        options={SINCE}
        value={filters.since}
        to={(since) => url({ since })}
      />
      <OptionMenu label="排序" options={SORTS} value={filters.sort} to={(sort) => url({ sort })} />
      <Link
        to={url({ title_only: filters.title_only ? "" : "true" })}
        aria-pressed={filters.title_only !== ""}
        className={cn(FILTER, filters.title_only && "border-primary bg-primary/10 text-primary")}
      >
        只搜标题
      </Link>
      {filters.author !== "" && (
        <Link to={url({ author: "" })} aria-label="不按楼主筛选" className={FILTER}>
          楼主：{authorName ?? filters.author}
          <X className="size-3.5 text-muted-foreground" />
        </Link>
      )}
    </div>
  );
}

function Results({ results, q, now }: { results: Result[]; q: string; now: number }) {
  return results.map((r) => (
    <li
      key={r.thread.id}
      className="relative rounded-xl px-3 py-3.5 before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden transition-colors hover:bg-accent/60 sm:px-4"
    >
      <Link
        to={r.post.floor > 1 ? `/t/${r.thread.id}?floor=${r.post.floor}` : `/t/${r.thread.id}`}
        className="font-medium after:absolute after:inset-0"
      >
        <Marked text={r.thread.title} q={q} />
      </Link>
      <p className="mt-1 line-clamp-2 text-meta text-foreground/80">
        <Marked text={r.snippet} q={q} />
      </p>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <BoardBadge board={r.thread.board} />
        {r.post.floor > 1 && <span>#{r.post.floor}</span>}
        <span>{r.thread.reply_count} 条回复</span>
        <span>{ago(r.thread.last_post_at, now)}</span>
      </p>
    </li>
  ));
}

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

// The words of the query marked where they appear, ignoring case.
function Marked({ text, q }: { text: string; q: string }) {
  const words = q.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map((w) => w.replaceAll(ESCAPE, "\\$&")).join("|")})`, "gi");
  return text
    .split(pattern)
    .map((part, i) => (
      <Fragment key={i}>
        {i % 2 === 1 ? <mark className="rounded-sm bg-brand/20 text-inherit">{part}</mark> : part}
      </Fragment>
    ));
}

// The next page loads when its link comes near the screen, as the thread lists do.
function More({ cursor }: { cursor: string }) {
  const { load, state, data: page } = useFetcher<typeof loader>();
  const link = useRef<HTMLAnchorElement>(null);
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  params.set("cursor", cursor);
  const href = `/search?${params}`;
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
      <Results results={page.results} q={page.filters.q} now={page.now} />
      {page.next_cursor !== null && <More cursor={page.next_cursor} />}
    </>
  );
}
