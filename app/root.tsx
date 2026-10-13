import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root.ts";
import "./app.css";

// Runs before first paint so the page never flashes the wrong theme. Same key as the main site.
const themeScript = `try{document.documentElement.dataset.theme=localStorage.getItem("theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}catch{}`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // themeScript sets data-theme before hydration; this only silences that one attribute.
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#fefdfb" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#161b1a" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

const TITLES: Partial<Record<number, string>> = { 403: "没有权限", 404: "页面不存在" };

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const response = isRouteErrorResponse(error) ? error : null;
  const title = (response && TITLES[response.status]) ?? "出错了";
  const detail =
    typeof response?.data === "string"
      ? response.data
      : response?.status === 404
        ? "链接有误，或内容已被删除。"
        : "请稍后重试。";
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-muted-foreground">{detail}</p>
    </main>
  );
}
