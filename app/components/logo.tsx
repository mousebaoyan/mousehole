import { Link } from "react-router";

// After the 鼠群 logo: a mouse peeking out of its hole in front of the sun, with the ground lines.
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="23" cy="9.5" r="8.5" className="fill-brand" />
      <g className="stroke-primary dark:stroke-foreground" strokeWidth={1.8}>
        <circle cx="6.8" cy="12" r="4.4" className="fill-[#b9b4a6] dark:fill-[#6f736c]" />
        <circle cx="20.2" cy="12" r="4.4" className="fill-[#b9b4a6] dark:fill-[#6f736c]" />
      </g>
      <circle cx="6.8" cy="12" r="2" className="fill-brand" />
      <circle cx="20.2" cy="12" r="2" className="fill-brand" />
      <path
        d="M5.5 25.5V19a8 8 0 0 1 16 0v6.5z"
        className="fill-primary stroke-primary dark:fill-[#0c100f] dark:stroke-foreground"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <circle cx="11" cy="20.5" r="1.3" fill="#fdf6e7" />
      <circle cx="16" cy="20.5" r="1.3" fill="#fdf6e7" />
      <path
        d="M2.5 25.5h27M8.5 29.5h15"
        className="stroke-primary dark:stroke-foreground"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
      <LogoMark className="size-8" />
      <span className="text-lg">鼠洞</span>
    </Link>
  );
}
