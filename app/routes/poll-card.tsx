import { ChartBar, Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import { cn } from "cn";
import type { ThreadDetail, UserBrief } from "~/api-types";
import { useDismiss } from "~/components/disclosure";
import { Button } from "~/components/ui/button";
import { Checkbox, Radio } from "~/components/ui/checkbox";
import { confirmDialog } from "~/components/ui/dialog";
import { toast } from "~/components/ui/toast";
import { UserAvatar } from "~/components/user-avatar";
import { stamp } from "~/time";

type Poll = NonNullable<ThreadDetail["poll"]>;

type Sent = { ok: true; poll: Poll } | { ok: false; message: string };

// Under a poll thread's opening post (design §8.11). The counts show once the reader has voted
// or the poll is over, unless its author shows them all along; until then it is a form.
// `canVote` and `canClose` leave the finer checks (muted, frozen) to the server.
export function PollCard({
  poll: loaded,
  threadId,
  canVote,
  canClose,
  now,
}: {
  poll: Poll;
  threadId: number;
  canVote: boolean;
  canClose: boolean;
  now: number;
}) {
  const sending = useFetcher<Sent>();
  const poll = sending.data?.ok ? sending.data.poll : loaded;
  const mine = poll.my_votes ?? [];
  const [chosen, setChosen] = useState(mine);
  // Changing a vote lasts until the server answers again.
  const [changingAt, setChangingAt] = useState<{ answer: Sent | undefined } | null>(null);
  const changing = changingAt !== null && changingAt.answer === sending.data;
  useEffect(() => {
    if (sending.state === "idle" && sending.data && !sending.data.ok) toast(sending.data.message);
  }, [sending.state, sending.data]);

  const picking = canVote && !poll.closed && (mine.length === 0 || changing);
  const busy = sending.state !== "idle";
  const over = poll.max_choices !== null && chosen.length > poll.max_choices;
  const submit = (intent: string, options: number[] = []) => {
    const form = new FormData();
    form.set("intent", intent);
    for (const o of options) form.append("options", String(o));
    void sending.submit(form, { method: "post", defaultShouldRevalidate: false });
  };

  return (
    <section aria-label="投票" className="mt-4 rounded-2xl border bg-secondary/30 p-4">
      <p className="mb-3 flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
        <ChartBar className="size-4" />
        {poll.multiple
          ? poll.max_choices === null
            ? "多选"
            : `多选，最多 ${poll.max_choices} 项`
          : "单选"}
        {poll.anonymous && <span>· 匿名投票</span>}
      </p>

      {picking ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="sr-only">选项</legend>
          {poll.options.map((o) => {
            const Input = poll.multiple ? Checkbox : Radio;
            return (
              <label
                key={o.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent"
              >
                <Input
                  name="options"
                  checked={chosen.includes(o.id)}
                  onChange={(e) =>
                    setChosen(
                      !poll.multiple
                        ? [o.id]
                        : e.target.checked
                          ? [...chosen, o.id]
                          : chosen.filter((c) => c !== o.id),
                    )
                  }
                />
                <span className="min-w-0 flex-1 break-words">{o.label}</span>
                {o.votes !== null && (
                  <span className="text-meta text-muted-foreground tabular-nums">{o.votes} 票</span>
                )}
              </label>
            );
          })}
        </fieldset>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {poll.options.map((o) => (
            <Result
              key={o.id}
              option={o}
              total={poll.voter_count}
              mine={mine.includes(o.id)}
              voters={poll.anonymous ? null : `/t/${threadId}/poll/${o.id}`}
            />
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-muted-foreground">
        {picking && (
          <Button
            size="sm"
            disabled={busy || chosen.length === 0 || over}
            onClick={() => submit("vote", chosen)}
          >
            {changing ? "改票" : "投票"}
          </Button>
        )}
        {changing && (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => submit("vote")}>
              撤票
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setChosen(mine);
                setChangingAt(null);
              }}
            >
              取消
            </Button>
          </>
        )}
        {over && <span className="text-destructive">最多选 {poll.max_choices} 项</span>}
        <span className="tabular-nums">{poll.voter_count} 人投票</span>
        <span>
          {poll.closed
            ? "已结束"
            : poll.closes_at === null
              ? "不限时间"
              : `${stamp(poll.closes_at, now)} 截止`}
        </span>
        {!picking && poll.options[0]?.votes === null && <span>投票后看结果</span>}
        {canVote && !poll.closed && mine.length > 0 && !changing && (
          <Button size="sm" variant="ghost" onClick={() => setChangingAt({ answer: sending.data })}>
            改票
          </Button>
        )}
        {canClose && !poll.closed && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              if (await confirmDialog("现在结束投票？结束后不能再投。", "结束"))
                submit("close-poll");
            }}
          >
            结束投票
          </Button>
        )}
      </div>
    </section>
  );
}

// An option's share of the voters, as a bar; in a poll that isn't anonymous its count opens the
// list of who chose it.
function Result({
  option,
  total,
  mine,
  voters,
}: {
  option: Poll["options"][number];
  total: number;
  mine: boolean;
  voters: string | null;
}) {
  const percent =
    option.votes === null || total === 0 ? 0 : Math.round((option.votes / total) * 100);
  return (
    <li>
      <div className="flex items-baseline gap-2 text-sm">
        <span className={cn("min-w-0 flex-1 break-words", mine && "font-medium")}>
          {option.label}
          {mine && (
            <Check aria-label="我投的" className="ml-1 -mt-0.5 inline size-4 text-primary" />
          )}
        </span>
        {option.votes !== null && (
          <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
            {percent}% ·{" "}
            {voters && option.votes > 0 ? (
              <Voters source={voters} count={option.votes} />
            ) : (
              `${option.votes} 票`
            )}
          </span>
        )}
      </div>
      {option.votes !== null && (
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            className={cn("h-full rounded-full", mine ? "bg-primary" : "bg-muted-foreground/40")}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </li>
  );
}

function Voters({ source, count }: { source: string; count: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const list = useFetcher<{ items: UserBrief[] }>();
  useDismiss(open, () => setOpen(false), root);
  return (
    <span ref={root} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${count} 票，查看是谁`}
        onClick={() => {
          if (!open && list.state === "idle") void list.load(source);
          setOpen(!open);
        }}
        className="underline-offset-2 hover:text-foreground hover:underline"
      >
        {count} 票
      </button>
      {open && (
        <ul className="absolute top-full right-0 z-30 mt-2 max-h-72 w-[min(16rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-popover py-1 text-sm text-popover-foreground shadow-lg animate-in fade-in zoom-in-95">
          {!list.data && <li className="px-3 py-2 text-muted-foreground">加载中…</li>}
          {list.data?.items.map((u) => (
            <li key={u.id}>
              <Link to={`/u/${u.id}`} className="flex items-center gap-3 px-3 py-2 hover:bg-accent">
                <UserAvatar user={u} className="size-7" />
                <span className="min-w-0 truncate font-medium">{u.display_name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
