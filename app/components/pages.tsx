import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useFetcher, useLocation } from "react-router";
import { useNearView } from "~/near-view";

// A page of a list as the route's loader `L` gives it.
export type Loaded<L> = NonNullable<ReturnType<typeof useFetcher<L>>["data"]>;

// Back goes a few lists back at most; the pages of older entries are let go.
const KEPT = 10;

type Props<L> = {
  // The pages each entry of the history showed of this list, once it went past the first.
  kept: Map<string, Loaded<L>[]>;
  first: Loaded<L>;
  next: (page: Loaded<L>) => string | number | null;
  // A page's rows.
  children: (page: Loaded<L>) => ReactNode;
};

// The rows of a list whose next page loads when its link comes near the screen; without
// JavaScript the link opens it. Each entry of the history, as a filter makes, has its own pages,
// and Back shows them as they were: the router loads only the first page again, and
// <ScrollRestoration> can return to a place further down only if the pages above it are there.
// The first page comes back as it was too, as one changed meanwhile no longer leads on to the
// pages after it.
export function Pages<L>(props: Props<L>) {
  const { key } = useLocation();
  return <EntryPages<L> key={key} {...props} />;
}

function EntryPages<L>({ kept, first, next, children }: Props<L>) {
  const { key, pathname, search } = useLocation();
  const [restored] = useState(() => kept.get(key));
  const [more, setMore] = useState(() => restored?.slice(1) ?? []);
  const { load, state, data } = useFetcher<L>();
  const [added, setAdded] = useState(data);
  if (data !== added) {
    setAdded(data);
    if (data) setMore([...more, data]);
  }
  const top = restored?.[0] ?? first;
  useEffect(() => {
    if (more.length === 0) return;
    kept.set(key, [top, ...more]);
    for (const old of [...kept.keys()].slice(0, -KEPT)) kept.delete(old);
  }, [kept, key, top, more]);

  const link = useRef<HTMLAnchorElement>(null);
  const cursor = next(more.at(-1) ?? top);
  const params = new URLSearchParams(search);
  if (cursor !== null) params.set("cursor", String(cursor));
  const href = `${pathname}?${params}`;
  // The home page is an index route, which fetchers reach only with ?index.
  const url = pathname === "/" ? `/?index&${params}` : href;
  useNearView(link, cursor !== null && state === "idle", () => void load(url));

  return (
    <>
      {[top, ...more].map((page, i) => (
        <Fragment key={i}>{children(page)}</Fragment>
      ))}
      {cursor !== null && (
        <li className="py-4 text-center text-meta">
          <a ref={link} href={href} className="text-muted-foreground hover:text-foreground">
            {state === "loading" ? "加载中…" : "加载更多"}
          </a>
        </li>
      )}
    </>
  );
}
