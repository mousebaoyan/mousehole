import { AppWindow, Copy, Download, KeyRound, LogOut, Monitor } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { useEffect, useRef, useState } from "react";
import { redirect, useFetcher, useRevalidator } from "react-router";
import { apiContext } from "../api.server.ts";
import { browserApi } from "~/browser-api";
import { Check, Field, readForm, Section, Time } from "~/components/form-parts";
import { SettingsForm } from "~/components/settings-form";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "~/components/ui/toast";
import { confirmSubmit } from "~/components/ui/dialog";
import { UserAvatar } from "~/components/user-avatar";
import { useMe } from "~/forum";
import type { Route } from "./+types/settings.ts";
import { Checkbox } from "~/components/ui/checkbox";
import {
  NOTIFICATION_LABELS,
  NOTIFICATION_TYPES,
  SITE_ONLY,
} from "../../server/modules/notifications/types.ts";
import { BOT_NAME, STAFF, TIER_NAMES } from "../../server/platform/site.ts";
import { AGENT_POSTING_LEVEL } from "../../server/platform/access.ts";
import { BuyButton, buyLook, Customize, DEFAULT_STATUS_EMOJI } from "./settings-customize.tsx";
import { endOfDay, unixNow } from "~/time";
import { useHydrated } from "~/hydrated";
import {
  BACKGROUNDS,
  FRAMES,
  MOVING_AVATAR_PRICE,
  THEMES,
  type Look,
} from "../../server/modules/users/customization.ts";

export function meta() {
  return [{ title: pageTitle("设置") }];
}

// The page's sections, for the navigation beside them.
const SECTIONS = {
  profile: { id: "profile", title: "资料" },
  customize: { id: "customize", title: "个性化" },
  privacy: { id: "privacy", title: "隐私" },
  proxy: { id: "proxy", title: "群聊收录" },
  notify: { id: "notify", title: "通知" },
  devices: { id: "devices", title: "登录设备" },
  agent: { id: "agent", title: "Agent" },
  export: { id: "export", title: "导出" },
};

export async function loader({ context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const [settings, sessions, tokens, me] = await Promise.all([
    api.me.settings.$get(),
    api.me.sessions.$get(),
    api.me.tokens.$get(),
    api.me.$get(),
  ]);
  if (!settings.ok || !sessions.ok || !tokens.ok || !me.ok) return redirect("/login");
  // Their card as others see it, which the 个性化 preview dresses.
  const card = await api.users[":user"].$get({ param: { user: String((await me.json()).id) } });
  if (!card.ok) throw new Error("Card failed");
  const profile = await card.json();
  return {
    settings: await settings.json(),
    sessions: (await sessions.json()).items,
    tokens: (await tokens.json()).items,
    profile: profile.members_only ? null : profile,
    now: unixNow(),
  };
}

// Saving the form, signing a device out, or making or revoking a token.
export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const field = await readForm(request);
  if (field("intent") === "sign-out") {
    await api.me.sessions[":id"].$delete({ param: { id: field("id") } });
    return null;
  }
  if (field("intent") === "create-token") {
    const res = await api.me.tokens.$post({
      json: { name: field("name"), scopes: field("act") === "on" ? ["read", "act"] : ["read"] },
    });
    if (res.ok) return { ok: true, message: "已生成", ...(await res.json()) };
    return { ok: false, message: (await res.json()).error.message };
  }
  if (field("intent") === "revoke-token") {
    await api.me.tokens[":id"].$delete({ param: { id: field("id") } });
    return null;
  }
  if (field("intent") === "qq-avatar") {
    const res = await api.me.avatar.$delete();
    if (res.ok) return { ok: true, message: "头像已改回 QQ 头像" };
    return { ok: false, message: (await res.json()).error.message };
  }
  const on = (name: string) => field(name) === "on";
  // Only the switches changed here are sent: the rest keep following the owner's defaults.
  const shown = await api.me.settings.$get();
  if (!shown.ok) throw new Error("Settings failed");
  const { notify_prefs } = await shown.json();
  const res = await api.me.$patch({
    json: {
      custom_name: field("custom_name") || null,
      custom_bio: field("custom_bio") || null,
      allow_proxy: on("allow_proxy"),
      hide_from_guests: on("hide_from_guests"),
      relations_public: on("relations_public"),
      title_badge_id: field("title_badge_id") ? Number(field("title_badge_id")) : null,
      shown_badge_ids: field("shown_badges") === "auto" ? null : ids(field("shown_badges")),
      theme: THEMES.find((t) => t === field("theme")) ?? null,
      frame: FRAMES.find((f) => f === field("frame")) ?? null,
      background_opacity: Number(field("background_opacity")),
      // Their own picture is already saved, by the upload.
      ...(field("background") !== "custom" && {
        background: BACKGROUNDS.find((key) => key === field("background")) ?? null,
      }),
      user_status: field("status_text")
        ? {
            emoji: field("status_emoji") || DEFAULT_STATUS_EMOJI,
            text: field("status_text"),
            until: clearsAt(field("status_until"), field("status_was")),
          }
        : null,
      pins: ids(field("pins")),
      showcase: field("showcase") || null,
      notify_email: on("notify_email"),
      weekly_email: on("weekly_email"),
      notify_prefs: Object.fromEntries(
        NOTIFICATION_TYPES.map((type) => {
          const was = notify_prefs[type];
          const site = on(`${type}.site`);
          const email = on(`${type}.email`);
          return [
            type,
            {
              ...(site !== was.site && { site }),
              ...(was.email !== null && email !== was.email && { email }),
            },
          ];
        }),
      ),
    },
  });
  if (res.ok) return { ok: true, message: "已保存" };
  return { ok: false, message: (await res.json()).error.message };
}

// When a status clears by itself: the time it had, or one counted from now.
function clearsAt(choice: string, was: string) {
  const now = unixNow();
  if (choice === "keep") return Number(was);
  if (choice === "today") return endOfDay(now);
  if (choice === "3d") return now + 3 * 86_400;
  if (choice === "7d") return now + 7 * 86_400;
  return null;
}

// What a picker of several sent: the IDs in order.
function ids(value: string) {
  return value === "" ? [] : value.split(",").map(Number);
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, sessions, tokens, profile, now } = loaderData;
  const me = useMe();
  return (
    <div className="flex gap-8">
      <div className="max-w-2xl min-w-0 flex-1">
        <h1 className="px-1 text-xl font-semibold">设置</h1>
        <nav aria-label="设置的分类" className="mt-3 flex gap-1 overflow-x-auto xl:hidden">
          {Object.values(SECTIONS).map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="shrink-0 rounded-full border px-3 py-1 text-meta text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {s.title}
            </a>
          ))}
        </nav>
        <SettingsForm result={actionData ?? undefined}>
          <Section {...SECTIONS.profile}>
            <div className="flex flex-col gap-4">
              <AvatarField
                custom={settings.avatar_custom}
                moving={settings.owned.avatar}
                coins={settings.coins}
              />
              <Field label="名字" hint="不填时使用 QQ 群名片">
                <Input
                  name="custom_name"
                  defaultValue={settings.custom_name ?? ""}
                  maxLength={24}
                />
              </Field>
              <Field label="个性签名" hint="不填时使用 QQ 个性签名">
                <Textarea
                  name="custom_bio"
                  defaultValue={settings.custom_bio ?? ""}
                  placeholder={settings.qq_bio}
                  maxLength={60}
                  className="min-h-16"
                />
              </Field>
              <Field
                label="头衔"
                hint={
                  settings.title_badges.length > 0
                    ? "显示在名字旁边，可以用自己的金徽章或银徽章"
                    : "获得金徽章或银徽章后，可以把它设为头衔"
                }
              >
                <Select
                  name="title_badge_id"
                  aria-label="头衔"
                  defaultValue={String(settings.title_badge_id ?? "")}
                  options={[
                    { value: "", label: "使用 QQ 专属头衔" },
                    ...settings.title_badges.map((b) => ({
                      value: String(b.id),
                      label: `${b.name}（${TIER_NAMES[b.tier]}）`,
                    })),
                  ]}
                />
              </Field>
            </div>
          </Section>

          <Section {...SECTIONS.customize} description="装扮你的资料卡和个人主页，匿名发言时不显示">
            <Customize settings={settings} profile={profile} me={me} now={now} />
          </Section>

          <Section {...SECTIONS.privacy}>
            <Check
              name="hide_from_guests"
              label="我的内容仅成员可见"
              hint="未登录的访客和搜索引擎将看不到你发布的帖子、回复和短评（包括以前发布的），你的主页只显示名字和头像"
              checked={settings.hide_from_guests}
            />
            <Check
              name="relations_public"
              label="公开我的点赞和关注列表"
              hint="其他成员能在你的主页看到你赞过的内容、你关注和认可的人以及你的粉丝。关闭后只显示数量，你也不会出现在他人的这些名单中"
              checked={settings.relations_public}
            />
          </Section>

          <Section {...SECTIONS.proxy}>
            <Check
              name="allow_proxy"
              label="允许把我在群里的提问和回答整理到论坛"
              hint={`由${BOT_NAME} 整理成帖子和回复，署你的名字，你可以随时编辑或删除`}
              checked={settings.allow_proxy}
            />
          </Section>

          <Section {...SECTIONS.notify} description="邮件会发到你的 QQ 邮箱">
            <Check
              name="notify_email"
              label="接收邮件提醒"
              hint="关闭后不再收到任何通知邮件"
              checked={settings.notify_email}
            />
            <Check
              name="weekly_email"
              label="每周来信"
              hint="每周一汇总你上周的分享被阅读和获赞的次数"
              checked={settings.weekly_email}
            />
            <table className="mt-3 w-full text-sm">
              <thead className="text-meta text-muted-foreground">
                <tr>
                  <th className="pb-2 text-left font-normal">类型</th>
                  <th className="w-16 pb-2 font-normal">站内</th>
                  <th className="w-16 pb-2 font-normal">邮件</th>
                </tr>
              </thead>
              <tbody>
                {NOTIFICATION_TYPES.map((type) => (
                  <tr key={type} className="border-t">
                    <td className="py-2">{NOTIFICATION_LABELS[type]}</td>
                    {(["site", "email"] as const).map((where) => {
                      const checked = settings.notify_prefs[type][where];
                      const none = SITE_ONLY.has(type)
                        ? "这类通知只在站内显示"
                        : "站长关闭了这类邮件";
                      return (
                        <td key={where}>
                          {checked === null ? (
                            <span
                              title={none}
                              className="flex h-10 items-center justify-center text-muted-foreground"
                            >
                              —
                              <span className="sr-only">
                                {NOTIFICATION_LABELS[type]}：{none}
                              </span>
                            </span>
                          ) : (
                            /* The whole cell takes the tap, not just the 16px box. */
                            <label className="flex h-10 cursor-pointer items-center justify-center">
                              <Checkbox name={`${type}.${where}`} defaultChecked={checked} />
                              <span className="sr-only">
                                {NOTIFICATION_LABELS[type]}：{where === "site" ? "站内" : "邮件"}
                              </span>
                            </label>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </SettingsForm>

        <Section {...SECTIONS.devices} description="不再使用的设备可以在这里下线">
          <ul className="divide-y">
            {sessions.map((s) => (
              <Device key={s.id} session={s} />
            ))}
          </ul>
        </Section>

        <Section
          {...SECTIONS.agent}
          description="让你的 Agent 和自己写的脚本以你的身份使用鼠洞。令牌 90 天未使用会失效"
        >
          <AgentTokens tokens={tokens} />
        </Section>

        <Section
          {...SECTIONS.export}
          description="导出你的帖子、回复、短评和收藏，帖子和回复保留 Markdown 原文。每小时最多导出 3 次"
        >
          <a href="/api/v1/me/export" download className={buttonVariants({ variant: "outline" })}>
            <Download /> 下载我的内容
          </a>
        </Section>
      </div>
      <aside className="hidden w-44 shrink-0 xl:block">
        <SectionNav />
      </aside>
    </div>
  );
}

// Section headings at or above this line of the viewport count as reached (header plus some air).
const REACHED_LINE = 120;

function SectionNav() {
  const sections = Object.values(SECTIONS);
  const [current, setCurrent] = useState<string>(SECTIONS.profile.id);
  useEffect(() => {
    function update() {
      const { scrollHeight } = document.documentElement;
      // The last sections are short and may never reach the line before the page ends.
      if (innerHeight + scrollY >= scrollHeight - 1) {
        setCurrent(SECTIONS.export.id);
        return;
      }
      const reached = Object.values(SECTIONS).filter((s) => {
        const heading = document.getElementById(s.id);
        return heading !== null && heading.getBoundingClientRect().top <= REACHED_LINE;
      });
      setCurrent((reached.at(-1) ?? SECTIONS.profile).id);
    }
    update();
    addEventListener("scroll", update, { passive: true });
    return () => removeEventListener("scroll", update);
  }, []);
  return (
    <nav aria-label="设置的分类" className="sticky top-20 flex flex-col gap-0.5 text-sm">
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={s.id === current ? "location" : undefined}
          className="rounded-md px-3 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground aria-[current]:bg-accent aria-[current]:font-medium aria-[current]:text-foreground"
        >
          {s.title}
        </a>
      ))}
    </nav>
  );
}

type Session = Route.ComponentProps["loaderData"]["sessions"][number];

function Device({ session: s }: { session: Session }) {
  const signOut = useFetcher();
  return (
    <li className="flex items-center gap-3 py-3 text-sm">
      <Monitor className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {s.device}
          {s.current && <span className="ml-2 text-meta text-success">当前设备</span>}
        </p>
        <p className="text-meta text-muted-foreground">
          最近使用 <Time value={s.last_seen_at} />
          {s.ip && ` · ${s.ip}`}
        </p>
      </div>
      {!s.current && (
        <signOut.Form method="post">
          <input type="hidden" name="intent" value="sign-out" />
          <input type="hidden" name="id" value={s.id} />
          <Button variant="ghost" size="sm" disabled={signOut.state !== "idle"}>
            <LogOut /> 下线
          </Button>
        </signOut.Form>
      )}
    </li>
  );
}

type Token = Route.ComponentProps["loaderData"]["tokens"][number];

const SCOPE_LABELS: Record<string, string> = { profile: "资料", read: "读取", act: "发帖和互动" };

// Their tokens and the apps they let in (design §6.7), and a form for a new token. A new one is
// shown once, as the forum keeps only its hash, and not after it was revoked. Before the page's
// script runs the forms would post as plain forms, whose result this section doesn't read.
function AgentTokens({ tokens }: { tokens: Token[] }) {
  const me = useMe();
  const create = useFetcher<typeof action>();
  const form = useRef<HTMLFormElement>(null);
  const hydrated = useHydrated();
  const made = create.data && "token" in create.data ? create.data : null;
  const created = made && tokens.some((t) => t.id === made.id) ? made.token : null;
  useEffect(() => {
    if (create.data?.ok === false) toast(create.data.message);
    if (create.data?.ok) form.current?.reset();
  }, [create.data]);
  if (!me) return null;
  const mayCreate = me.member_status === "member" && me.role !== "owner";
  const belowLevel = me.level < AGENT_POSTING_LEVEL && !STAFF.includes(me.role);
  return (
    <>
      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无令牌</p>
      ) : (
        <ul className="-mt-3 divide-y">
          {tokens.map((t) => (
            <TokenItem key={t.id} token={t} />
          ))}
        </ul>
      )}
      {created && <NewToken token={created} />}
      {mayCreate ? (
        <create.Form method="post" ref={form} className="mt-4 flex flex-col gap-3 border-t pt-4">
          <Field label="新令牌的名称" hint="用来区分不同的 Agent 和脚本">
            <Input name="name" required maxLength={24} placeholder="例如：Codex" />
          </Field>
          <Check
            name="act"
            label="允许发帖、回复和互动"
            hint={
              belowLevel
                ? `通过 Agent 发内容需要 L${AGENT_POSTING_LEVEL}，你目前是 L${me.level}`
                : "不勾选时只能读取你能看到的内容"
            }
            checked={false}
          />
          <Button
            type="submit"
            name="intent"
            value="create-token"
            className="self-start"
            disabled={!hydrated || create.state !== "idle"}
          >
            生成令牌
          </Button>
        </create.Form>
      ) : (
        <p className="mt-4 border-t pt-4 text-meta text-muted-foreground">
          {me.role === "owner" ? "站长账号不能生成令牌" : "账号已冻结，重新进群后才能生成令牌"}
        </p>
      )}
    </>
  );
}

function TokenItem({ token: t }: { token: Token }) {
  const revoke = useFetcher();
  const hydrated = useHydrated();
  // Apps by the name they have now, which they may have changed since.
  const name = t.app?.name ?? t.name;
  const Icon = t.app ? AppWindow : KeyRound;
  return (
    <li className="flex items-center gap-3 py-3 text-sm">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate">{name}</p>
        <p className="text-meta text-muted-foreground">
          {t.app ? (t.app.first_party ? "用鼠洞账号登录" : "授权的 Agent") : "个人令牌"} ·{" "}
          {t.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join("、")} ·{" "}
          {t.last_used_at === null ? (
            "未使用"
          ) : (
            <>
              最近使用 <Time value={t.last_used_at} />
            </>
          )}
        </p>
      </div>
      <revoke.Form method="post">
        <input type="hidden" name="intent" value="revoke-token" />
        <input type="hidden" name="id" value={t.id} />
        <Button
          variant="ghost"
          size="sm"
          disabled={!hydrated || revoke.state !== "idle"}
          onClick={confirmSubmit(
            t.app?.first_party
              ? `撤销对「${name}」的授权？你将在「${name}」退出登录。`
              : t.app
                ? `撤销对「${name}」的授权？它将立即无法以你的身份访问鼠洞。`
                : `撤销令牌「${name}」？使用它的 Agent 和脚本将立即无法访问鼠洞。`,
            "撤销",
          )}
        >
          撤销
        </Button>
      </revoke.Form>
    </li>
  );
}

function NewToken({ token }: { token: string }) {
  return (
    <output className="mt-4 block rounded-xl border border-success/40 bg-success/5 p-3 text-sm">
      <p className="font-medium text-success">令牌只显示这一次，请立即复制到 Agent 的配置中</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-lg bg-card px-3 py-2 font-mono break-all select-all">
          {token}
        </code>
        <Button
          variant="outline"
          size="sm"
          // QQ's built-in browser can refuse the clipboard.
          onClick={() =>
            void navigator.clipboard.writeText(token).then(
              () => toast("令牌已复制"),
              () => toast("复制失败，请手动选中复制"),
            )
          }
        >
          <Copy /> 复制
        </Button>
      </div>
    </output>
  );
}

// The picture goes straight to /api/v1, like images in posts; the page then loads again, and the
// header shows the new avatar too. Animated ones keep moving once bought (design §8.16).
function AvatarField({
  custom,
  moving,
  coins,
}: {
  custom: boolean;
  moving: boolean;
  coins: number;
}) {
  const me = useMe();
  const { revalidate } = useRevalidator();
  const [uploading, setUploading] = useState(false);
  // Not a submit of the settings form, which would count its unsaved changes as saved.
  const revert = useFetcher<typeof action>();
  useEffect(() => {
    if (revert.data) toast(revert.data.message);
  }, [revert.data]);
  if (!me) return null;

  async function upload(file: File) {
    setUploading(true);
    const res = await browserApi.me.avatar.$put({ form: { file } });
    if (res.ok) await revalidate();
    else toast((await res.json()).error.message);
    setUploading(false);
  }

  async function buy(look: Look, price: number, what: string) {
    if (!(await buyLook(look, price, what))) return;
    toast("兑换成功，现在可以上传动图");
    await revalidate();
  }

  return (
    <div className="flex items-center gap-4">
      <UserAvatar user={me} className="size-16 shrink-0 text-lg" />
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <label
            className={buttonVariants({
              variant: "outline",
              size: "sm",
              className: "cursor-pointer has-disabled:pointer-events-none has-disabled:opacity-50",
            })}
          >
            {uploading ? "上传中…" : "上传头像"}
            <input
              type="file"
              accept="image/*"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void upload(file);
              }}
              className="sr-only"
            />
          </label>
          {!moving && (
            <BuyButton
              look={{ kind: "avatar", key: "custom" }}
              what="动态头像"
              price={MOVING_AVATAR_PRICE}
              coins={coins}
              locked={false}
              onBuy={buy}
            >
              兑换动图
            </BuyButton>
          )}
          {custom && (
            <Button
              variant="ghost"
              size="sm"
              disabled={revert.state !== "idle"}
              onClick={() => void revert.submit({ intent: "qq-avatar" }, { method: "post" })}
            >
              改回 QQ 头像
            </Button>
          )}
        </div>
        <span className="text-meta text-muted-foreground">
          {moving ? "支持动图" : "动图仅显示第一帧"}
        </span>
      </div>
    </div>
  );
}
