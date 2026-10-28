import { useState, type ReactNode } from "react";
import { data, Form, Link, useNavigation } from "react-router";
import { cn } from "~/cn";
import { Badge, Check, choice, Field, readForm, Result } from "~/components/form-parts";
import { Copy, ExternalLink, HandHeart } from "~/components/icons";
import { LogoMark } from "~/components/logo";
import { Button, buttonVariants } from "~/components/ui/button";
import { confirmSubmit } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { toast } from "~/components/ui/toast";
import { UserAvatar } from "~/components/user-avatar";
import { useMe } from "~/forum";
import { pageTitle } from "~/share-meta";
import { date, unixNow } from "~/time";
import { apiContext } from "../api.server.ts";
import type { Route } from "./+types/sponsor.ts";
import {
  codeImagePath,
  MAX_AMOUNT,
  MAX_MESSAGE,
  METHOD_NAMES,
  METHODS,
  MIN_AMOUNT,
  STATUS_NAMES,
  TIERS,
  tierName,
  yuan,
  type Method,
} from "../../server/modules/sponsors/rules.ts";
import { BOT_NAME } from "../../server/platform/site.ts";

// The sponsor page (design §8.21): the codes to pay with and registering what was paid, one's own
// sponsorships, and the thanks wall.

export function meta() {
  return [{ title: pageTitle("赞助鼠群") }];
}

// ?cursor= an older page of the thanks wall.
export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;
  const [sponsor, wall, mine] = await Promise.all([
    api.sponsor.$get(),
    api.sponsorships.$get({ query: { cursor } }),
    api.me.sponsorships.$get(),
  ]);
  if (!wall.ok) throw data((await wall.json()).error.message, { status: wall.status });
  return {
    ...(await sponsor.json()),
    wall: await wall.json(),
    // Signed in only.
    mine: mine.ok ? (await mine.json()).items : null,
    now: unixNow(),
  };
}

const DONE: Record<string, string> = {
  register: "已登记，收款人确认后会通知你",
  withdraw: "已撤回",
  anonymous: "已修改",
  message: "已删除留言",
};

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext).sponsorships;
  const intent = field("intent");
  const param = { id: field("id") };
  const res =
    intent === "register"
      ? await api.$post({
          json: {
            method: choice(
              METHODS.map((value) => ({ value })),
              field("method"),
            ),
            amount: Math.round(Number(field("amount")) * 100),
            message: field("message") || null,
            anonymous: field("anonymous") === "on",
          },
        })
      : intent === "withdraw"
        ? await api[":id"].$delete({ param })
        : await api[":id"].$patch({
            param,
            json:
              intent === "anonymous"
                ? { anonymous: field("anonymous") === "on" }
                : { message: null },
          });
  if (res.ok) return { intent, ok: true, message: DONE[intent] ?? "已保存" };
  return { intent, ok: false, message: (await res.json()).error.message };
}

type Loaded = Route.ComponentProps["loaderData"];

export default function Sponsor({ loaderData, actionData }: Route.ComponentProps) {
  const { payee, codes, year, wall, mine, now } = loaderData;
  const pending = mine?.some((r) => r.status === "pending") ?? false;
  return (
    <section className="flex flex-col gap-4">
      <header className="px-1">
        <h1 className="text-xl font-semibold">赞助鼠群</h1>
        <p className="mt-1 text-meta text-muted-foreground">
          服务器、域名和{BOT_NAME}
          用到的模型都需要费用，群友可以自愿赞助。赞助不换取鼠币、等级或任何特权；还在准备保研的同学，请先把钱留给自己。
        </p>
        {year.count > 0 && (
          <p className="mt-2 text-sm">
            今年已收到 <span className="font-semibold tabular-nums">{year.count}</span> 笔赞助，共{" "}
            <span className="font-semibold tabular-nums">¥{yuan(year.amount)}</span>，谢谢大家。
          </p>
        )}
      </header>
      <Pay
        payee={payee}
        codes={codes}
        pending={pending}
        result={actionData?.intent === "register" ? actionData : undefined}
      />
      {mine && mine.length > 0 && (
        <Mine
          items={mine}
          now={now}
          result={actionData?.intent === "register" ? undefined : actionData}
        />
      )}
      <Wall items={wall.items} next={wall.next_cursor} now={now} />
    </section>
  );
}

type Answer = { ok: boolean; message: string } | undefined;

// How to pay with a code shown on the phone it is paid from.
const HOW: Record<Method, string> = {
  wechat:
    "在微信里打开本页时，长按图片即可识别；在其他浏览器里，请长按保存图片，再从微信扫一扫的相册里选取。电脑上请直接用手机扫码。",
  alipay:
    "手机上可以点下方的按钮打开支付宝，或者长按保存图片，再从支付宝扫一扫的相册里选取。电脑上请直接用手机扫码。",
};

function Pay({
  payee,
  codes,
  pending,
  result,
}: Pick<Loaded, "payee" | "codes"> & { pending: boolean; result: Answer }) {
  const me = useMe();
  const available = METHODS.flatMap((method) => {
    const code = codes?.[method];
    return code ? [{ method, code }] : [];
  });
  if (payee === null || (codes !== null && available.length === 0)) {
    return <Notice>暂未开放赞助</Notice>;
  }
  if (codes === null) {
    return me ? (
      <Notice>仅成员可以赞助</Notice>
    ) : (
      <Notice>
        <Link to="/login" className="text-link hover:underline">
          登录
        </Link>
        后赞助
      </Notice>
    );
  }
  return <Codes payee={payee} available={available} pending={pending} result={result} />;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-2xl border bg-card px-5 py-10 text-sm text-muted-foreground">
      <HandHeart className="size-5" />
      <span>{children}</span>
    </div>
  );
}

function Codes({
  payee,
  available,
  pending,
  result,
}: {
  payee: NonNullable<Loaded["payee"]>;
  available: { method: Method; code: string }[];
  pending: boolean;
  result: Answer;
}) {
  const qq = useMe()?.qq;
  const busy = useNavigation().state !== "idle";
  // The method only: the codes come fresh with each load, and the chosen one may be gone.
  const [chosen, setChosen] = useState(available[0].method);
  const [amount, setAmount] = useState("");
  const { method, code } = available.find((a) => a.method === chosen) ?? available[0];
  const name = METHOD_NAMES[method];
  return (
    <div className="rounded-2xl border bg-card p-5">
      <h2 className="font-semibold">选择档位</h2>
      <p className="mt-1 text-meta text-muted-foreground">
        也可以自选金额，感谢墙上显示档位，不显示金额
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-3">
        {TIERS.map((t) => (
          <li key={t.days}>
            <button
              type="button"
              aria-pressed={amount === yuan(t.amount)}
              onClick={() => setAmount(yuan(t.amount))}
              className="flex w-full items-baseline justify-between gap-2 rounded-xl border px-4 py-2.5 text-left hover:bg-accent/60 aria-pressed:border-primary aria-pressed:bg-primary/5 sm:flex-col sm:items-center sm:text-center"
            >
              <span className="text-lg font-semibold tabular-nums">¥{yuan(t.amount)}</span>
              <span className="text-meta text-muted-foreground">{tierName(t.days)}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex flex-col items-center gap-3 border-t pt-5">
        {available.length > 1 && (
          <fieldset className="flex gap-1">
            <legend className="sr-only">付款方式</legend>
            {available.map((a) => (
              <button
                key={a.method}
                type="button"
                aria-pressed={a.method === method}
                onClick={() => setChosen(a.method)}
                className="rounded-full px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground aria-pressed:bg-secondary aria-pressed:font-medium aria-pressed:text-foreground"
              >
                {METHOD_NAMES[a.method]}
              </button>
            ))}
          </fieldset>
        )}
        <figure className="w-full max-w-xs overflow-hidden rounded-2xl border bg-white text-[#1f2a28] shadow-sm">
          <figcaption className="flex items-center gap-2 bg-primary px-4 py-2.5 text-primary-foreground">
            <LogoMark className="size-8" />
            <span className="font-semibold">赞助鼠群</span>
            <span className="ml-auto text-meta">{name}扫码</span>
          </figcaption>
          <img
            src={codeImagePath(method, code)}
            alt={`${name}收款码`}
            width={240}
            height={240}
            className="mx-auto mt-3 size-60"
          />
          <p className="flex items-center justify-center gap-2 px-4 pt-1 pb-4 text-meta">
            <UserAvatar user={payee} className="size-5 text-2xs" />
            收款人 {payee.display_name}
          </p>
        </figure>
        <p className="max-w-sm text-center text-meta text-muted-foreground">{HOW[method]}</p>
        {method === "alipay" && (
          <a
            href={`alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(code)}`}
            className={buttonVariants({ variant: "outline", size: "sm", className: "lg:hidden" })}
          >
            <ExternalLink /> 打开支付宝
          </a>
        )}
        {qq && (
          <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-sm">
            付款时请附上你的 QQ 号
            <span className="inline-flex items-center rounded-md bg-secondary pl-2 font-medium tabular-nums">
              {qq}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="复制 QQ 号"
                // QQ's built-in browser can refuse the clipboard.
                onClick={() =>
                  void navigator.clipboard.writeText(String(qq)).then(
                    () => toast("QQ 号已复制"),
                    () => toast("复制失败，请手动输入"),
                  )
                }
              >
                <Copy />
              </Button>
            </span>
            <span className="text-meta text-muted-foreground">
              {method === "wechat" ? "填在付款页的 QQ 号一栏" : "写在付款的备注里"}
            </span>
          </p>
        )}
      </div>

      <div className="mt-5 border-t pt-5">
        <h2 className="font-semibold">付款后登记</h2>
        {pending ? (
          <p className="mt-1 text-meta text-muted-foreground">
            你有一笔待确认的赞助，收款人确认后才能再登记。
          </p>
        ) : (
          <Form method="post" className="mt-3 flex flex-col gap-3">
            <input type="hidden" name="intent" value="register" />
            <input type="hidden" name="method" value={method} />
            <div className="grid gap-3 sm:grid-cols-[9rem_1fr]">
              <Field label={`${name}付款金额（元）`}>
                <Input
                  name="amount"
                  type="number"
                  inputMode="decimal"
                  min={MIN_AMOUNT / 100}
                  max={MAX_AMOUNT / 100}
                  step={0.01}
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label="留言" hint="选填，显示在感谢墙上">
                <Input name="message" maxLength={MAX_MESSAGE} />
              </Field>
            </div>
            <Check name="anonymous" label="在感谢墙上匿名" checked={false} />
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={busy}>
                <HandHeart /> 我付好了
              </Button>
              <span className="text-meta text-muted-foreground">
                收款人核对到账后确认，确认后会通知你
              </span>
            </div>
          </Form>
        )}
        <div className="mt-2">
          <Result result={result} />
        </div>
      </div>
    </div>
  );
}

const STATUS_TONES: Record<string, string> = {
  pending: "bg-warning/10 text-warning",
  confirmed: "bg-success/10 text-success",
  rejected: "bg-secondary text-muted-foreground",
};

function Mine({
  items,
  now,
  result,
}: {
  items: NonNullable<Loaded["mine"]>;
  now: number;
  result: Answer;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <div className="rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="font-semibold">我的赞助</h2>
        <Result result={result} />
      </div>
      <p className="mt-1 text-meta text-muted-foreground">金额仅自己和收款人可见</p>
      <ul className="mt-2 divide-y">
        {items.map((r) => (
          <li key={r.id} className="flex flex-col gap-1.5 py-3">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-semibold tabular-nums">¥{yuan(r.amount)}</span>
              <span className="text-meta text-muted-foreground">
                {METHOD_NAMES[r.method]} · {date(r.paid_at, now)}
              </span>
              <span
                className={cn("rounded px-1.5 py-px text-2xs font-medium", STATUS_TONES[r.status])}
              >
                {STATUS_NAMES[r.status]}
              </span>
              {r.anonymous && <Badge>匿名</Badge>}
            </p>
            {r.message && <p className="text-sm break-words">{r.message}</p>}
            {r.status === "rejected" && r.reason && (
              <p className="text-meta text-muted-foreground">收款人：{r.reason}</p>
            )}
            <Form method="post" className="flex flex-wrap gap-1.5">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="anonymous" value={r.anonymous ? "" : "on"} />
              <Button name="intent" value="anonymous" size="xs" variant="outline" disabled={busy}>
                {r.anonymous ? "显示我的名字" : "改为匿名"}
              </Button>
              {r.message && (
                <Button
                  name="intent"
                  value="message"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={confirmSubmit("确定删除这条留言？删除后无法恢复。", "删除")}
                >
                  删除留言
                </Button>
              )}
              {r.status === "pending" && (
                <Button
                  name="intent"
                  value="withdraw"
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={confirmSubmit("确定撤回这笔赞助的登记？", "撤回")}
                >
                  撤回
                </Button>
              )}
            </Form>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Wall({
  items,
  next,
  now,
}: {
  items: Loaded["wall"]["items"];
  next: string | null;
  now: number;
}) {
  return (
    <div className="rounded-2xl border bg-card p-5">
      <h2 className="font-semibold">感谢墙</h2>
      <p className="mt-1 text-meta text-muted-foreground">谢谢每一位赞助鼠群的群友</p>
      {items.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">暂无记录</p>
      ) : (
        <ul className="mt-2 divide-y">
          {items.map((t) => (
            <li key={t.id} className="flex gap-3 py-3">
              {t.user ? (
                <UserAvatar user={t.user} className="size-9" />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary">
                  <LogoMark className="size-7" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 text-sm">
                  {t.user ? (
                    <Link to={`/u/${t.user.id}`} className="font-medium hover:underline">
                      {t.user.display_name}
                    </Link>
                  ) : (
                    <span className="font-medium">匿名鼠鼠</span>
                  )}
                  <span className="text-meta text-brand-strong">{tierName(t.days)}</span>
                </p>
                {t.message && <p className="mt-0.5 text-sm break-words">{t.message}</p>}
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">{date(t.paid_at, now)}</span>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <Link
          to={`?cursor=${next}`}
          className="mt-2 block text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更早的记录
        </Link>
      )}
    </div>
  );
}
