import { data, Form, Link, useNavigation, useSubmit } from "react-router";
import { cn } from "~/cn";
import { Badge, choice, Field, readForm, Result, Section, Time } from "~/components/form-parts";
import { Check, Trash2 } from "~/components/icons";
import { SettingsForm } from "~/components/settings-form";
import { Button } from "~/components/ui/button";
import { confirmSubmit, promptDialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { UserAvatar } from "~/components/user-avatar";
import { pageTitle } from "~/share-meta";
import { fromWallClock, unixNow, wallClock } from "~/time";
import { apiContext } from "../../api.server.ts";
import type { Route } from "./+types/sponsor.ts";
import {
  codeImagePath,
  MAX_AMOUNT,
  MAX_MESSAGE,
  METHOD_NAMES,
  METHODS,
  MIN_AMOUNT,
  STATUS_NAMES,
  STATUSES,
  yuan,
} from "../../../server/modules/sponsors/rules.ts";

// Sponsorships for the payee and the owner to see to, and for the owner who is paid and how
// (design §8.21).

export function meta() {
  return [{ title: pageTitle("赞助", "管理后台") }];
}

// ?status= picks the list, ?cursor= a later page of it.
export async function loader({ request, context }: Route.LoaderArgs) {
  const api = context.get(apiContext).admin;
  const search = new URL(request.url).searchParams;
  const status = STATUSES.find((s) => s === search.get("status")) ?? "pending";
  const [list, settings] = await Promise.all([
    api.sponsorships.$get({ query: { status, cursor: search.get("cursor") ?? undefined } }),
    api.settings.$get(),
  ]);
  if (!list.ok) throw data((await list.json()).error.message, { status: list.status });
  return {
    status,
    list: await list.json(),
    // The owner's only.
    settings: settings.ok ? (await settings.json()).sponsor : null,
    now: unixNow(),
  };
}

const METHOD_OPTIONS = METHODS.map((value) => ({ value, label: METHOD_NAMES[value] }));

const DONE: Record<string, string> = {
  settings: "已保存，立即生效",
  add: "已补录",
  confirm: "已确认",
  amount: "已修改金额",
  reject: "已标为未收到",
  message: "已保存留言",
  anonymous: "已修改",
  delete: "已删除",
};

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const api = context.get(apiContext).admin;
  const intent = field("intent");
  const param = { id: field("id") };
  const fen = () => Math.round(Number(field("amount")) * 100);
  const res =
    intent === "settings"
      ? await api.settings.$patch({
          json: {
            sponsor: {
              payee: field("payee") ? `qq:${field("payee")}` : null,
              wechat: field("wechat"),
              alipay: field("alipay"),
            },
          },
        })
      : intent === "add"
        ? await api.sponsorships.$post({
            json: {
              user: `qq:${field("qq")}`,
              method: choice(METHOD_OPTIONS, field("method")),
              amount: fen(),
              paid_at: fromWallClock(field("paid_at")),
              message: field("message") || null,
            },
          })
        : intent === "delete"
          ? await api.sponsorships[":id"].$delete({ param })
          : await api.sponsorships[":id"].$patch({
              param,
              json:
                intent === "confirm"
                  ? { status: "confirmed", amount: fen() }
                  : intent === "amount"
                    ? { amount: fen() }
                    : intent === "reject"
                      ? { status: "rejected", reason: field("reason") }
                      : intent === "anonymous"
                        ? { anonymous: field("anonymous") === "on" }
                        : { message: field("message") },
            });
  if (res.ok) return { intent, ok: true, message: DONE[intent] ?? "已保存" };
  return { intent, ok: false, message: (await res.json()).error.message };
}

type Loaded = Route.ComponentProps["loaderData"];
type Item = Loaded["list"]["items"][number];

export default function SponsorAdmin({ loaderData, actionData }: Route.ComponentProps) {
  const { status, list, settings, now } = loaderData;
  const saved = actionData?.intent === "settings";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">赞助</h1>
        <Result result={saved ? undefined : actionData} />
      </div>
      <p className="mt-1 text-meta text-muted-foreground">
        对照微信和支付宝的收款记录确认群友登记的赞助，实收金额不一致时先修改金额再确认。本人没选公开的金额不在感谢墙上单独显示，但计入赞助页上今年的合计。
      </p>
      <nav aria-label="状态" className="mt-4 flex gap-1">
        {STATUSES.map((s) => (
          <Link
            key={s}
            to={`?status=${s}`}
            aria-current={s === status ? "page" : undefined}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-sm text-muted-foreground hover:text-foreground",
              s === status && "bg-secondary font-medium text-foreground",
            )}
          >
            {STATUS_NAMES[s]}
          </Link>
        ))}
      </nav>
      {list.items.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {status === "pending" ? "暂无待确认的赞助" : "暂无记录"}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {list.items.map((r) => (
            <Row key={r.id} item={r} />
          ))}
        </ul>
      )}
      {list.next_cursor && (
        <Link
          to={`?status=${status}&cursor=${list.next_cursor}`}
          className="mt-3 block text-center text-meta text-muted-foreground hover:text-foreground"
        >
          更多记录
        </Link>
      )}
      <Add now={now} />
      {settings && <Settings settings={settings} result={saved ? actionData : undefined} />}
    </>
  );
}

const AMOUNT_INPUT = {
  name: "amount",
  type: "number",
  inputMode: "decimal",
  min: MIN_AMOUNT / 100,
  max: MAX_AMOUNT / 100,
  step: 0.01,
  required: true,
} as const;

function Row({ item: r }: { item: Item }) {
  const submit = useSubmit();
  const busy = useNavigation().state !== "idle";
  const confirmed = r.status === "confirmed";
  async function reject() {
    const reason = await promptDialog(
      confirmed
        ? "撤销确认后，这笔赞助从感谢墙上撤下。理由会通知对方，可不填。"
        : "理由会通知对方，可不填。",
      "理由",
      confirmed ? "撤销确认" : "未收到",
    );
    if (reason !== null) void submit({ intent: "reject", id: r.id, reason }, { method: "post" });
  }
  return (
    <li className="rounded-2xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <UserAvatar user={r.user} className="size-8" />
        <Link to={`/u/${r.user.id}`} className="font-medium hover:underline">
          {r.user.display_name}
        </Link>
        {r.user.qq !== null && (
          <span className="text-meta text-muted-foreground tabular-nums">QQ {r.user.qq}</span>
        )}
        {r.anonymous && <Badge>匿名上墙</Badge>}
        {r.show_amount && <Badge>公开金额</Badge>}
        <span className="ml-auto font-semibold tabular-nums">¥{yuan(r.amount)}</span>
        <span className="text-meta text-muted-foreground">{METHOD_NAMES[r.method]}</span>
      </div>
      <p className="mt-2 text-meta text-muted-foreground">
        登记于 <Time value={r.created_at} />
        {r.paid_at !== r.created_at && (
          <>
            ，付款于 <Time value={r.paid_at} />
          </>
        )}
        {r.reviewer && (
          <>
            ；{r.reviewer.display_name} {confirmed ? "确认" : "标为未收到"}于{" "}
            <Time value={r.reviewed_at} />
          </>
        )}
      </p>
      {/* Saved empty, the message is taken down. The boxes are keyed by what's saved, so a change
          from anywhere replaces what they hold; they are off while one is sent, or what is typed
          meanwhile would be replaced too. */}
      <Form method="post" className="mt-2 flex items-start gap-2">
        <input type="hidden" name="id" value={r.id} />
        <Textarea
          key={r.message ?? ""}
          name="message"
          aria-label="留言"
          placeholder="无留言"
          defaultValue={r.message ?? ""}
          maxLength={MAX_MESSAGE}
          disabled={busy}
          className="min-h-0 flex-1"
        />
        <Button name="intent" value="message" size="sm" variant="outline" disabled={busy}>
          保存留言
        </Button>
      </Form>
      {r.status === "rejected" && r.reason && (
        <p className="mt-2 text-meta text-muted-foreground">理由：{r.reason}</p>
      )}
      <Form method="post" className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={r.id} />
        <input type="hidden" name="anonymous" value={r.anonymous ? "" : "on"} />
        <span className="flex items-center gap-1.5 text-sm">
          实收 ¥
          <Input
            key={r.amount}
            {...AMOUNT_INPUT}
            aria-label="实收金额"
            defaultValue={yuan(r.amount)}
            disabled={busy}
            className="w-24"
          />
        </span>
        <Button name="intent" value={confirmed ? "amount" : "confirm"} size="sm" disabled={busy}>
          {confirmed ? (
            "修改金额"
          ) : (
            <>
              <Check /> 确认
            </>
          )}
        </Button>
        {r.status !== "rejected" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void reject()}
          >
            {confirmed ? "撤销确认" : "未收到"}
          </Button>
        )}
        <Button
          name="intent"
          value="anonymous"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={
            r.anonymous
              ? confirmSubmit("确定在感谢墙上显示 TA 的名字？请先确认是本人的意思。", "显示名字")
              : undefined
          }
        >
          {r.anonymous ? "显示名字" : "改为匿名"}
        </Button>
        <Button
          name="intent"
          value="delete"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={confirmSubmit(
            "确定删除这条记录？仅用于删除记错的记录，删除后无法恢复。",
            "删除",
          )}
        >
          <Trash2 /> 删除
        </Button>
      </Form>
    </li>
  );
}

function Add({ now }: { now: number }) {
  const busy = useNavigation().state !== "idle";
  return (
    <Section
      title="补录"
      description="付款后没有登记的，或论坛上线前赞助过的，在这里补录。补录的记录直接确认，默认匿名、不公开金额，本人会收到通知，可以自己修改。"
    >
      <Form method="post" className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="intent" value="add" />
        <Field label="QQ 号">
          <Input name="qq" inputMode="numeric" pattern="\d+" required />
        </Field>
        <Field label="付款方式">
          <Select name="method" options={METHOD_OPTIONS} />
        </Field>
        <Field label="金额（元）">
          <Input {...AMOUNT_INPUT} />
        </Field>
        <Field label="付款时间">
          <Input name="paid_at" type="datetime-local" required defaultValue={wallClock(now)} />
        </Field>
        <Field label="留言">
          <Input name="message" maxLength={MAX_MESSAGE} />
        </Field>
        <Button className="self-end justify-self-start" disabled={busy}>
          补录
        </Button>
      </Form>
    </Section>
  );
}

function Settings({
  settings,
  result,
}: {
  settings: NonNullable<Loaded["settings"]>;
  result: { ok: boolean; message: string } | undefined;
}) {
  const codes = METHODS.filter((m) => settings[m] !== "");
  return (
    <SettingsForm result={result}>
      <input type="hidden" name="intent" value="settings" />
      <Section title="收款设置" description="仅站长可见">
        <div className="flex flex-col gap-4">
          <Field
            label="收款人的 QQ 号"
            hint="只能是管理员。有人登记赞助时通知收款人，收款人和站长都可以确认。留空则不开放赞助"
          >
            <Input
              name="payee"
              inputMode="numeric"
              pattern="\d*"
              defaultValue={settings.payee?.qq ?? ""}
            />
          </Field>
          {settings.payee && (
            <p className="-mt-2 flex items-center gap-2 text-sm">
              <UserAvatar user={settings.payee} className="size-6 text-2xs" />
              {settings.payee.display_name}
            </p>
          )}
          <Field label="微信收款码" hint="收款码图片识别出的文字，以 wxp:// 开头。留空则不提供微信">
            <Input name="wechat" defaultValue={settings.wechat} />
          </Field>
          <Field
            label="支付宝收款码"
            hint="收款码图片识别出的文字，以 https://qr.alipay.com/ 开头。留空则不提供支付宝"
          >
            <Input name="alipay" defaultValue={settings.alipay} />
          </Field>
          {codes.length > 0 && (
            <div>
              <p className="text-sm font-medium">预览</p>
              <p className="mt-1 text-meta text-muted-foreground">
                赞助页显示的收款码，请用手机扫码确认能打开付款页
              </p>
              <div className="mt-3 flex flex-wrap gap-4">
                {codes.map((m) => (
                  <figure key={m} className="flex flex-col items-center gap-1.5 text-meta">
                    <img
                      src={codeImagePath(m, settings[m])}
                      alt={`${METHOD_NAMES[m]}收款码`}
                      width={160}
                      height={160}
                      className="size-40 rounded-lg border"
                    />
                    <figcaption>{METHOD_NAMES[m]}</figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
        </div>
      </Section>
    </SettingsForm>
  );
}
