// Pieces of photos too big to work on whole: the arithmetic, with no DOM and no store
// (the store builds a zustand store at import time and touches localStorage, so anything
// tests need lives outside it).

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Above this long edge, opening a picture asks: shrink it, or cut a piece. */
export const LARGE_IMAGE_EDGE = 4096;
/** Above this, most engines downscale a piece before working on it anyway. */
export const ENGINE_COMFORT_EDGE = 4096;
/** Generation sizes worth landing on exactly — the picker marks them. */
export const PIECE_PRESETS = [1024, 1536, 2048, 3072, 4096];

/** A rectangle in the original, made whole-pixel and kept inside it, at least 16px. */
export function clampRect(r: Box, ow: number, oh: number): Box {
  const x0 = Math.max(0, Math.min(ow - 16, Math.round(Math.min(r.x, r.x + r.w))));
  const y0 = Math.max(0, Math.min(oh - 16, Math.round(Math.min(r.y, r.y + r.h))));
  const x1 = Math.min(ow, Math.max(x0 + 16, Math.round(Math.max(r.x, r.x + r.w))));
  const y1 = Math.min(oh, Math.max(y0 + 16, Math.round(Math.max(r.y, r.y + r.h))));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The same rectangle moved by (dx, dy), kept whole inside the original. */
export function moveRect(r: Box, dx: number, dy: number, ow: number, oh: number): Box {
  return {
    x: Math.max(0, Math.min(ow - r.w, Math.round(r.x + dx))),
    y: Math.max(0, Math.min(oh - r.h, Math.round(r.y + dy))),
    w: r.w,
    h: r.h,
  };
}

/** How close to the photo's border, in SCREEN pixels, an edge has to come to land on it.
 *  At 5–6 original pixels per screen pixel, stopping a hair short of the border would
 *  otherwise leave a 20–60px sliver of the photo outside the piece. */
export const EDGE_SNAP_SCREEN = 12;

/** A drawn rectangle with every edge near the photo's border put on it. */
export function snapToEdges(r: Box, ow: number, oh: number, tol: number): Box {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  if (x0 <= tol) x0 = 0;
  if (y0 <= tol) y0 = 0;
  if (ow - x1 <= tol) x1 = ow;
  if (oh - y1 <= tol) y1 = oh;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A moved rectangle, kept its size, put flush against a border it comes near. */
export function snapMoveToEdges(r: Box, ow: number, oh: number, tol: number): Box {
  let x = r.x, y = r.y;
  if (x <= tol) x = 0;
  else if (ow - (x + r.w) <= tol) x = ow - r.w;
  if (y <= tol) y = 0;
  else if (oh - (y + r.h) <= tol) y = oh - r.h;
  return { x, y, w: r.w, h: r.h };
}

/** A new size for the rectangle, typed exactly, grown or shrunk around its centre and
 *  kept inside the original. */
export function resizeRect(r: Box, w: number, h: number, ow: number, oh: number): Box {
  const W = Math.max(16, Math.min(ow, Math.round(w)));
  const H = Math.max(16, Math.min(oh, Math.round(h)));
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return {
    x: Math.max(0, Math.min(ow - W, Math.round(cx - W / 2))),
    y: Math.max(0, Math.min(oh - H, Math.round(cy - H / 2))),
    w: W,
    h: H,
  };
}

/** How a piece blends back into the photo, for a band of `band` pixels at its edge.
 *
 *  The blend is a Gaussian blur of a "keep" mask inset by 2.5 sigma, with sigma a fifth of
 *  the band — so the band is 2.5 sigma each side of the mask's edge: the piece is ~0.6%
 *  opaque at its own outer edge (the photo, unchanged; the rectangle never shows as a
 *  step) and ~99.4% at the band's inner edge (the piece as edited, from there in). */
export function blendBand(w: number, h: number, band: number): { sigma: number; keep: Box } {
  const b = Math.max(0, Math.min(band, Math.floor(Math.min(w, h) / 2) - 1));
  const sigma = b / 5;
  const inset = 2.5 * sigma;
  return { sigma, keep: { x: inset, y: inset, w: w - 2 * inset, h: h - 2 * inset } };
}
