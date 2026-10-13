import { data } from "react-router";
import { PenSquare } from "lucide-react";
import { Link } from "react-router";
import { ThreadFeed } from "~/components/thread-feed";
import { buttonVariants } from "~/components/ui/button";
import { boards, threads } from "~/draft-data";
import type { Route } from "./+types/board.ts";

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData.board.name} · 鼠洞` }];
}

export function loader({ request, params }: Route.LoaderArgs) {
  const board = boards.find((b) => b.slug === params.slug);
  if (!board) throw data("版块不存在", { status: 404 });
  const sort = new URL(request.url).searchParams.get("sort") ?? "latest";
  return { board, sort, threads: threads.filter((t) => t.board === board.slug) };
}

export default function Board({ loaderData }: Route.ComponentProps) {
  const { board, sort } = loaderData;
  return (
    <>
      <header className="mb-5 flex items-start gap-4 px-1">
        <span
          className="mt-1.5 size-3 shrink-0 rounded-full"
          style={{ backgroundColor: board.color }}
        />
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{board.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {board.description} · {board.threads.toLocaleString()} 个主题
          </p>
        </div>
        <Link to="/new" className={buttonVariants({ variant: "outline", size: "sm" })}>
          <PenSquare /> 发帖
        </Link>
      </header>
      <ThreadFeed threads={loaderData.threads} sort={sort} showBoard={false} />
    </>
  );
}
