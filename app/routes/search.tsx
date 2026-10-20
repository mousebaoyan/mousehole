import { type Loaded, Pages } from "~/components/pages";
import { Search as SearchIcon, Snowflake, X } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { Fragment } from "react";
import { data, Form, Link } from "react-router";
import { apiContext } from "../api.server.ts";
import { cn } from "~/cn";
import { BoardBadge } from "~/components/board-badge";
import { Dot, FILTER, FilterMenu } from "~/components/filter-menu";
import { tagChoices } from "~/components/thread-feed";
import { UserAvatar } from "~/components/user-avatar";
import { UserBadges } from "~/components/user-badges";
import { useBoards, useMe, useTags } from "~/forum";
import { ago, unixNow } from "~/time";
import type { Route } from "./+types/search.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    {
      title: loaderData.filters.q ? pageTitle(loaderData.filters.q, "搜索") : pageTitle("搜索"),
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
  { value: "hot", label: "最热" },
] as const;

function pick<T extends string>(options: readonly { value: T }[], value: string | null) {
  return options.find((o) => o.value === value)?.value ?? options[0].value;
}

// The filters in the address (design §8.5); defaults are left out. `type` is what is looked for,
// threads unless it says users; the threads' filters stay in the address while looking for users.
function readSearch(url: string) {
  const params = new URL(url).searchParams;
  return {
    type: params.get("type") === "users" ? ("users" as const) : ("" as const),
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

// Threads and replies for ?q= and the filters, with the 楼主 filtered on; or people. A page at a
// time.
export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const filters = readSearch(request.url);
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  const { q } = filters;
  if (filters.type === "users") {
    const res =
      q === "" ? null : await api.users.search.$get({ query: { q: q.slice(0, 30), cursor } });
    if (res && !res.ok) throw data((await res.json()).error.message, { status: res.status });
    const page = res ? await res.json() : { items: [], next_cursor: null };
    return {
      type: "users" as const,
      filters,
      people: page.items,
      next_cursor: page.next_cursor,
    };
  }
  const [res, author] = await Promise.all([
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
    filters.author === "" ? null : api.users[":user"].$get({ param: { user: filters.author } }),
  ]);
  if (res && !res.ok) throw data((await res.json()).error.message, { status: res.status });
  const page = res ? await res.json() : { items: [], next_cursor: null };
  return {
    type: "threads" as const,
    filters,
    authorName: author?.ok ? (await author.json()).display_name : null,
    results: page.items,
    next_cursor: page.next_cursor,
    now: unixNow(),
  };
}

type Data = Route.ComponentProps["loaderData"];
type Result = Extract<Data, { type: "threads" }>["results"][number];
type Person = Extract<Data, { type: "users" }>["people"][number];

// The pages of results each entry of the history showed (components/pages.tsx).
const kept = new Map<string, Loaded<typeof loader>[]>();

const TYPES = [
  { value: "", label: "帖子" },
  { value: "users", label: "用户" },
] as const;

export default function Search({ loaderData }: Route.ComponentProps) {
  const me = useMe();
  const { filters } = loaderData;
  const { q } = filters;
  const users = filters.type === "users";
  return (
    <section>
      <Form
        action="/search"
        className="mb-3 flex h-11 items-center gap-2 rounded-full bg-secondary px-4 focus-within:ring-2 focus-within:ring-ring/40"
      >
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          type="search"
          name="q"
          defaultValue={q}
          key={q}
          aria-label="搜索"
          placeholder={users ? "搜索名字、群名片、QQ 昵称或 QQ 号" : "搜索帖子和回复"}
          maxLength={users ? 30 : 100}
          className="w-full bg-transparent outline-none placeholder:text-muted-foreground"
        />
        {/* Searching again keeps the filters. */}
        {Object.entries(filters).map(
          ([name, value]) =>
            name !== "q" &&
            value !== "" && <input key={name} type="hidden" name={name} value={value} />,
        )}
      </Form>
      {/* Group cards and QQ numbers are for members, so guests look for threads only. */}
      {me && (
        <nav aria-label="搜索范围" className="mb-4 flex gap-6 border-b px-2">
          {TYPES.map((t) => (
            <Link
              key={t.value}
              to={searchUrl(filters, { type: t.value })}
              aria-current={t.value === filters.type ? "page" : undefined}
              className={cn(
                "-mb-px border-b-2 border-transparent px-1 pb-2 text-sm text-muted-foreground hover:text-foreground",
                t.value === filters.type && "border-foreground font-medium text-foreground",
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}
      {loaderData.type === "users" ? (
        <>
          {q !== "" && loaderData.people.length === 0 && (
            <p className="py-16 text-center text-sm text-muted-foreground">未找到相关用户</p>
          )}
          <ul className="stagger">
            <Pages<typeof loader> kept={kept} first={loaderData} next={(page) => page.next_cursor}>
              {(page) =>
                page.type === "users" && <People people={page.people} q={page.filters.q} />
              }
            </Pages>
          </ul>
        </>
      ) : (
        <Threads data={loaderData} />
      )}
    </section>
  );
}

function Threads({ data: loaded }: { data: Extract<Data, { type: "threads" }> }) {
  const { filters, authorName, results } = loaded;
  const { q } = filters;
  return (
    <>
      <SearchFilters filters={filters} authorName={authorName} />
      {q !== "" && (
        <nav
          aria-label="排序"
          className="-mx-1 mb-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]"
        >
          {SORTS.map((s) => (
            <Link
              key={s.value}
              to={searchUrl(filters, { sort: s.value })}
              preventScrollReset
              aria-current={s.value === filters.sort ? "page" : undefined}
              className={cn(
                "shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground",
                s.value === filters.sort && "bg-secondary font-medium text-foreground",
              )}
            >
              {s.label}
            </Link>
          ))}
        </nav>
      )}
      {q !== "" && results.length === 0 && (
        <p className="py-16 text-center text-sm text-muted-foreground">未找到相关内容</p>
      )}
      <ul className="stagger">
        <Pages<typeof loader> kept={kept} first={loaded} next={(page) => page.next_cursor}>
          {(page) =>
            page.type === "threads" && (
              <Results results={page.results} q={page.filters.q} now={page.now} />
            )
          }
        </Pages>
      </ul>
    </>
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

// Each with what matched when it wasn't the name, and the QQ number, which tells namesakes apart.
function People({ people, q }: { people: Person[]; q: string }) {
  return people.map((u) => (
    <li
      key={u.id}
      className="relative flex items-center gap-3 rounded-xl px-3 py-3 before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden transition-colors hover:bg-accent/60 sm:px-4"
    >
      <UserAvatar user={u} className="size-10 shrink-0" />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Link
            to={`/u/${u.id}`}
            className="min-w-0 truncate font-medium after:absolute after:inset-0"
          >
            <Marked text={u.display_name} q={q} />
          </Link>
          {/* A long name is cut short rather than these. */}
          <span className="flex shrink-0 items-center gap-1.5">
            <UserBadges user={u} />
            {u.frozen && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Snowflake className="size-3" /> 已冻结
              </span>
            )}
          </span>
        </div>
        <p className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          {u.match && (
            <span>
              {u.match.field === "card" ? "群名片" : "QQ 昵称"}「
              <Marked text={u.match.text} q={q} />」{u.match.group && `（${u.match.group}）`}
            </span>
          )}
          <span className="tabular-nums">
            QQ <Marked text={String(u.qq)} q={q} />
          </span>
          <span>帖子 {u.thread_count}</span>
          <span>回复 {u.post_count}</span>
        </p>
      </div>
    </li>
  ));
}

function Results({ results, q, now }: { results: Result[]; q: string; now: number }) {
  return results.map((r) => (
    <li
      key={r.thread.id}
      className="relative rounded-xl px-3 py-3.5 before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border/70 last:before:hidden transition-colors hover:bg-accent/60 sm:px-4"
    >
      <Link
        to={r.post.floor > 1 ? `/t/${r.thread.id}?floor=${r.post.floor}` : `/t/${r.thread.id}`}
        className="line-clamp-2 font-medium after:absolute after:inset-0"
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
