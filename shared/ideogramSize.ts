// Ideogram 4.5's output-size rules, as pure arithmetic — shared, so the size the UI
// predicts and the size the provider asks for come from the same code.
//
// From the API reference: an exact size has both sides a multiple of 32, each at least
// 256px, at most 2048×2048 pixels in total, and an aspect ratio of at most 6:1. Pricing is
// tiered on the resolved output: up to 1024×1024 bills as 1K, anything larger as 2K.
// Without source images an exact size must also be one of Ideogram's presets, and the
// full preset list is not published — so the provider retries with "auto" if a computed
// size is refused (a refused request is a 400, and a 400 is not billed).

export const IDEOGRAM_MAX_PIXELS = 2048 * 2048;
export const IDEOGRAM_1K_PIXELS = 1024 * 1024;
const STEP = 32;
const MIN_EDGE = 256;
const MAX_RATIO = 6;

export type IdeogramTier = "1k" | "2k";

export function tierOf(w: number, h: number): IdeogramTier {
  return w * h <= IDEOGRAM_1K_PIXELS ? "1k" : "2k";
}

const floor32 = (n: number) => Math.max(MIN_EDGE, Math.floor(n / STEP) * STEP);

/** The largest valid size of this aspect inside a pixel budget. */
export function sizeForAspect(aspect: number, budget: number = IDEOGRAM_MAX_PIXELS): { w: number; h: number } {
  const a = Math.min(MAX_RATIO, Math.max(1 / MAX_RATIO, aspect || 1));
  let w = floor32(Math.sqrt(budget * a));
  let h = floor32(w / a);
  // Rounding both sides down can only shrink the area, but the 256 floor can push the
  // short side up on an extreme aspect — walk the long side down until it fits again.
  while (w * h > budget && w > MIN_EDGE && h > MIN_EDGE) {
    if (w >= h) w -= STEP;
    else h -= STEP;
  }
  return { w, h };
}

/** A requested output size, made valid: aspect kept, area capped at 2K (or 1K when the
 *  request is that small — no reason to pay the 2K tier for a 1K ask). */
export function fitIdeogramSize(targetW: number, targetH: number): { w: number; h: number } {
  const budget = targetW * targetH <= IDEOGRAM_1K_PIXELS ? IDEOGRAM_1K_PIXELS : IDEOGRAM_MAX_PIXELS;
  return sizeForAspect(targetW / targetH, budget);
}

/** "16:9" → 16/9; anything else (including "auto") → null. */
export function parseAspect(ar: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(ar ?? ""));
  if (!m) return null;
  const a = Number(m[1]) / Number(m[2]);
  return a > 0 && Number.isFinite(a) ? a : null;
}

/** Smallest Ideogram upscale factor — 2, 4 or 8 — whose result stays within 8192px. */
export function upscaleFactor(longEdge: number, wanted: number): 2 | 4 | 8 {
  const allowed = ([2, 4, 8] as const).filter((f) => longEdge * f <= 8192);
  if (!allowed.length) throw new Error(`התמונה גדולה מדי להגדלה ב-Ideogram — הפלט מוגבל ל-8192 פיקסלים לצלע.`);
  return (allowed.find((f) => f >= wanted) ?? allowed[allowed.length - 1]) as 2 | 4 | 8;
}
