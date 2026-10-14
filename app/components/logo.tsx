import { useId } from "react";
import { Link } from "react-router";
import { SITE_NAME } from "../../server/platform/site.ts";

// A mouse looking out of its hole, after the 鼠群 logo. The hole is also the rising sun, and
// the mouse sits above the water: 上岸. Four lines for 四非, and read upwards they get longer,
// like a road that widens as you go.
export function LogoMark({ className }: { className?: string }) {
  const sun = useId();
  return (
    <svg viewBox="2 10 60 60" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={sun} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="[stop-color:#f9cda8] dark:[stop-color:#e6a982]" />
          <stop offset="1" className="[stop-color:#ef9466] dark:[stop-color:#c4764f]" />
        </linearGradient>
      </defs>
      <path d="M10 42a22 22 0 0 1 44 0z" fill={`url(#${sun})`} />
      <g
        className="fill-[#fffaf2] stroke-[#2f403d] dark:fill-[#2b3331] dark:stroke-[#e9e2d3]"
        strokeWidth={2.6}
        strokeLinejoin="round"
      >
        <circle cx="24" cy="30.5" r="5.6" />
        <circle cx="40" cy="30.5" r="5.6" />
        <path d="M21 42a11 11 0 0 1 22 0z" />
      </g>
      <g className="fill-[#f6b48c] dark:fill-[#c98863]">
        <circle cx="24" cy="30.5" r="2.2" />
        <circle cx="40" cy="30.5" r="2.2" />
        <ellipse cx="32" cy="40.3" rx="1.9" ry="1.4" />
      </g>
      <g className="fill-[#2f403d] dark:fill-[#e9e2d3]">
        <circle cx="28.4" cy="36.6" r="1.5" />
        <circle cx="35.6" cy="36.6" r="1.5" />
      </g>
      <path
        d="M4 42h56M12 48.5h40M19 54.5h26M26 60h12"
        className="stroke-[#2f403d] dark:stroke-[#e9e2d3]"
        strokeWidth={2.6}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold tracking-tight">
      <LogoMark className="size-9" />
      <span className="text-lg">{SITE_NAME}</span>
    </Link>
  );
}
