// The HUD's own glyphs, drawn for this app at 16 units: killfeed badges, round-strip reasons,
// the bits of the player card, and the narrow camera bar's Highlights and Share. Stroked in
// currentColor.

import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { title?: string };

function Glyph({
  title,
  children,
  ...rest
}: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

export function Headshot(p: P) {
  return (
    <Glyph {...p}>
      <circle cx="8" cy="8" r="5" />
      <path d="M8 1v3M8 12v3M1 8h3M12 8h3" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

export function Wallbang(p: P) {
  return (
    <Glyph {...p}>
      <rect x="6.5" y="2" width="3" height="12" rx="0.5" />
      <path d="M1.5 8h13M12 5.5 14.5 8 12 10.5" />
    </Glyph>
  );
}

export function ThroughSmoke(p: P) {
  return (
    <Glyph {...p}>
      <path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.6-.9 3.2 3.2 0 0 1 .3 6.9Z" />
    </Glyph>
  );
}

export function NoScope(p: P) {
  return (
    <Glyph {...p}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M3.5 12.5l9-9" />
    </Glyph>
  );
}

export function BlindKill(p: P) {
  return (
    <Glyph {...p}>
      <path d="M1.5 8s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" />
      <path d="M2.5 13.5l11-11" />
    </Glyph>
  );
}

export function FlashAssist(p: P) {
  return (
    <Glyph {...p}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </Glyph>
  );
}

export function Bomb(p: P) {
  return (
    <Glyph {...p}>
      <rect x="2" y="5" width="12" height="8" rx="1" />
      <path d="M5 5V3.5h3M10.5 8.5h1.5M4.5 8.5h3" />
    </Glyph>
  );
}

export function Defuse(p: P) {
  return (
    <Glyph {...p}>
      <path d="M8 1.8 13.5 4v4.2c0 3-2.3 5.2-5.5 6-3.2-.8-5.5-3-5.5-6V4Z" />
      <path d="M5.5 8.2 7.3 10l3.4-3.6" />
    </Glyph>
  );
}

export function Eliminated(p: P) {
  return (
    <Glyph {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Glyph>
  );
}

export function TimeRanOut(p: P) {
  return (
    <Glyph {...p}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </Glyph>
  );
}

export function Helmet(p: P) {
  return (
    <Glyph {...p}>
      <path d="M2.5 11.5V9a5.5 5.5 0 0 1 11 0v2.5Z" />
      <path d="M2 11.5h12" />
    </Glyph>
  );
}

export function Vest(p: P) {
  return (
    <Glyph {...p}>
      <path d="M5 2 3 4v10h10V4l-2-2-1.5 2h-3Z" />
    </Glyph>
  );
}

export function Kit(p: P) {
  return (
    <Glyph {...p}>
      <rect x="2.5" y="4" width="11" height="9" rx="1.2" />
      <path d="M6 4V2.5h4V4M8 6.5v4M6 8.5h4" />
    </Glyph>
  );
}

export function Star(p: P) {
  return (
    <Glyph {...p}>
      <path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6Z" />
    </Glyph>
  );
}

export function Share(p: P) {
  return (
    <Glyph {...p}>
      <path d="M8 10V2M5 5l3-3 3 3" />
      <path d="M3.5 8.5v5h9v-5" />
    </Glyph>
  );
}
