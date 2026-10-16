import { Download, LogOut, Monitor } from "~/components/icons";
import { pageTitle } from "~/share-meta";
import { useEffect, useState } from "react";
import { redirect, useFetcher, useRevalidator } from "react-router";
import { apiContext } from "../api.server.ts";
import { browserApi } from "~/browser-api";
import { Check, Field, readForm, Section, Time } from "~/components/form-parts";
import { SettingsForm } from "~/components/settings-form";
import { Button, buttonVariants } from "~/components/ui/button";
import { TIER_NAMES } from "~/components/badge-chip";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { toast } from "~/components/ui/toast";
import { UserAvatar } from "~/components/user-avatar";
import { useMe } from "~/forum";
import type { Route } from "./+types/settings.ts";
import { Checkbox } from "~/components/ui/checkbox";
import {
  NOTIFICATION_LABELS,
  NOTIFICATION_TYPES,
} from "../../server/modules/notifications/types.ts";
import { BOT_NAME } from "../../server/platform/site.ts";
import {
  BackgroundField,
  DEFAULT_STATUS_EMOJI,
  FrameField,
  PinsField,
  ShowcaseField,
  ShownBadgesField,
  StatusField,
  ThemeField,
} from "./settings-customize.tsx";
import { endOfDay, unixNow } from "~/time";
import { BACKGROUNDS, FRAMES, THEMES } from "../../server/modules/users/customization.ts";

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
  export: { id: "export", title: "导出" },
};

export async function loader({ context }: Route.LoaderArgs) {
  const api = context.get(apiContext);
  const [settings, sessions] = await Promise.all([api.me.settings.$get(), api.me.sessions.$get()]);
  if (!settings.ok || !sessions.ok) return redirect("/login");
  return {
    settings: await settings.json(),
    sessions: (await sessions.json()).items,
    now: unixNow(),
  };
}

// Saving the form, or signing a device out.
export async function action({ request, context }: Route.ActionArgs) {
  const api = context.get(apiContext);
  const field = await readForm(request);
  if (field("intent") === "sign-out") {
    await api.me.sessions[":id"].$delete({ param: { id: field("id") } });
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
  const { settings, sessions, now } = loaderData;
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
              <AvatarField custom={settings.avatar_custom} />
              <Field label="名字" hint="最多 24 个字；留空则使用 QQ 群名片">
                <Input
                  name="custom_name"
                  defaultValue={settings.custom_name ?? ""}
                  placeholder="使用 QQ 群名片"
                  maxLength={24}
                />
              </Field>
              <Field
                label="个性签名"
                hint="最多 60 个字，显示在资料卡和个人主页上；留空则使用 QQ 个性签名"
              >
                <Textarea
                  name="custom_bio"
                  defaultValue={settings.custom_bio ?? ""}
                  placeholder={settings.qq_bio || "使用 QQ 个性签名"}
                  maxLength={60}
                  className="min-h-16"
                />
              </Field>
              <Field
                label="头衔"
                hint={
                  settings.title_badges.length > 0
                    ? "显示在名字旁边；可以选一枚自己的金徽章或银徽章"
                    : "得到金徽章或银徽章后，可以选它作为头衔"
                }
              >
                <Select
                  name="title_badge_id"
                  aria-label="头衔"
                  defaultValue={String(settings.title_badge_id ?? "")}
                  options={[
                    { value: "", label: "跟随 QQ 专属头衔" },
                    ...settings.title_badges.map((b) => ({
                      value: String(b.id),
                      label: `${b.name}（${TIER_NAMES[b.tier]}）`,
                    })),
                  ]}
                />
              </Field>
            </div>
          </Section>

          <Section
            {...SECTIONS.customize}
            description="资料卡和个人主页上的样子；匿名发布的内容不显示这些"
          >
            <div className="flex flex-col gap-5">
              <StatusField status={settings.user_status} now={now} />
              <BackgroundField
                key={`${settings.background}:${settings.background_urls?.card_url}`}
                background={settings.background}
                urls={settings.background_urls}
                unlocked={settings.unlocked}
              />
              {me && (
                <FrameField frame={settings.frame} unlocked={settings.unlocked.frames} me={me} />
              )}
              <ThemeField theme={settings.theme} />
              <ShownBadgesField badges={settings.badges} shown={settings.shown_badge_ids} />
              {me && <PinsField pins={settings.pins} userId={me.id} />}
              <ShowcaseField showcase={settings.showcase} />
            </div>
          </Section>

          <Section {...SECTIONS.privacy}>
            <Check
              name="hide_from_guests"
              label="我的内容不给访客看"
              hint="未登录的访客和搜索引擎看不到我发布的帖子、回复和短评（包括以前发布的），我的主页只显示名字和头像。约半分钟后生效"
              checked={settings.hide_from_guests}
            />
            <Check
              name="relations_public"
              label="公开我的赞和关系"
              hint="其他成员可以在我的主页查看我赞过的楼层、我关注和认可的人以及我的粉丝，我也会出现在他人主页的这些名单中。关闭后仍显示数量"
              checked={settings.relations_public}
            />
          </Section>

          <Section {...SECTIONS.proxy}>
            <Check
              name="allow_proxy"
              label="允许把我在群里的提问和回答整理到论坛"
              hint={`由${BOT_NAME} 整理，内容记在我名下，我可以编辑和删除。关闭后不再收录我在群里的发言`}
              checked={settings.allow_proxy}
            />
          </Section>

          <Section
            {...SECTIONS.notify}
            description="站内通知显示在顶栏的铃铛中，邮件发送到我的 QQ 邮箱。未修改过的开关使用站点的默认设置，并随站点默认设置变化"
          >
            <Check
              name="notify_email"
              label="接收邮件提醒"
              hint="关闭后所有通知都不发送邮件，下方各类的设置保留不变"
              checked={settings.notify_email}
            />
            <Check
              name="weekly_email"
              label="每周来信"
              hint="每周一告诉我上周我的分享被读了多少次、获得了多少赞；上周收获较少时不发"
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
                      return (
                        <td key={where}>
                          {checked === null ? (
                            <span
                              title="站长关闭了这类邮件"
                              className="flex h-10 items-center justify-center text-muted-foreground"
                            >
                              —
                              <span className="sr-only">
                                {NOTIFICATION_LABELS[type]}：站长关闭了这类邮件
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
          {...SECTIONS.export}
          description="下载我发布的帖子和回复（Markdown 原文）、短评和收藏，格式为 JSON；每小时最多 3 次"
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

// The picture goes straight to /api/v1, like images in posts; the page then loads again, and the
// header shows the new avatar too.
function AvatarField({ custom }: { custom: boolean }) {
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

  return (
    <div className="flex items-center gap-4">
      <UserAvatar user={me} className="size-16 text-lg" />
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
    </div>
  );
}
