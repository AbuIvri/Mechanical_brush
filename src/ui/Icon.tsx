import type { ReactNode } from "react";
import type { IconName } from "./iconNames";

/** The app's icons: one line weight, one colour, no fill — drawn for this product.
 *
 *  They replace emoji and Unicode symbols, which rendered differently on every operating
 *  system (so the product had no fixed face) and came in their own colours (competing with
 *  the image, the one thing on screen that should be colourful).
 *
 *  Rules, from the design system: a 24px grid, a 1.5px stroke with round caps and joins,
 *  `currentColor` — steel-300 at rest, steel-100 on hover, on-ink when sitting on a
 *  stroke. An icon stands alone only in the tool rail and in a layer row, and every
 *  icon-only button carries an aria-label; the icon itself is hidden from assistive tech.
 */
const SHAPES: Record<IconName, ReactNode> = {
  move: <path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />,
  rect: <rect x="4" y="6" width="16" height="12" strokeDasharray="3 2.5" />,
  brush: <path d="M10 15 19.5 4.5l1 1L11 16M4 20c2.5 0 5-.8 5-3.4 0-1.5-1.100-2.600-2.500-2.600C4 14 4.600 17.500 4 20z" />,
  pin: (
    <>
      <circle cx="12" cy="9" r="4.5" />
      <path d="M12 13.5V21" />
    </>
  ),
  text: <path d="M6 6h12M12 6v13M9.5 19h5" />,
  arrow: <path d="M6 18 18 6M10 6h8v8" />,
  wand: <path d="M4 20 15 9M13.5 7.5l3 3M18 3v3M21 6h-3M19.5 12v2M8 4v2" />,
  target: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  // Object removal: the plaster of every retouching tool.
  heal: (
    <g transform="rotate(-45 12 12)">
      <rect x="3" y="8.5" width="18" height="7" rx="3.5" />
      <path d="M9 8.500v7M15 8.500v7M11.200 12h.01M12.800 12h.01" />
    </g>
  ),
  eraser: <path d="m5 15 8-8 6 6-5 5H8zM10 10l6 6M3 21h18" />,
  hand: (
    <path d="M8.500 12.500V6a1.500 1.500 0 0 1 3 0v5M11.500 10.500V4.500a1.500 1.500 0 0 1 3 0v6M14.500 11V6.500a1.500 1.500 0 0 1 3 0V14c0 4-2.500 6.500-6 6.500-3 0-4.500-1.500-6-4.500l-2-3.800a1.400 1.400 0 0 1 2.400-1.400l2.100 2.700" />
  ),
  pen: <path d="M4 17c3-7 5 3 8-3s4-6 8-2" />,
  frame: <rect x="4" y="6" width="16" height="12" />,
  "rotate-ccw": <path d="M3.500 5v5h5M4.200 10A8 8 0 1 1 6.400 17.700" />,
  "rotate-cw": <path d="M20.500 5v5h-5M19.800 10A8 8 0 1 0 17.600 17.700" />,
  // Lock the marking rectangle to 1:1.
  square: (
    <>
      <rect x="6.500" y="6.500" width="11" height="11" />
      <path d="M3 7V3h4M21 17v4h-4" />
    </>
  ),
  "clear-rect": (
    <>
      <rect x="4" y="6" width="16" height="12" strokeDasharray="3 2.5" />
      <path d="m9.500 9.500 5 5M14.500 9.500l-5 5" />
    </>
  ),
  "clear-notes": <path d="M3 16c2-5 4 2 6-1s3-4 5-1M16 6l5 5M21 6l-5 5" />,
  "mask-view": (
    <>
      <rect x="4" y="6" width="16" height="12" strokeDasharray="3 2.5" />
      <path d="M8 12s1.500-2.500 4-2.500S16 12 16 12s-1.500 2.500-4 2.500S8 12 8 12z" />
    </>
  ),
  compare: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16M12 7h5.500M12 12h8M12 17h5.500" />
    </>
  ),
  // "Transparent": the checkerboard. The one icon with filled parts.
  checker: (
    <>
      <rect x="4" y="4" width="16" height="16" />
      <path d="M4 4h8v8H4zM12 12h8v8h-8z" fill="currentColor" stroke="none" />
    </>
  ),
  zoom: (
    <>
      <circle cx="10.500" cy="10.500" r="6" />
      <path d="m15 15 5.500 5.500" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
      <circle cx="12" cy="12" r="3.500" />
    </>
  ),
  pencil: <path d="m4 20 4-1L19.500 7.500l-3-3L5 16zM14 7l3 3" />,
  eye: (
    <>
      <path d="M2 12s4-6.500 10-6.500S22 12 22 12s-4 6.500-10 6.500S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.600" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M2 12s4-6.500 10-6.500S22 12 22 12s-4 6.500-10 6.500S2 12 2 12z" />
      <path d="M4 4l16 16" />
    </>
  ),
  lock: (
    <>
      <rect x="6" y="11" width="12" height="9" />
      <path d="M9 11V8a3 3 0 0 1 6 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="6" y="11" width="12" height="9" />
      <path d="M9 11V8a3 3 0 0 1 5.700-1.300" />
    </>
  ),
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  down: <path d="M12 5v14M6 13l6 6 6-6" />,
  // Fill the canvas (cover) / fit inside it (contain).
  expand: <path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6" />,
  contain: (
    <>
      <rect x="4" y="5" width="16" height="14" />
      <rect x="8" y="9" width="8" height="6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M18 7h2M4 17h3M12 17h8" />
      <circle cx="15.500" cy="7" r="2.200" />
      <circle cx="9.500" cy="17" r="2.200" />
    </>
  ),
  droplet: <path d="M12 4c3 4 5.500 6.500 5.500 9.500a5.500 5.500 0 0 1-11 0C6.500 10.500 9 8 12 4z" />,
  duplicate: (
    <>
      <rect x="8" y="8" width="12" height="12" />
      <path d="M16 8V4H4v12h4" />
    </>
  ),
  "merge-down": <path d="M12 4v9M8 9.500l4 4 4-4M4 18h16" />,
  export: <path d="M12 15V4M8 8l4-4 4 4M5 14v6h14v-6" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  plus: <path d="M12 5v14M5 12h14" />,
  flatten: <path d="m4 11 8-4 8 4-8 4zM4 18h16" />,
  mosaic: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  stack: <path d="m4 9 8-4 8 4-8 4zM4 14l8 4 8-4" />,
  "dock-pin": <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />,
  chevron: <path d="m9 6 6 6-6 6" />,
};

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[name]}
    </svg>
  );
}
