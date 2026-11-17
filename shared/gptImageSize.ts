/**
 * The output-size constraints shared by GPT Image 2.5 (Flare and Sunburst) and
 * GPT Image 2, in one place.
 *
 * The main process needs them to build the API request, and the renderer needs them to
 * tell the user what will actually come out before they spend anything — asking for 4K
 * at 1:1 really does return 2880×2880, and a control that hides that isn't control.
 * Pure arithmetic, no imports: safe on both sides.
 */

/** Round to the nearest multiple of 16, clamped to [lo, hi]. */
export function snap16(n: number, lo = 256, hi = 3840): number {
  return Math.max(lo, Math.min(hi, Math.round(n / 16) * 16));
}

/** Total pixels the model accepts: ~0.65MP to 8.29MP (= 3840×2160 exactly). */
export const MIN_PIXELS = 655360;
export const MAX_PIXELS = 8294400;
/** The longest edge the model will emit, and the widest aspect it accepts. */
export const MAX_EDGE = 3840;
export const MAX_RATIO = 3;

/**
 * Fit a requested size to what the model will actually produce: aspect no wider than
 * 3:1, pixel count inside the budget, both edges on a multiple of 16.
 */
export function fitFlexibleSize(targetW: number, targetH: number): { w: number; h: number } {
  let w = snap16(targetW);
  let h = snap16(targetH);

  // Fast path: get close proportionally, then correct. Proportional scaling alone is not
  // enough — snapping to 16 afterwards can nudge an extreme aspect back over 3:1 (a
  // 30:1 input lands on 3.03:1), and the API rejects that outright.
  const ratio = Math.max(w / h, h / w);
  if (ratio > MAX_RATIO) {
    if (w > h) w = snap16(h * MAX_RATIO);
    else h = snap16(w * MAX_RATIO);
  }
  const px = w * h;
  if (px < MIN_PIXELS || px > MAX_PIXELS) {
    const scale = Math.sqrt((px < MIN_PIXELS ? MIN_PIXELS : MAX_PIXELS) / px);
    w = snap16(w * scale);
    h = snap16(h * scale);
  }

  // Correction, one 16px step at a time. Every branch moves toward the feasible region:
  // growing the short edge lowers the ratio AND raises the pixel count, shrinking the
  // long edge lowers both, and growing both equally raises the count while lowering the
  // ratio — so this settles rather than oscillates.
  for (let i = 0; i < 256; i++) {
    const r = Math.max(w / h, h / w);
    const p = w * h;
    if (r > MAX_RATIO) {
      if (p < MIN_PIXELS) {
        if (w > h) h += 16;
        else w += 16;
      } else if (w > h) w -= 16;
      else h -= 16;
    } else if (p > MAX_PIXELS) {
      if (w >= h) w -= 16;
      else h -= 16;
    } else if (p < MIN_PIXELS) {
      w += 16;
      h += 16;
    } else break;
  }

  return { w: Math.max(256, w), h: Math.max(256, h) };
}

/** Fit a source aspect into a square box of `box` px, before the constraints above. */
export function boxToAspect(aspect: number, box: number): { w: number; h: number } {
  return aspect >= 1 ? { w: box, h: box / aspect } : { w: box * aspect, h: box };
}
