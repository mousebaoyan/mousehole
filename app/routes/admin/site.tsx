import { Form, useNavigation } from "react-router";
import { apiContext } from "../../api.server.ts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import type { Route } from "./+types/site.ts";
import { Check, Field, readForm, Result, Section } from "~/components/form-parts";

export function meta() {
  return [{ title: "站点 · 管理后台" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const res = await context.get(apiContext).admin.settings.$get();
  if (!res.ok) throw new Error("Admin settings failed");
  const { site, login, bot } = await res.json();
  return { site, login, bot };
}

export async function action({ request, context }: Route.ActionArgs) {
  const field = await readForm(request);
  const on = (name: string) => field(name) === "on";
  const res = await context.get(apiContext).admin.settings.$patch({
    json: {
      site: {
        banner: field("banner"),
        qq_public: on("qq_public"),
        review_mode: field("review_mode") === "before" ? "before" : "after",
      },
      login: {
        code: on("code"),
        link: on("link"),
        email: on("email"),
        code_hint: field("code_hint"),
      },
      bot: { require_operator: on("require_operator") },
    },
  });
  if (res.ok) return { ok: true, message: "已保存，立即生效" };
  return { ok: false, message: (await res.json()).error.message };
}

export default function Site({
  loaderData: { site, login, bot },
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  return (
    <Form method="post">
      <h1 className="text-xl font-semibold">站点</h1>

      <Section title="通用">
        <div className="flex flex-col gap-4">
          <Field label="公告横幅" hint="显示在每个论坛页面的顶部，最多 200 个字；留空不显示">
            <Input name="banner" defaultValue={site.banner} maxLength={200} />
          </Field>
          <Field label="新版块的审核方式" hint="新建版块时默认选这个，建好后每个版块可以单独改">
            <NativeSelect name="review_mode" defaultValue={site.review_mode}>
              <option value="after">先发后审</option>
              <option value="before">先审后发</option>
            </NativeSelect>
          </Field>
          <Check
            name="qq_public"
            label="访客也能看到 QQ 号"
            hint="默认只有群成员和 bot 能看到；打开后个人资料里的 QQ 号对所有人公开"
            checked={site.qq_public}
          />
        </div>
      </Section>

      <Section title="登录方式" description="关掉的方式不在登录页显示，对应接口也会拒绝">
        <Check name="code" label="口令登录" hint="私聊 bot 发送网页上的口令" checked={login.code} />
        <Check
          name="link"
          label="链接登录"
          hint="bot 私聊发送一次性登录链接"
          checked={login.link}
        />
        <Check
          name="email"
          label="QQ 邮箱验证码"
          hint="需要先在「邮件」里配置 SMTP，否则不会显示"
          checked={login.email}
        />
        <div className="mt-3">
          <Field label="口令提示" hint="显示在口令上方，{code} 会换成口令">
            <Input name="code_hint" defaultValue={login.code_hint} maxLength={100} />
          </Field>
        </div>
      </Section>

      <Section title="bot">
        <Check
          name="require_operator"
          label="代表成员操作时必须带 X-Operator"
          hint="开启后，bot 以群友身份操作的请求都要指明是谁让它做的；成员同步等 bot 自己的操作不受影响"
          checked={bot.require_operator}
        />
      </Section>

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          保存
        </Button>
        <Result result={actionData} />
      </div>
    </Form>
  );
}
