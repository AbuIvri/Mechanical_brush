// What a marked region actually becomes on its way to the engine.
//
// A generative fill does not send the rectangle you drew. It pads it, clamps it to the
// canvas and to a 4:1 aspect, then resamples the crop so its long edge equals the chosen
// "region resolution". So the size of the rectangle on screen is NOT the size the model
// works at — and the on-canvas readout has to say the true one, or it misleads exactly
// where the user asked for precision.
//
// The store and the canvas badge both call this, so what you are shown and what is sent
// cannot drift apart.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Context padding around the marked region, per side, as a fraction of that side. */
export const FILL_PAD = 0.14;
/** …but never less than this, so a tiny mark still gets something to blend into. */
export const FILL_PAD_MIN = 24;
/** The widest crop the pipeline will send. */
export const FILL_MAX_ASPECT = 4;

/** Expand the shorter side of a box so its aspect ratio never exceeds maxRatio. */
export function clampBoxAspect(box: Box, maxRatio: number, W: number, H: number): Box {
  let { x, y, w, h } = box;
  const ratio = Math.max(w / h, h / w);
  if (ratio <= maxRatio) return box;
  if (w > h) {
    const target = Math.ceil(w / maxRatio);
    const grow = target - h;
    y = Math.max(0, y - Math.floor(grow / 2));
    h = Math.min(H - y, target);
  } else {
    const target = Math.ceil(h / maxRatio);
    const grow = target - w;
    x = Math.max(0, x - Math.floor(grow / 2));
    w = Math.min(W - x, target);
  }
  return { x, y, w, h };
}

/** The crop a marked region turns into: padded, clamped to the canvas, aspect-limited. */
export function paddedFillBox(tight: Box, W: number, H: number): Box {
  const padX = Math.max(FILL_PAD_MIN, Math.round(tight.w * FILL_PAD));
  const padY = Math.max(FILL_PAD_MIN, Math.round(tight.h * FILL_PAD));
  const bx = Math.max(0, Math.floor(tight.x - padX));
  const by = Math.max(0, Math.floor(tight.y - padY));
  const bx2 = Math.min(W, Math.ceil(tight.x + tight.w + padX));
  const by2 = Math.min(H, Math.ceil(tight.y + tight.h + padY));
  return clampBoxAspect({ x: bx, y: by, w: bx2 - bx, h: by2 - by }, FILL_MAX_ASPECT, W, H);
}

/** The region resolutions the fill mode offers (FILL_RES in the provider options). */
export const FILL_BENCHMARKS: { px: number; label: string }[] = [
  { px: 1024, label: "1K" },
  { px: 1536, label: "1.5K" },
  { px: 2048, label: "2K" },
  { px: 3072, label: "3K" },
];

/** A rectangle drawn with the rect tool is sent AS DRAWN — no context padding — so the
 *  number in its corner is the number the model works at. A tolerance would put the
 *  highlight back on "near enough", which is the thing that made it useless: it told you
 *  where you roughly were instead of when you had arrived. The colour changes on the
 *  exact value and on nothing else. */
export const BENCHMARK_TOLERANCE = 0;

/** A selection marked as exact is sent as-is: the crop IS the rectangle, so the model
 *  works at exactly the requested resolution. The ~14% context padding is what makes a
 *  free selection land 28% over, and it is deliberately skipped here. */
export function fillBoxFor(tight: Box, W: number, H: number, exact?: boolean): Box {
  return exact ? { ...tight } : paddedFillBox(tight, W, H);
}

// ---- Pixel density: canvas pixels are not image pixels ----
//
// A layer can hold more pixels than its footprint on the canvas: a ×2 upscale of a
// 3808-wide picture is a 7616-wide image drawn into the same 3808 canvas units. A fill
// that works in canvas units cuts the crop from a canvas-sized flatten and hands back a
// canvas-sized patch, so over an upscale it throws away half the pixels on the way in
// and again on the way out. The fill works in the density of the sharpest layer under
// the selection instead, and so does the readout, so the number in the corner is still
// the number of pixels the model works at.

/** The longest edge, in image pixels, a fill will cut its source crop at. */
export const FILL_SRC_MAX_EDGE = 8192;

export interface DensityLayer {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  type: string;
  /** The natural pixel width of the layer's image, when it is known. */
  natW?: number;
}

/** Image pixels per canvas pixel under `box`: the sharpest visible layer that overlaps
 *  it, never below 1, and capped so the crop's long edge stays within maxEdge. */
export function regionDensity(layers: DensityLayer[], box: Box, maxEdge = FILL_SRC_MAX_EDGE): number {
  let d = 1;
  for (const l of layers) {
    if (!l.visible || l.type === "mask" || l.type === "reference" || !l.natW || l.width <= 0) continue;
    const overlaps =
      l.x < box.x + box.w && l.x + l.width > box.x && l.y < box.y + box.h && l.y + l.height > box.y;
    if (!overlaps) continue;
    d = Math.max(d, l.natW / l.width);
  }
  const long = Math.max(box.w, box.h, 1);
  return Math.max(1, Math.min(d, maxEdge / long));
}

/** A canvas box in the pixel grid of an image `density` times denser. */
export function scaleBox(box: Box, density: number): Box {
  if (density === 1) return { ...box };
  const x = Math.floor(box.x * density);
  const y = Math.floor(box.y * density);
  return { x, y, w: Math.max(1, Math.round(box.w * density)), h: Math.max(1, Math.round(box.h * density)) };
}

export interface RegionReadout {
  /** The rectangle the user drew, in image pixels (canvas pixels × density). */
  w: number;
  h: number;
  /** The long edge of the crop that will actually be sent. */
  sentLongEdge: number;
  /** The nearest region resolution, and whether the crop lands on it 1:1. */
  nearest: { px: number; label: string };
  onBenchmark: boolean;
  /** True when the marked rectangle is square, which is what "1024 × 1024" means. */
  square: boolean;
  /** Snapped by the square lock: sent as drawn, so the number shown is the real one. */
  exact: boolean;
}

/** What to show on a marked rectangle while it is being dragged. */
export function regionReadout(tight: Box, W: number, H: number, exact?: boolean, density = 1): RegionReadout {
  const box = scaleBox(fillBoxFor(tight, W, H, exact), density);
  const sentLongEdge = Math.max(box.w, box.h);
  let nearest = FILL_BENCHMARKS[0];
  for (const b of FILL_BENCHMARKS) {
    if (Math.abs(b.px - sentLongEdge) < Math.abs(nearest.px - sentLongEdge)) nearest = b;
  }
  return {
    w: Math.round(tight.w * density),
    h: Math.round(tight.h * density),
    sentLongEdge,
    nearest,
    // Exact, or not at all.
    onBenchmark: sentLongEdge === nearest.px,
    exact: !!exact,
    square: Math.abs(tight.w - tight.h) / Math.max(tight.w, tight.h, 1) <= 0.01,
  };
}

// ---- Generation size: follows the marked area unless the user picks one ----

/** The "region resolution" value that means "match the marked area". */
export const FILL_AUTO = 0;

/** The long edge a fill is generated at. By default it is the marked area's own long
 *  edge in image pixels, so nothing is resampled on the way in or out; a size picked in
 *  the dock (1K, 2K…) overrides it. */
export function fillLongEdgeFor(regionW: number, regionH: number, setting?: number | string | null): number {
  const picked = Number(setting);
  return picked > 0 ? picked : Math.max(regionW, regionH);
}

/**
 * Working resolution for a fill crop: preserve the box aspect at `longEdge`,
 * then guarantee the image satisfies gpt-image-2 constraints
 * (>= 655,360 px, multiples of 16, max edge 3840). This is what lets small
 * selections be generated without hitting any minimum-pixel limit.
 */
export function workingSize(boxW: number, boxH: number, longEdge: number): { w: number; h: number } {
  const MIN = 655360 * 1.12;
  const MAX_EDGE = 3840;
  /** The model's pixel budget (3840×2160). */
  const MAX_PX = 8294400;
  const aspect = boxW / boxH;
  // Cap the long edge BEFORE shaping: clamping each edge separately afterwards turned a
  // 7000×2000 area into 3840×2000 — a squashed crop. A size picked from the menu never
  // went past 3072, but one that follows the marked area can.
  longEdge = Math.min(longEdge, MAX_EDGE);
  let w: number, h: number;
  if (aspect >= 1) {
    w = longEdge;
    h = Math.round(longEdge / aspect);
  } else {
    h = longEdge;
    w = Math.round(longEdge * aspect);
  }
  if (w * h < MIN) {
    const s = Math.sqrt(MIN / (w * h));
    w = Math.round(w * s);
    h = Math.round(h * s);
  } else if (w * h > MAX_PX * 0.98) {
    // Inside the budget with room for the snap to 16, which can round up.
    const s = Math.sqrt((MAX_PX * 0.98) / (w * h));
    w = Math.floor(w * s);
    h = Math.floor(h * s);
  }
  const snap = (n: number) => Math.max(256, Math.min(MAX_EDGE, Math.round(n / 16) * 16));
  return { w: snap(w), h: snap(h) };
}
