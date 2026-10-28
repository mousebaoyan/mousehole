import { useState, type ReactNode } from "react";
import { data, Form, Link, useNavigation } from "react-router";
import { cn } from "~/cn";
import { Badge, Check, choice, Field, readForm, Result } from "~/components/form-parts";
import { ChevronDown, Copy, ExternalLink, HandHeart, Heart } from "~/components/icons";
import { LogoMark } from "~/components/logo";
import { ProgressBar } from "~/components/progress-bar";
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

// The sponsor page (design §8.21): what running the group costs, the codes to pay with and
// registering what was paid, one's own sponsorships, and the thanks wall.

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
          鼠群的网站、鼠洞论坛和{BOT_NAME}{" "}
          都免费向群友开放，维持运行需要一定费用。如果它们帮到了你，欢迎自愿赞助，每一笔赞助都会记在感谢墙上。
        </p>
      </header>
      <div className="overflow-hidden rounded-2xl border bg-card">
        <Costs year={year} />
        <Pay
          payee={payee}
          codes={codes}
          pending={pending}
          result={actionData?.intent === "register" ? actionData : undefined}
        />
      </div>
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

// A year's costs, estimated by share: the server runs other services too. 40 + 50 × 12 × 2 in fen,
// about ¥3.4 a day, which is what the tiers' days are reckoned by.
const COSTS = [
  ["域名 mousebaoyan.cn", "约 ¥40/年"],
  ["鼠洞论坛服务器", "约 ¥50/月"],
  [`${BOT_NAME} 的模型接口和电费`, "约 ¥50/月"],
  ["网站托管和直播", "免费"],
] as const;
const YEAR_COST = 124_000;

function Costs({ year }: Pick<Loaded, "year">) {
  return (
    <div className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="font-semibold">运行费用</h2>
        <span className="text-meta text-muted-foreground">服务器与其他服务共用，按分摊估算</span>
      </div>
      <dl className="mt-3 flex flex-col gap-1.5 text-sm">
        {COSTS.map(([item, cost]) => (
          <div key={item} className="flex items-baseline gap-2">
            <dt>{item}</dt>
            <span
              aria-hidden
              className="flex-1 border-b border-dotted border-muted-foreground/40"
            />
            <dd className="tabular-nums">{cost}</dd>
          </div>
        ))}
        <div className="mt-1 flex items-baseline justify-between gap-2 border-t pt-2.5 font-medium">
          <dt>合计</dt>
          <dd className="tabular-nums">
            约 ¥{yuan(YEAR_COST)}/年，每天约 ¥{(YEAR_COST / 36_500).toFixed(1)}
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-sm">
        {year.count > 0 ? (
          <>
            今年已收到 <span className="font-semibold tabular-nums">¥{yuan(year.amount)}</span>（
            {year.count} 笔）
          </>
        ) : (
          "今年暂未收到赞助"
        )}
      </p>
      <ProgressBar have={year.amount} need={YEAR_COST} className="mt-2 h-2" />
      <p className="mt-3 text-meta text-muted-foreground">赞助不换取鼠币、等级或任何特权。</p>
    </div>
  );
}

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
    return (
      <p className="border-t px-5 py-4 text-center text-sm text-muted-foreground">暂未开放赞助</p>
    );
  }
  return (
    // Folded so the thanks wall shows first; open once registered, to show how it went.
    <details open={result !== undefined} className="group border-t">
      <summary className="flex cursor-pointer list-none items-center gap-3 bg-brand/8 px-5 py-4 hover:bg-brand/12 [&::-webkit-details-marker]:hidden">
        <HandHeart className="size-5 shrink-0 text-brand-strong" />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">参与赞助</span>
          <span className="block text-meta text-muted-foreground">
            {pending ? "你有一笔赞助待收款人确认" : "选择金额，扫码付款，登记后列入感谢墙"}
          </span>
        </span>
        <ChevronDown
          aria-label="展开"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      {codes === null ? (
        <p className="border-t px-5 py-8 text-center text-sm text-muted-foreground">
          {me ? (
            "仅成员可以赞助"
          ) : (
            <>
              <Link to="/login" className="text-link hover:underline">
                登录
              </Link>
              后即可赞助
            </>
          )}
        </p>
      ) : (
        <Codes payee={payee} available={available} pending={pending} result={result} />
      )}
    </details>
  );
}

// The platforms' own colours, so each code is known at a glance.
const TINTS: Record<Method, string> = { wechat: "bg-[#09c668]", alipay: "bg-[#1677ff]" };

// How to pay with a code shown on the phone it is paid from.
const HOW: Record<Method, string> = {
  wechat:
    "在微信中打开本页时，长按收款码即可识别。在其他浏览器中，请长按保存图片，再用微信扫一扫从相册选取。电脑上请用手机扫码。",
  alipay:
    "在手机上可点击下方按钮打开支付宝，或长按保存图片，再用支付宝扫一扫从相册选取。电脑上请用手机扫码。",
};

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
    <Form method="post" className="border-t px-5">
      <input type="hidden" name="intent" value="register" />
      <input type="hidden" name="method" value={method} />
      <ol className="divide-y">
        <Step n={1} title="选择金额" hint="感谢墙上只显示档位，不显示金额">
          {/* Off while one waits: with no button, Enter in the amount, the only field, sends the form. */}
          <fieldset disabled={pending} className="min-w-0">
            <ul className="grid gap-2 sm:grid-cols-3">
              {TIERS.map((t) => (
                <li key={t.days}>
                  <button
                    type="button"
                    aria-pressed={amount === yuan(t.amount)}
                    onClick={() => setAmount(yuan(t.amount))}
                    className="flex w-full flex-col gap-1.5 rounded-xl border px-4 py-3 text-left hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-50 aria-pressed:border-brand aria-pressed:bg-brand/10 aria-pressed:ring-1 aria-pressed:ring-brand"
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{t.label}</span>
                      <span className="text-lg font-semibold tabular-nums">¥{yuan(t.amount)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-meta text-brand-strong">
                      <Pips days={t.days} />
                      {tierName(t.days)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <label className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium">付款金额</span>
              <span className="flex items-center gap-1.5">
                ¥
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
                  className="w-28"
                />
              </span>
              <span className="text-meta text-muted-foreground">
                也可以自填 ¥{yuan(MIN_AMOUNT)}–¥{yuan(MAX_AMOUNT)}
              </span>
            </label>
          </fieldset>
        </Step>

        <Step n={2} title="扫码付款">
          {available.length > 1 && (
            <fieldset className="mb-4 flex gap-1.5">
              <legend className="sr-only">付款方式</legend>
              {available.map((a) => (
                <button
                  key={a.method}
                  type="button"
                  aria-pressed={a.method === method}
                  onClick={() => setChosen(a.method)}
                  className="flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground aria-pressed:bg-secondary aria-pressed:font-medium aria-pressed:text-foreground"
                >
                  <span className={cn("size-2 rounded-full", TINTS[a.method])} />
                  {METHOD_NAMES[a.method]}
                </button>
              ))}
            </fieldset>
          )}
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            {/* The words sit on white: neither colour is dark enough behind them. */}
            <div className={cn("w-64 shrink-0 rounded-2xl p-2.5 shadow-sm", TINTS[method])}>
              <figure className="rounded-xl bg-white px-3 pt-2.5 pb-2.5 text-[#1f2a28]">
                <figcaption className="flex items-baseline justify-between">
                  <span className="font-semibold">赞助鼠群</span>
                  <span className="text-meta text-[#1f2a28]/70">{name}扫一扫</span>
                </figcaption>
                <img
                  src={codeImagePath(method, code)}
                  alt={`${name}收款码`}
                  width={216}
                  height={216}
                  className="mx-auto mt-1 size-54"
                />
                <p className="mt-1 flex items-center justify-center gap-1.5 text-meta">
                  <UserAvatar user={payee} className="size-5 text-2xs" />
                  <span className="min-w-0 break-words">收款人 {payee.display_name}</span>
                </p>
              </figure>
            </div>
            <div className="flex w-full min-w-0 flex-col gap-3 text-sm sm:flex-1">
              <p className="text-muted-foreground">{HOW[method]}</p>
              {method === "alipay" && (
                <a
                  href={`alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(code)}`}
                  className={buttonVariants({
                    variant: "outline",
                    size: "sm",
                    className: "self-start lg:hidden",
                  })}
                >
                  <ExternalLink /> 打开支付宝
                </a>
              )}
              {qq && (
                <div className="rounded-xl bg-secondary px-3.5 py-3">
                  <p className="font-medium">付款时请附上你的 QQ 号</p>
                  <p className="mt-0.5 text-meta text-muted-foreground">
                    {method === "wechat" ? "填写在付款页的 QQ 号一栏" : "填写在付款备注中"}
                    ，便于收款人核对
                  </p>
                  <p className="mt-1.5 flex items-center gap-1 font-semibold tabular-nums">
                    {qq}
                    <Button
                      type="button"
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
                  </p>
                </div>
              )}
            </div>
          </div>
        </Step>

        <Step n={3} title="登记赞助" hint="付款后在此登记，收款人核对到账后确认，结果会通知你">
          {pending ? (
            <p className="text-sm">你有一笔赞助待确认，确认后可再次登记。</p>
          ) : (
            <div className="flex flex-col gap-3">
              <Field label="留言" hint="选填，显示在感谢墙上">
                <Input name="message" maxLength={MAX_MESSAGE} />
              </Field>
              <Check name="anonymous" label="在感谢墙上匿名" checked={false} />
              <Button disabled={busy} className="self-start">
                <HandHeart /> 登记赞助
              </Button>
            </div>
          )}
          <div className="mt-2">
            <Result result={result} />
          </div>
        </Step>
      </ol>
    </Form>
  );
}

function Step({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 py-5">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="leading-6 font-medium">{title}</h3>
        {hint && <p className="text-meta text-muted-foreground">{hint}</p>}
        <div className="mt-3">{children}</div>
      </div>
    </li>
  );
}

// A tier as the days of a week it keeps the group running.
function Pips({ days }: { days: number | null }) {
  if (days === null) return <Heart aria-hidden className="size-3.5" />;
  return (
    <span aria-hidden className="flex gap-0.5">
      {Array.from({ length: 7 }, (_, i) => (
        <span
          key={i}
          className={cn("size-1.5 rounded-full", i < days ? "bg-brand" : "bg-brand/25")}
        />
      ))}
    </span>
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
      <p className="mt-1 text-meta text-muted-foreground">金额仅你本人、收款人和站长可见</p>
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
              <p className="text-meta text-muted-foreground">收款人的说明：{r.reason}</p>
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

// A note on the thanks wall warms up with the days it keeps the group running: below the lowest
// tier, then each tier in turn. No warmer than this, or the small grey words fall short of 4.5:1.
const NOTE_TONES = ["bg-secondary", "bg-brand/6", "bg-brand/12", "border-brand/40 bg-brand/18"];

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
    <div className="overflow-hidden rounded-2xl border bg-card">
      <div className="flex items-center gap-3 bg-brand/10 px-5 py-4">
        <LogoMark className="size-11 shrink-0" />
        <div>
          <h2 className="text-lg font-semibold">感谢墙</h2>
          <p className="text-meta text-muted-foreground">
            衷心感谢每一位赞助鼠群的群友，是你们让鼠群得以持续运行。
          </p>
        </div>
      </div>
      {items.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">暂无赞助记录</p>
      ) : (
        <ul className="columns-2 gap-3 px-4 pt-5 pb-2 sm:columns-3 sm:px-5">
          {items.map((t) => {
            const tier = TIERS.findIndex((x) => x.days === t.days);
            return (
              <li
                key={t.id}
                className={cn(
                  "mb-3 flex break-inside-avoid flex-col gap-2.5 rounded-xl border p-3.5 shadow-sm odd:-rotate-[0.6deg] even:rotate-[0.6deg]",
                  NOTE_TONES[tier + 1],
                )}
              >
                <p
                  title={tierName(t.days)}
                  className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-meta font-medium whitespace-nowrap text-brand-strong"
                >
                  {tier < 0 ? tierName(t.days) : TIERS[tier].label}
                  <Pips days={t.days} />
                </p>
                {t.message && <p className="text-sm leading-relaxed break-words">{t.message}</p>}
                <div className="flex items-center gap-2">
                  {t.user ? (
                    <UserAvatar user={t.user} className="size-7" />
                  ) : (
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-card">
                      <LogoMark className="size-5" />
                    </span>
                  )}
                  <div className="flex min-w-0 flex-col">
                    {t.user ? (
                      <Link
                        to={`/u/${t.user.id}`}
                        className="text-sm font-medium break-words hover:underline"
                      >
                        {t.user.display_name}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium">匿名鼠鼠</span>
                    )}
                    <span className="text-2xs text-muted-foreground">{date(t.paid_at, now)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {next && (
        <Link
          to={`?cursor=${next}`}
          className="block border-t py-3 text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更早的记录
        </Link>
      )}
    </div>
  );
}
