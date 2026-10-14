import { Gift, PartyPopper } from "lucide-react";
import { useEffect } from "react";
import { Link, useFetcher } from "react-router";
import type { ThreadDetail } from "~/api-types";
import { PeoplePopover } from "~/components/people-popover";
import { Button } from "~/components/ui/button";
import { confirmDialog } from "~/components/ui/dialog";
import { toast } from "~/components/ui/toast";
import { UserAvatar } from "~/components/user-avatar";
import { stamp } from "~/time";
import { levelName } from "../../server/platform/site.ts";

type Lottery = NonNullable<ThreadDetail["lottery"]>;

type Sent = { ok: true; lottery: Lottery } | { ok: false; message: string };

// Under a lottery thread's opening post (design §8.13): its prizes, then who won them once the
// forum has drawn it, with what anyone needs to check the draw. `me` is null for guests; the
// finer checks (muted, frozen) are left to the server.
export function LotteryCard({
  lottery: loaded,
  threadId,
  me,
  canEnter,
  canCancel,
  now,
}: {
  lottery: Lottery;
  threadId: number;
  me: { id: number; level: number; staff: boolean } | null;
  canEnter: boolean;
  canCancel: boolean;
  now: number;
}) {
  const sending = useFetcher<Sent>();
  const lottery = sending.data?.ok ? sending.data.lottery : loaded;
  useEffect(() => {
    if (sending.state === "idle" && sending.data && !sending.data.ok) toast(sending.data.message);
  }, [sending.state, sending.data]);
  const busy = sending.state !== "idle";
  const submit = (intent: string) =>
    void sending.submit({ intent }, { method: "post", defaultShouldRevalidate: false });

  const drawn = lottery.drawn_at !== null;
  const open = !drawn && !lottery.cancelled && lottery.draws_at > now;
  const won = me && lottery.prizes.find((p) => p.won_by?.some((u) => u.id === me.id));
  const leveled = me !== null && (me.staff || me.level >= lottery.min_level);

  return (
    <section aria-label="抽奖" className="mt-4 rounded-2xl border bg-secondary/30 p-4">
      <p className="mb-3 flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
        <Gift className="size-4" />
        {lottery.entry === "reply" ? "回复参与" : "点按钮参与"}
        {lottery.min_level > 0 && <span>· {levelName(lottery.min_level)} 起</span>}
      </p>

      <ol className="flex flex-col gap-2.5">
        {lottery.prizes.map((p, i) => (
          // Prizes have nothing but their place to tell them apart.
          <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="min-w-0 font-medium break-words">{p.name}</span>
            {p.won_by === null || p.won_by.length === 0 ? (
              <span className="text-meta text-muted-foreground">
                {p.won_by === null ? `抽 ${p.winners} 人` : "无人中奖"}
              </span>
            ) : (
              p.won_by.map((u) => (
                <Link
                  key={u.id}
                  to={`/u/${u.id}`}
                  className="flex items-center gap-1.5 text-sm hover:underline"
                >
                  <UserAvatar user={u} className="size-5" />
                  {u.display_name}
                </Link>
              ))
            )}
          </li>
        ))}
      </ol>

      {won && (
        <p className="mt-3 flex items-center gap-1.5 text-sm font-medium text-primary">
          <PartyPopper className="size-4" /> 你中了「{won.name}」，楼主会联系你领奖
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-muted-foreground">
        {open && lottery.entry === "button" && canEnter && leveled && !lottery.entered && (
          <Button size="sm" disabled={busy} onClick={() => submit("enter-lottery")}>
            参与抽奖
          </Button>
        )}
        {open && lottery.entered && <span className="font-medium text-foreground">已参与</span>}
        {open && lottery.entry === "button" && lottery.entered && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => submit("leave-lottery")}>
            退出
          </Button>
        )}
        {open && lottery.entry === "reply" && !lottery.entered && <span>回复本帖即可参与</span>}
        {open && me && !leveled && <span>{levelName(lottery.min_level)} 起才能参与</span>}
        {me && lottery.entry_count > 0 ? (
          <PeoplePopover
            source={`/t/${threadId}/lottery`}
            label={`${lottery.entry_count} 人参与`}
            title={`${lottery.entry_count} 人参与，查看是谁`}
            align="left"
          />
        ) : (
          <span className="tabular-nums">{lottery.entry_count} 人参与</span>
        )}
        <span>
          {lottery.cancelled
            ? "抽奖已取消"
            : lottery.drawn_at !== null
              ? `${stamp(lottery.drawn_at, now)} 已开奖`
              : open
                ? `${stamp(lottery.draws_at, now)} 开奖`
                : "正在开奖，稍后刷新看结果"}
        </span>
        {canCancel && open && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              if (
                await confirmDialog(
                  "取消这个抽奖？取消后不再开奖，参与的人会收到通知。",
                  "取消抽奖",
                )
              )
                submit("cancel-lottery");
            }}
          >
            取消抽奖
          </Button>
        )}
      </div>

      <details className="mt-3 text-meta text-muted-foreground">
        <summary className="cursor-pointer select-none hover:text-foreground">怎么保证公平</summary>
        <div className="mt-2 flex flex-col gap-1.5">
          <p>
            论坛到点自动开奖，楼主和管理员都插不上手。开奖用的随机种子发帖时就定了，下面是它的
            SHA-256，开奖后公开种子本身，谁都能核对。
          </p>
          <p className="font-mono break-all">种子的 SHA-256：{lottery.seed_hash}</p>
          {lottery.seed && (
            <>
              <p className="font-mono break-all">种子：{lottery.seed}</p>
              <p>
                复核：先确认种子算出的 SHA-256 和上面一致；再对每位参与者算"种子:用户 ID"的
                SHA-256，从小到大排，依次抽满各个奖项。参与名单就是按这个顺序排的，用户 ID
                写在每个人后面。
              </p>
            </>
          )}
        </div>
      </details>
    </section>
  );
}
