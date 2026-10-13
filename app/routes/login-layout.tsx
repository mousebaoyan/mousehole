import { ArrowLeft } from "lucide-react";
import { Link, Outlet } from "react-router";

export default function LoginLayout() {
  return (
    <div className="flex min-h-svh flex-col bg-secondary/50">
      <header className="px-4 py-2 sm:px-6">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> 返回论坛
        </Link>
      </header>
      {/* Bottom padding matches the header, so the card sits in the middle of the screen. */}
      <main className="flex flex-1 flex-col items-center justify-center px-4 pb-16">
        <Outlet />
      </main>
    </div>
  );
}
