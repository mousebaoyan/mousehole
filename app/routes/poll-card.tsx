import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { cn } from "cn";
import { ChartBar, Check } from "~/components/icons";
import type { ThreadDetail } from "~/api-types";
import { PeoplePopover } from "~/components/people-popover";
import { Button } from "~/components/ui/button";
import { Checkbox, Radio } from "~/components/ui/checkbox";
import { confirmDialog } from "~/components/ui/dialog";
import { toast } from "~/components/ui/toast";
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
        {poll.rows
          ? "每行选一项，可以只选其中几行"
          : poll.multiple
            ? poll.max_choices === null
              ? "多选"
              : `多选，最多 ${poll.max_choices} 项`
            : "单选"}
        {poll.anonymous && <span>· 匿名投票</span>}
      </p>

      {poll.rows ? (
        <Rows
          poll={poll}
          rows={poll.rows}
          picking={picking}
          chosen={chosen}
          setChosen={setChosen}
          mine={mine}
        />
      ) : picking ? (
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
        {!picking && poll.options[0]?.votes === null && <span>投票后可查看结果</span>}
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
              if (await confirmDialog("确定现在结束投票？结束后无法再投票。", "结束"))
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

// The grades are in order, as the 保研定位 ones run from easy to near impossible (design §8.14):
// the hue turns from green to red, lightness and chroma kept so no grade stands out.
function grade(position: number, count: number) {
  const t = count > 1 ? position / (count - 1) : 0;
  return `oklch(0.66 0.15 ${145 - t * 120})`;
}

// A poll of rows (design §8.11): each row its own set of the same options, one choice a row.
// While voting, a row's options are buttons to press and press again to take back; after, a row
// is a bar in the grades' colors.
function Rows({
  poll,
  rows,
  picking,
  chosen,
  setChosen,
  mine,
}: {
  poll: Poll;
  rows: string[];
  picking: boolean;
  chosen: number[];
  setChosen: (chosen: number[]) => void;
  mine: number[];
}) {
  const grades = poll.options.filter((o) => o.row === 0).map((o) => o.label);
  return (
    <>
      {!picking && (
        <p className="mb-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {grades.map((label, i) => (
            <span key={label} className="inline-flex items-center gap-1">
              <span
                className="size-2.5 rounded-sm"
                style={{ background: grade(i, grades.length) }}
              />
              {label}
            </span>
          ))}
        </p>
      )}
      <ul className="flex flex-col gap-3">
        {rows.map((label, row) => {
          const options = poll.options.filter((o) => o.row === row);
          const total = options.reduce((sum, o) => sum + (o.votes ?? 0), 0);
          const voted = options.find((o) => mine.includes(o.id));
          return (
            <li key={label} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="basis-full text-sm font-medium break-words sm:basis-36">
                {label}
              </span>
              {picking ? (
                <span className="flex min-w-0 flex-1 gap-1">
                  {options.map((o) => {
                    const on = chosen.includes(o.id);
                    const others = chosen.filter((c) => !options.some((x) => x.id === c));
                    return (
                      <button
                        key={o.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setChosen(on ? others : [...others, o.id])}
                        className={cn(
                          "flex-auto rounded-lg border px-1.5 py-1 text-meta whitespace-nowrap sm:text-sm",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "bg-background hover:bg-accent",
                        )}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </span>
              ) : (
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="flex h-2.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full bg-secondary">
                      {options.map(
                        (o, i) =>
                          (o.votes ?? 0) > 0 && (
                            <span
                              key={o.id}
                              title={`${o.label} ${o.votes} 票`}
                              style={{
                                width: `${((o.votes ?? 0) / total) * 100}%`,
                                background: grade(i, options.length),
                              }}
                            />
                          ),
                      )}
                    </span>
                    {options[0]?.votes !== null && (
                      <span className="shrink-0 text-meta text-muted-foreground tabular-nums">
                        {total} 票
                      </span>
                    )}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-x-2.5 text-xs text-muted-foreground tabular-nums">
                    {options.map(
                      (o) =>
                        (o.votes ?? 0) > 0 && (
                          <span key={o.id}>
                            {o.label} {o.votes}
                          </span>
                        ),
                    )}
                    {voted && <span className="text-primary">我：{voted.label}</span>}
                  </span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
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
              <PeoplePopover
                source={voters}
                label={`${option.votes} 票`}
                title={`${option.votes} 票，查看名单`}
              />
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
