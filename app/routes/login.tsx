import { Link2, LoaderCircle, Mail, MessageSquareCode } from "lucide-react";
import { Logo } from "~/components/logo";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";

export function meta() {
  return [{ title: "登录 · 鼠洞" }];
}

export default function Login() {
  return (
    <main className="flex min-h-svh flex-col items-center bg-secondary/50 px-4 pt-[12vh] pb-10">
      <Logo />
      <div className="mt-8 w-full max-w-sm rounded-2xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">登录鼠洞</h1>
        <p className="mt-1 text-sm text-muted-foreground">用你在群里的 QQ 号登录，不用注册</p>
        <Tabs defaultValue="code" className="mt-5">
          <TabsList className="w-full">
            <TabsTrigger value="code">
              <MessageSquareCode /> 口令
            </TabsTrigger>
            <TabsTrigger value="email">
              <Mail /> QQ 邮箱
            </TabsTrigger>
            <TabsTrigger value="link">
              <Link2 /> 链接
            </TabsTrigger>
          </TabsList>

          <TabsContent value="code" className="pt-4">
            <p className="text-sm text-muted-foreground">私聊群里的机器人发送：</p>
            <div className="mt-2 rounded-xl bg-secondary py-4 text-center">
              <span className="text-sm text-muted-foreground">登录 </span>
              <span className="font-mono text-3xl font-semibold tracking-[0.2em]">482913</span>
            </div>
            <div className="mt-3 flex items-center justify-between text-[13px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle className="size-3.5 animate-spin" /> 等待机器人确认
              </span>
              <span className="tabular-nums">4:32 后失效</span>
            </div>
          </TabsContent>

          <TabsContent value="email" className="flex flex-col gap-3 pt-4">
            <div className="flex gap-2">
              <Input inputMode="numeric" placeholder="QQ 号" />
              <Button variant="outline" className="shrink-0">
                发送验证码
              </Button>
            </div>
            <Input inputMode="numeric" placeholder="6 位验证码" maxLength={6} />
            <Button className="w-full">登录</Button>
            <p className="text-[13px] text-muted-foreground">
              验证码发到 QQ号@qq.com，10 分钟内有效。机器人不在线时也能用。
            </p>
          </TabsContent>

          <TabsContent value="link" className="pt-4 text-sm leading-relaxed text-muted-foreground">
            <p>
              私聊机器人发送<span className="mx-1 font-medium text-foreground">登录链接</span>
              ，它会回复一个一次性链接，在手机 QQ 里点开就能登录。
            </p>
            <p className="mt-2">链接 10 分钟内有效，只能用一次，不要转发给别人。</p>
          </TabsContent>
        </Tabs>
      </div>
      <p className="mt-6 text-[13px] text-muted-foreground">
        还没进群？
        <a href="https://mousebaoyan.cn/join" className="text-link hover:underline">
          看看怎么加入鼠群
        </a>
      </p>
    </main>
  );
}
