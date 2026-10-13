import { Link } from "react-router";

export function Logo() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
      <svg viewBox="0 0 24 24" className="size-7" aria-hidden="true">
        <rect width="24" height="24" rx="7" className="fill-primary" />
        <path d="M6 18.5v-5.5a6 6 0 0 1 12 0v5.5z" className="fill-primary-foreground" />
        <circle cx="10.2" cy="14.6" r="1" className="fill-primary" />
        <circle cx="13.8" cy="14.6" r="1" className="fill-primary" />
      </svg>
      <span className="text-[17px]">鼠洞</span>
    </Link>
  );
}
