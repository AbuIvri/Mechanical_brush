import type { Annotation, Layer } from "../shared/types";
import { labelRegions, mergeNearby, type RegionBox } from "./regions";
import { isOriginalUrl } from "../shared/originalUrl";
import { fitColorMatch, applyColorFit, type ColorFit } from "./colorMatch";
import { FILL_SRC_MAX_EDGE, regionDensity, scaleBox } from "./fillRegion";

export interface MaskStroke {
  tool: "brush" | "erase";
  size: number;
  points: number[]; // [x0,y0,x1,y1,...] in document coordinates
  hardness?: number; // 0..100 (100 = hard edge)
}

export interface MaskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MaskState {
  strokes: MaskStroke[];
  rects: MaskRect[];
  /** Pixel selections (magic wand / AI segments): doc-sized canvases whose
   *  alpha channel is the selection. Kept as canvases so rasterizeMask stays
   *  synchronous and rendering is instant. */
  bitmaps: HTMLCanvasElement[];
  inverted: boolean;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // A full-resolution original comes from the app's own scheme, which is cross-origin to
    // the page. Without this the canvas that draws it is tainted and cannot be exported.
    if (isOriginalUrl(src)) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("טעינת תמונה נכשלה"));
    img.src = src;
  });
}

const BLEND_MAP: Record<string, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  "soft-light": "soft-light",
  difference: "difference",
  color: "color",
  luminosity: "luminosity",
};

/** A coordinate that is a whole pixel up to floating-point noise, made whole. Drawing at
 *  1001.9999999 instead of 1002 makes the browser blend neighbouring pixels — invisible on
 *  a photo, and enough to grey out 1px detail. */
function crisp(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-3 ? r : v;
}

/** Flatten the visible layers into a single PNG data URL at document size. */
export async function flattenLayers(
  layers: Layer[],
  width: number,
  height: number,
  background = "#ffffff",
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  // A transparent project paints no plate at all, so the layers' own alpha reaches the
  // exported PNG instead of being flattened onto a colour.
  ctx.fillStyle = bgFill(background);
  ctx.fillRect(0, 0, width, height);

  for (const layer of layers) {
    if (!layer.visible || layer.type === "mask" || layer.type === "reference") continue;
    const img = await loadImage(layer.src);
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = BLEND_MAP[layer.blendMode] ?? "source-over";
    ctx.drawImage(img, layer.x, layer.y, layer.width, layer.height);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
}

/**
 * Flatten visible layers at the HIGHEST native resolution present.
 *
 * The document/canvas keeps a fixed coordinate space, but a layer's `src` may
 * hold far more pixels than its on-canvas footprint (e.g. a 4K upscale shown
 * inside a 1K document). For export we pick a scale so the sharpest layer is
 * drawn at its full native resolution; every other layer is composited in
 * proportion. This is what lets mixed-resolution projects (upscale next to
 * generative fill) export without throwing away the upscaled detail.
 */
export async function flattenLayersHiRes(
  layers: Layer[],
  width: number,
  height: number,
  background = "#ffffff",
  maxEdge = 8192,
): Promise<{ src: string; width: number; height: number }> {
  const loaded = await Promise.all(
    layers.map((l) =>
      loadImage(l.src)
        .then((img) => ({ l, img }))
        .catch(() => null),
    ),
  );

  let scale = 1;
  for (const it of loaded) {
    if (!it) continue;
    const { l, img } = it;
    if (!l.visible || l.type === "mask" || l.type === "reference") continue;
    const natW = img.naturalWidth || img.width;
    const s = natW / l.width;
    if (s > scale) scale = s;
  }
  // Clamp so the export never exceeds maxEdge on its long side.
  scale = Math.min(scale, maxEdge / Math.max(width, height));

  const W = Math.max(1, Math.round(width * scale));
  const H = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = bgFill(background);
  ctx.fillRect(0, 0, W, H);

  for (const it of loaded) {
    if (!it) continue;
    const { l, img } = it;
    if (!l.visible || l.type === "mask" || l.type === "reference") continue;
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = BLEND_MAP[l.blendMode] ?? "source-over";
    ctx.drawImage(img, crisp(l.x * scale), crisp(l.y * scale), crisp(l.width * scale), crisp(l.height * scale));
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return { src: canvas.toDataURL("image/png"), width: W, height: H };
}

/**
 * Flatten only `box` (canvas units) at the pixel density of the sharpest visible layer
 * that overlaps it — what a generative fill cuts its crop from. Drawing just the box
 * keeps it cheap: the whole canvas at ×2 would be a 30MB PNG to encode for a crop of a
 * few hundred pixels.
 *
 * `box` in the result is the region in the returned image's own pixels — the whole
 * image, so a caller crops it with {0,0,width,height}.
 */
export async function flattenRegionHiRes(
  layers: Layer[],
  box: Box,
  background = "#ffffff",
  maxEdge = FILL_SRC_MAX_EDGE,
): Promise<{ src: string; width: number; height: number; density: number }> {
  const loaded = await Promise.all(
    layers.map((l) =>
      loadImage(l.src)
        .then((img) => ({ l, img }))
        .catch(() => null),
    ),
  );
  const density = regionDensity(
    loaded.flatMap((it) => (it ? [{ ...it.l, natW: it.img.naturalWidth || it.img.width }] : [])),
    box,
    maxEdge,
  );
  const px = scaleBox(box, density);
  const canvas = document.createElement("canvas");
  canvas.width = px.w;
  canvas.height = px.h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = bgFill(background);
  ctx.fillRect(0, 0, px.w, px.h);
  // The region's own pixel grid: canvas point p lands at (p - box.origin) × (px / box).
  const sx = px.w / box.w;
  const sy = px.h / box.h;
  for (const it of loaded) {
    if (!it) continue;
    const { l, img } = it;
    if (!l.visible || l.type === "mask" || l.type === "reference") continue;
    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = BLEND_MAP[l.blendMode] ?? "source-over";
    ctx.drawImage(
      img,
      crisp((l.x - box.x) * sx),
      crisp((l.y - box.y) * sy),
      crisp(l.width * sx),
      crisp(l.height * sy),
    );
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  return { src: canvas.toDataURL("image/png"), width: px.w, height: px.h, density };
}

/**
 * Rasterize the working mask into a PNG where white+opaque = regenerate.
 * Provider-agnostic; adapters translate to their own convention.
 */
export function rasterizeMask(
  mask: MaskState,
  width: number,
  height: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Start transparent (= keep everything).
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const paint = () => {
    for (const b of mask.bitmaps) {
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(b, 0, 0, width, height);
    }
    for (const r of mask.rects) {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    for (const s of mask.strokes) {
      ctx.globalCompositeOperation = s.tool === "erase" ? "destination-out" : "source-over";
      const blur = s.hardness != null ? (1 - s.hardness / 100) * s.size * 0.5 : 0;
      ctx.filter = blur > 0.3 ? `blur(${blur}px)` : "none";
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(s.points[0], s.points[1]);
      for (let i = 2; i < s.points.length; i += 2) {
        ctx.lineTo(s.points[i], s.points[i + 1]);
      }
      if (s.points.length === 2) ctx.lineTo(s.points[0] + 0.1, s.points[1] + 0.1);
      ctx.stroke();
    }
    ctx.filter = "none";
  };

  paint();

  if (mask.inverted) {
    // Invert alpha: regenerated <-> kept.
    const data = ctx.getImageData(0, 0, width, height);
    const tmp = document.createElement("canvas");
    tmp.width = width;
    tmp.height = height;
    const tctx = tmp.getContext("2d")!;
    tctx.fillStyle = "#ffffff";
    tctx.fillRect(0, 0, width, height);
    const full = tctx.getImageData(0, 0, width, height);
    for (let i = 3; i < data.data.length; i += 4) {
      full.data[i] = 255 - data.data[i];
    }
    tctx.putImageData(full, 0, 0);
    return tmp.toDataURL("image/png");
  }

  return canvas.toDataURL("image/png");
}

export function maskHasContent(mask: MaskState): boolean {
  return mask.inverted || mask.strokes.length > 0 || mask.rects.length > 0 || mask.bitmaps.length > 0;
}

/**
 * The marked area's bounds without rasterizing — for a readout that updates as you draw.
 * Rectangles are exact; a brush stroke counts its points plus half the brush, and an
 * eraser stroke is ignored, so the box can only be a little generous. A wand/AI
 * selection or an inverted mask returns null: their extent is only known in pixels, and
 * the run measures those for real.
 */
export function maskBoundsQuick(mask: MaskState, width: number, height: number): Box | null {
  if (mask.inverted || mask.bitmaps.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of mask.rects) {
    const rx = r.w < 0 ? r.x + r.w : r.x;
    const ry = r.h < 0 ? r.y + r.h : r.y;
    x1 = Math.min(x1, rx); y1 = Math.min(y1, ry);
    x2 = Math.max(x2, rx + Math.abs(r.w)); y2 = Math.max(y2, ry + Math.abs(r.h));
  }
  for (const st of mask.strokes) {
    if (st.tool !== "brush") continue;
    const half = st.size / 2;
    for (let i = 0; i + 1 < st.points.length; i += 2) {
      x1 = Math.min(x1, st.points[i] - half); y1 = Math.min(y1, st.points[i + 1] - half);
      x2 = Math.max(x2, st.points[i] + half); y2 = Math.max(y2, st.points[i + 1] + half);
    }
  }
  x1 = Math.max(0, Math.floor(x1)); y1 = Math.max(0, Math.floor(y1));
  x2 = Math.min(width, Math.ceil(x2)); y2 = Math.min(height, Math.ceil(y2));
  if (!(x2 > x1 && y2 > y1)) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Tight bounding box of the masked (opaque) pixels in a rasterized mask.
 * Returns null when the mask is empty. Samples with a stride for speed.
 */
export async function maskBounds(
  maskUrl: string,
  width: number,
  height: number,
): Promise<Box | null> {
  const img = await loadImage(maskUrl);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const step = Math.max(1, Math.floor(Math.max(width, height) / 1500));
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Pad a box by `pad` px on each side, clamped to [0,0,width,height]. */
export function padBox(box: Box, pad: number, width: number, height: number): Box {
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const x2 = Math.min(width, Math.ceil(box.x + box.w + pad));
  const y2 = Math.min(height, Math.ceil(box.y + box.h + pad));
  return { x, y, w: x2 - x, h: y2 - y };
}

/** Crop a sub-region out of an image into its own canvas-sized data URL. */
export async function cropRegion(src: string, box: Box): Promise<string> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = box.w;
  canvas.height = box.h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return canvas.toDataURL("image/png");
}

/**
 * Crop a region and resample it to a working resolution (tw x th).
 * Lets a tiny on-canvas selection be sent to the model as a full-size input
 * image — the selection's pixel count no longer limits generation.
 */
export async function cropRegionResized(
  src: string,
  box: Box,
  tw: number,
  th: number,
): Promise<string> {
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = tw;
  canvas.height = th;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, box.x, box.y, box.w, box.h, 0, 0, tw, th);
  return canvas.toDataURL("image/png");
}

/**
 * Center-crop an image to a target aspect ratio (width/height), keeping the
 * maximum resolution. Used to conform a model's output back to the source (or
 * region) aspect so an upscale/fill keeps the exact original shape — no stretch.
 * Returns the original src unchanged when it's already at the target aspect.
 */
export async function cropToAspect(src: string, targetAspect: number): Promise<string> {
  const img = await loadImage(src);
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih || !isFinite(targetAspect) || targetAspect <= 0) return src;
  const cur = iw / ih;
  if (Math.abs(cur - targetAspect) / targetAspect < 0.005) return src; // already matching
  let cw = iw;
  let ch = ih;
  if (cur > targetAspect) cw = Math.round(ih * targetAspect); // too wide → trim sides
  else ch = Math.round(iw / targetAspect); // too tall → trim top/bottom
  const x = Math.round((iw - cw) / 2);
  const y = Math.round((ih - ch) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, x, y, cw, ch, 0, 0, cw, ch);
  return canvas.toDataURL("image/png");
}

/** User-tunable color correction for a fill patch. */
export interface FillColorOptions {
  /** off = manual sliders only · global = one correction · local = plus a 4×4 offset field */
  mode: "off" | "global" | "local";
  strength: number; // 0..1 — how much of the auto correction to apply
  brightness: number; // -50..50
  temperature: number; // -50..50 (negative = cooler, positive = warmer)
  saturation: number; // -50..50
}
// On for every fill. The match (src/colorMatch.ts) measures the drift on the context
// the model was told to keep and only acts when that clearly helps, so a provider that
// returns the untouched area exactly is left exactly as it came back.
export const DEFAULT_FILL_COLOR: FillColorOptions = {
  mode: "local",
  strength: 1,
  brightness: 0,
  temperature: 0,
  saturation: 0,
};

/**
 * Correct the color/tone drift of a generated fill patch against the source crop.
 * Auto correction is estimated ONLY from pixels outside `excludeMask` (the context
 * that should be identical); see src/colorMatch.ts. Manual sliders
 * (brightness/temperature/saturation) stack on top.
 */
export async function applyFillColor(
  movingSrc: string,
  referenceSrc: string,
  excludeMaskSrc: string | undefined,
  opts: FillColorOptions,
): Promise<string> {
  const manualActive =
    Math.abs(opts.brightness) > 0.5 || Math.abs(opts.temperature) > 0.5 || Math.abs(opts.saturation) > 0.5;
  if (opts.mode === "off" && !manualActive) return movingSrc;

  const [mov, ref, mask] = await Promise.all([
    loadImage(movingSrc),
    loadImage(referenceSrc),
    excludeMaskSrc ? loadImage(excludeMaskSrc) : Promise.resolve(null as HTMLImageElement | null),
  ]);

  // ---- Auto correction, estimated on a small proxy ----
  let fit: ColorFit | null = null;
  if (opts.mode !== "off") {
    const S = 256;
    const rw = ref.naturalWidth || ref.width;
    const rh = ref.naturalHeight || ref.height;
    const sw = S;
    const sh = Math.max(16, Math.round((S * rh) / rw));
    const sample = (img: HTMLImageElement) => {
      const c = document.createElement("canvas");
      c.width = sw;
      c.height = sh;
      const x = c.getContext("2d")!;
      x.drawImage(img, 0, 0, sw, sh);
      return x.getImageData(0, 0, sw, sh).data;
    };
    fit = fitColorMatch(sample(mov), sample(ref), sw, sh, mask ? sample(mask) : null, opts.mode === "local");
  }
  if (!fit && !manualActive) return movingSrc;

  // ---- Apply at full resolution ----
  const mw = mov.naturalWidth || mov.width;
  const mh = mov.naturalHeight || mov.height;
  const out = document.createElement("canvas");
  out.width = mw;
  out.height = mh;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(mov, 0, 0, mw, mh);
  const px = ctx.getImageData(0, 0, mw, mh);
  const d = px.data;
  if (fit) applyColorFit(d, mw, mh, fit, opts.strength);

  if (manualActive) {
    const bri = opts.brightness * 1.1;
    const tmp = opts.temperature * 0.7;
    const satF = 1 + opts.saturation / 60;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i] + bri + tmp, g = d[i + 1] + bri, b = d[i + 2] + bri - tmp;
      if (satF !== 1) {
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        r = luma + (r - luma) * satF;
        g = luma + (g - luma) * satF;
        b = luma + (b - luma) * satF;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; // Uint8ClampedArray clamps
    }
  }
  ctx.putImageData(px, 0, 0);
  return out.toDataURL("image/png");
}

/**
 * Compose a patch-sized fill layer: the corrected result scaled into the box,
 * keeping only the masked region with a feathered edge. (Box space — the
 * caller positions the layer at the box's canvas coordinates.)
 */
export async function composeFillPatch(
  resultSrc: string,
  maskCropSrc: string,
  w: number,
  h: number,
  feather: number,
): Promise<string> {
  const [res, mask] = await Promise.all([loadImage(resultSrc), loadImage(maskCropSrc)]);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(res, 0, 0, w, h);
  ctx.globalCompositeOperation = "destination-in";
  if (feather > 0) ctx.filter = `blur(${feather}px)`;
  ctx.drawImage(mask, 0, 0, w, h);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  return c.toDataURL("image/png");
}

/**
 * Place a generated crop back into a full-canvas transparent layer at `box`,
 * then keep only the masked region so edges blend with the source.
 * The crop is scaled from its generated resolution back to the box size.
 */
export async function placeCropIntoLayer(
  cropResultSrc: string,
  box: Box,
  maskUrl: string,
  width: number,
  height: number,
  feather = 0,
): Promise<string> {
  const [crop, mask] = await Promise.all([loadImage(cropResultSrc), loadImage(maskUrl)]);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(crop, 0, 0, crop.width, crop.height, box.x, box.y, box.w, box.h);
  // Keep only the masked region; a feathered (blurred) mask softens the edge
  // so the edited area blends seamlessly into the untouched surroundings.
  ctx.globalCompositeOperation = "destination-in";
  if (feather > 0) ctx.filter = `blur(${feather}px)`;
  ctx.drawImage(mask, 0, 0, width, height);
  ctx.filter = "none";
  ctx.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
}

/**
 * Erase pixels from a layer along a brush stroke (destructive, undoable).
 * `points` are in document coordinates; they are mapped into the layer's own
 * pixel space. Soft edges come from a blur derived from `hardness`.
 */
export async function eraseFromLayer(
  layerSrc: string,
  layer: { x: number; y: number; width: number; height: number },
  points: number[],
  size: number,
  hardness: number,
): Promise<string> {
  const img = await loadImage(layerSrc);
  const natW = img.naturalWidth || img.width;
  const natH = img.naturalHeight || img.height;
  const canvas = document.createElement("canvas");
  canvas.width = natW;
  canvas.height = natH;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, natW, natH);

  const sx = natW / layer.width;
  const sy = natH / layer.height;
  // Stamp radial-gradient circles along the stroke so the erase is confined to
  // the brush shape exactly: full erase inside the inner (hardness) radius,
  // fading to zero AT the brush edge — never beyond it (unlike a blur filter,
  // whose gaussian tail bleeds far past the stroke).
  const radius = (size * sx) / 2;
  const inner = Math.max(0, Math.min(1, hardness / 100));
  const stamp = (x: number, y: number) => {
    const g = ctx.createRadialGradient(x, y, radius * inner, x, y, radius);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.globalCompositeOperation = "destination-out";
  const px = (i: number) => (points[i] - layer.x) * sx;
  const py = (i: number) => (points[i + 1] - layer.y) * sy;
  const step = Math.max(1, radius * 0.25); // dense spacing → smooth, even stroke
  stamp(px(0), py(0));
  for (let i = 2; i < points.length; i += 2) {
    const x0 = px(i - 2), y0 = py(i - 2);
    const x1 = px(i), y1 = py(i);
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) stamp(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
  }
  ctx.globalCompositeOperation = "source-over";
  return canvas.toDataURL("image/png");
}

/**
 * Erase the selected (masked) region from a layer — full-strength delete.
 * `maskUrl` is a doc-sized mask; it's mapped into the layer's pixel space.
 */
export async function eraseMaskedFromLayer(
  layerSrc: string,
  layerBox: { x: number; y: number; width: number; height: number },
  maskUrl: string,
): Promise<string> {
  const [img, mask] = await Promise.all([loadImage(layerSrc), loadImage(maskUrl)]);
  const natW = img.naturalWidth || img.width;
  const natH = img.naturalHeight || img.height;
  const docW = mask.naturalWidth || mask.width;
  const docH = mask.naturalHeight || mask.height;
  const c = document.createElement("canvas");
  c.width = natW;
  c.height = natH;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, natW, natH);
  const sx = natW / layerBox.width;
  const sy = natH / layerBox.height;
  ctx.globalCompositeOperation = "destination-out";
  ctx.drawImage(mask, -layerBox.x * sx, -layerBox.y * sy, docW * sx, docH * sy);
  ctx.globalCompositeOperation = "source-over";
  return c.toDataURL("image/png");
}

/** Rotate an image 90° clockwise or counter-clockwise → new data URL. */
export async function rotateImage90(src: string, clockwise: boolean): Promise<string> {
  const img = await loadImage(src);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = document.createElement("canvas");
  canvas.width = h;
  canvas.height = w;
  const ctx = canvas.getContext("2d")!;
  if (clockwise) {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/** Build a thumbnail data URL (max edge `max`) from a source image. */
export async function makeThumbnail(
  src: string,
  max = 96,
  /** JPEG where the thumbnail is stored rather than shown once: a gallery of hundreds
   *  of PNG data URLs turns recents.json into megabytes. */
  format: "image/png" | "image/jpeg" = "image/png",
): Promise<string> {
  const img = await loadImage(src);
  const ratio = img.width / img.height;
  const w = ratio >= 1 ? max : Math.round(max * ratio);
  const h = ratio >= 1 ? Math.round(max / ratio) : max;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  if (format === "image/jpeg") {
    // JPEG has no alpha; without this a transparent project renders black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL(format, format === "image/jpeg" ? 0.72 : undefined);
}

/** The gallery's tiles are square. A thumbnail is cut square from the middle of the
 *  picture at this size, so a tile ~240px wide stays sharp on a 2× screen — the old
 *  ones were 280–400px on the LONG side, and a 3:1 panorama came out ~130px tall and was
 *  blown up three times to fill its tile. JPEG: hundreds of them share one file. */
export const GALLERY_THUMB = 480;

export async function makeGalleryThumb(src: string, size = GALLERY_THUMB): Promise<string> {
  const img = await loadImage(src);
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const side = Math.min(iw, ih);
  const out = Math.max(1, Math.min(size, side));
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff"; // JPEG has no alpha; a transparent project would go black
  ctx.fillRect(0, 0, out, out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, out, out);
  return canvas.toDataURL("image/jpeg", 0.84);
}

/** Is this already a square gallery thumbnail at full size? (Older ones are not.) */
export async function isGalleryThumb(src: string | undefined): Promise<boolean> {
  if (!src) return false;
  try {
    const { width, height } = await imageSize(src);
    return width === height && width >= GALLERY_THUMB;
  } catch {
    return false;
  }
}

export async function imageSize(src: string): Promise<{ width: number; height: number }> {
  const img = await loadImage(src);
  return { width: img.width, height: img.height };
}

/**
 * Generative-expand (outpaint) prep: place the source CENTERED on a larger
 * transparent canvas sized to `targetAspect` WITHOUT cropping (only the deficient
 * axis grows). Returns the extended image, a margin mask (white = the new area to
 * generate), the new dims, and the centered content box. Long edge capped to
 * `maxEdge`. Returns null when the source already matches the target aspect.
 */
export async function buildExpand(
  src: string,
  targetAspect: number,
  maxEdge = 4096,
): Promise<null | { extended: string; mask: string; W2: number; H2: number; content: Box }> {
  const img = await loadImage(src);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const srcAspect = sw / sh;
  if (!isFinite(targetAspect) || targetAspect <= 0) return null;
  if (Math.abs(srcAspect - targetAspect) / targetAspect < 0.01) return null; // already there

  // Grow only the deficient axis (keep the source fully visible).
  let W2: number, H2: number;
  if (targetAspect > srcAspect) {
    H2 = sh;
    W2 = Math.round(sh * targetAspect);
  } else {
    W2 = sw;
    H2 = Math.round(sw / targetAspect);
  }
  // Cap the long edge; scale the whole op (and the drawn source) down to match.
  let drawW = sw, drawH = sh;
  const long = Math.max(W2, H2);
  if (long > maxEdge) {
    const k = maxEdge / long;
    W2 = Math.round(W2 * k);
    H2 = Math.round(H2 * k);
    drawW = Math.round(sw * k);
    drawH = Math.round(sh * k);
  }
  const cx = Math.round((W2 - drawW) / 2);
  const cy = Math.round((H2 - drawH) / 2);
  const content: Box = { x: cx, y: cy, w: drawW, h: drawH };

  // Extended image: source centered on transparent margins.
  const ext = document.createElement("canvas");
  ext.width = W2;
  ext.height = H2;
  const ectx = ext.getContext("2d")!;
  ectx.imageSmoothingEnabled = true;
  ectx.imageSmoothingQuality = "high";
  ectx.drawImage(img, cx, cy, drawW, drawH);

  // Margin mask: white everywhere, content box cut to black (white = generate).
  const m = document.createElement("canvas");
  m.width = W2;
  m.height = H2;
  const mctx = m.getContext("2d")!;
  mctx.fillStyle = "#ffffff";
  mctx.fillRect(0, 0, W2, H2);
  mctx.fillStyle = "#000000";
  mctx.fillRect(cx, cy, drawW, drawH);

  return { extended: ext.toDataURL("image/png"), mask: m.toDataURL("image/png"), W2, H2, content };
}

export type ExpandSide = "left" | "right" | "up" | "down";

/** Side → the edge of the returned piece that touches the rest of the original
 *  (the one we feather so it blends in). */
export type InnerEdge = "left" | "right" | "up" | "down";

const EXPAND_MIN_PX = 655360;
const EXPAND_MAX_PX = 8294400;

function snap16(n: number): number {
  return Math.max(256, Math.round(n / 16) * 16);
}

/**
 * Build the outpaint input for ONE side: a CONTEXT STRIP cut from the growing edge
 * of the original plus the new transparent margin — "the piece". The piece is sized
 * to a model-friendly resolution (within the pixel budget, multiple of 16, aspect
 * ≤ 3:1) and rendered AT that resolution, so the engine returns it without changing
 * the dimensions/aspect (no distortion). Returns the request dims, where the piece
 * goes in the grown canvas (`placeBox`, full-res), and which edge to feather.
 */
export async function buildExpandSide(
  comp: string,
  side: ExpandSide,
  marginPx: number,
): Promise<{
  extended: string;
  rw: number;
  rh: number;
  placeBox: Box;
  innerEdge: InnerEdge;
  aspectLabel: string;
}> {
  const img = await loadImage(comp);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const horiz = side === "left" || side === "right";

  // Context strip width: a THIRD of the margin, so the piece is ~¼ kept image and
  // ~¾ new area. This gives the generated margin most of the pixel budget (cheaper,
  // sharper new content) while still providing enough context to continue from. Grow
  // it only if needed so the piece's aspect stays within the engine's 3:1 limit.
  let c = Math.min(horiz ? W : H, Math.max(1, Math.round(marginPx / 3)));
  let ew = horiz ? marginPx + c : W;
  let eh = horiz ? H : marginPx + c;
  if (horiz && eh / ew > 3) {
    c = Math.min(W, Math.ceil(eh / 3) - marginPx);
    ew = marginPx + c;
  } else if (!horiz && ew / eh > 3) {
    c = Math.min(H, Math.ceil(ew / 3) - marginPx);
    eh = marginPx + c;
  }

  // Full-res region this piece will occupy in the GROWN canvas (W+margin on `side`).
  const placeBox: Box =
    side === "left" ? { x: 0, y: 0, w: ew, h: eh }
    : side === "right" ? { x: W - c, y: 0, w: ew, h: eh }
    : side === "up" ? { x: 0, y: 0, w: ew, h: eh }
    : { x: 0, y: H - c, w: ew, h: eh }; // down
  const innerEdge: InnerEdge =
    side === "left" ? "right" : side === "right" ? "left" : side === "up" ? "down" : "up";

  // Request dims: scale the piece into [MIN, MAX] pixels, snap to 16, stay ≤ budget.
  let scale = 1;
  const px = ew * eh;
  if (px > EXPAND_MAX_PX) scale = Math.sqrt(EXPAND_MAX_PX / px);
  else if (px < EXPAND_MIN_PX) scale = Math.sqrt(EXPAND_MIN_PX / px);
  let rw = snap16(ew * scale);
  let rh = snap16(eh * scale);
  while (rw * rh > EXPAND_MAX_PX) {
    if (rw >= rh) rw -= 16;
    else rh -= 16;
  }

  // Render the piece at the REQUEST resolution: a WHITE canvas (the empty area to
  // fill) with the context strip drawn against the seam. No mask — the empty area is
  // simply white, so ANY image model can fill it (no mask-inpaint engine required).
  const kx = rw / ew, ky = rh / eh;
  const e = document.createElement("canvas");
  e.width = rw;
  e.height = rh;
  const ectx = e.getContext("2d")!;
  ectx.imageSmoothingEnabled = true;
  ectx.imageSmoothingQuality = "high";
  ectx.fillStyle = "#ffffff";
  ectx.fillRect(0, 0, rw, rh);
  const mPx = Math.round(marginPx * (horiz ? kx : ky));
  if (side === "left") ectx.drawImage(img, 0, 0, c, H, mPx, 0, rw - mPx, rh);
  else if (side === "right") ectx.drawImage(img, W - c, 0, c, H, 0, 0, rw - mPx, rh);
  else if (side === "up") ectx.drawImage(img, 0, 0, W, c, 0, mPx, rw, rh - mPx);
  else ectx.drawImage(img, 0, H - c, W, c, 0, 0, rw, rh - mPx);

  const g = Math.round(ew), gg = Math.round(eh);
  const aspectLabel = `${g}:${gg}`;
  return { extended: e.toDataURL("image/png"), rw, rh, placeBox, innerEdge, aspectLabel };
}

/**
 * Place the returned piece (regenerated margin + preserved strip) exactly over its
 * source region, feathering only the INNER edge (the one touching the rest of the
 * original) so it blends in. Returns the placed piece + the unfeathered raw so the
 * feather can be re-tuned live.
 */
export async function composeExpandPiece(
  generatedPiece: string,
  innerEdge: InnerEdge,
  box: Box,
  feather: number,
): Promise<{ src: string; box: Box; raw: string }> {
  const gen = await loadImage(generatedPiece);
  const c = document.createElement("canvas");
  c.width = box.w;
  c.height = box.h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(gen, 0, 0, gen.naturalWidth || gen.width, gen.naturalHeight || gen.height, 0, 0, box.w, box.h);
  const raw = c.toDataURL("image/png");
  const src = await featherEdge(raw, innerEdge, feather);
  return { src, box, raw };
}

/**
 * Fade ONE edge of an image to transparent over `feather` px, so it blends into
 * whatever is beneath it at that edge. Used for the expand seam; re-runnable so the
 * feather can be tuned live without re-generating.
 */
export async function featherEdge(rawSrc: string, edge: InnerEdge, feather: number): Promise<string> {
  const img = await loadImage(rawSrc);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const ramp = Math.max(0, Math.round(feather));
  if (ramp > 0) {
    ctx.globalCompositeOperation = "destination-in";
    let grad: CanvasGradient;
    // Opaque in the interior → transparent exactly at the inner edge.
    if (edge === "right") grad = ctx.createLinearGradient(w - ramp, 0, w, 0);
    else if (edge === "left") grad = ctx.createLinearGradient(ramp, 0, 0, 0);
    else if (edge === "down") grad = ctx.createLinearGradient(0, h - ramp, 0, h);
    else grad = ctx.createLinearGradient(0, ramp, 0, 0); // up
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }
  return c.toDataURL("image/png");
}

/**
 * Compose the outpaint result: keep the ORIGINAL center pixel-perfect and take the
 * generated pixels only in the margins, with a feathered seam. `generatedFull` is
 * the engine's full result; `extendedOriginal` is the source centered on
 * transparent margins (from buildExpand).
 */
export async function composeExpand(
  generatedFull: string,
  extendedOriginal: string,
  W2: number,
  H2: number,
  content: Box,
  feather: number,
): Promise<string> {
  const [gen, orig] = await Promise.all([loadImage(generatedFull), loadImage(extendedOriginal)]);
  const c = document.createElement("canvas");
  c.width = W2;
  c.height = H2;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // 1) generated everywhere (resized to the exact extended dims).
  ctx.drawImage(gen, 0, 0, W2, H2);
  // 2) original on top, but only inside a feathered inset of the content box, so
  //    the seam blends and the original center is preserved exactly.
  const tmp = document.createElement("canvas");
  tmp.width = W2;
  tmp.height = H2;
  const tctx = tmp.getContext("2d")!;
  tctx.drawImage(orig, 0, 0);
  tctx.globalCompositeOperation = "destination-in";
  if (feather > 0) tctx.filter = `blur(${feather}px)`;
  tctx.fillStyle = "#fff";
  const f = Math.max(0, feather);
  tctx.fillRect(content.x + f, content.y + f, Math.max(1, content.w - 2 * f), Math.max(1, content.h - 2 * f));
  tctx.filter = "none";
  tctx.globalCompositeOperation = "source-over";
  ctx.drawImage(tmp, 0, 0);
  return c.toDataURL("image/png");
}

/**
 * Scale an image to COVER a W×H frame (preserving aspect) and center-crop the
 * overflow — yielding exactly W×H with no distortion. Used by שינוי פורמט to fit the
 * model's reformatted output to the exact target ratio.
 */
export async function coverImage(src: string, W: number, H: number): Promise<string> {
  const img = await loadImage(src);
  const sw = img.naturalWidth || img.width;
  const sh = img.naturalHeight || img.height;
  const scale = Math.max(W / sw, H / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return c.toDataURL("image/png");
}

/**
 * Downscale an image so its long edge is at most `maxEdge` (default 4096 = "4K").
 * Returns the original src unchanged when it already fits. High-quality resample.
 */
export async function downscaleToMax(
  src: string,
  maxEdge = 4096,
): Promise<{ src: string; width: number; height: number; changed: boolean }> {
  const img = await loadImage(src);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const long = Math.max(w, h);
  if (long <= maxEdge) return { src, width: w, height: h, changed: false };
  const scale = maxEdge / long;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const c = document.createElement("canvas");
  c.width = nw;
  c.height = nh;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, nw, nh);
  return { src: c.toDataURL("image/png"), width: nw, height: nh, changed: true };
}

// ---------------------------------------------------------------------------
// Explanatory markup — drawn on top of a copy of the canvas, purely so the prompt
// assistant can see what the user is pointing at. This composite is never sent to an
// image-generation engine.
// ---------------------------------------------------------------------------

/** Arrow head length as a fraction of the shaft, clamped so short arrows stay legible. */
function arrowHead(len: number, width: number): number {
  return Math.max(width * 2.5, Math.min(len * 0.3, width * 6));
}

/** Draw annotation items onto a 2D context in document coordinates. */
export function drawAnnotations(ctx: CanvasRenderingContext2D, items: Annotation[]): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const a of items) {
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    if (a.kind === "brush") {
      if (a.points.length < 4) continue;
      ctx.lineWidth = a.width;
      ctx.beginPath();
      ctx.moveTo(a.points[0], a.points[1]);
      for (let i = 2; i < a.points.length; i += 2) ctx.lineTo(a.points[i], a.points[i + 1]);
      ctx.stroke();
    } else if (a.kind === "rect") {
      ctx.lineWidth = a.width;
      ctx.strokeRect(a.x, a.y, a.w, a.h);
    } else if (a.kind === "arrow") {
      const dx = a.x2 - a.x1;
      const dy = a.y2 - a.y1;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      ctx.lineWidth = a.width;
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      const h = arrowHead(len, a.width);
      const ang = Math.atan2(dy, dx);
      ctx.beginPath();
      ctx.moveTo(a.x2, a.y2);
      ctx.lineTo(a.x2 - h * Math.cos(ang - Math.PI / 7), a.y2 - h * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(a.x2 - h * Math.cos(ang + Math.PI / 7), a.y2 - h * Math.sin(ang + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    } else if (a.kind === "pin") {
      // Sized from the image, not from a stored width: a pin has to read as a numbered
      // marker whatever the resolution the assistant is shown.
      const r = Math.max(12, Math.round(Math.min(ctx.canvas.width, ctx.canvas.height) * 0.018));
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(2, r * 0.18);
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 ${Math.round(r * 1.1)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(a.n), a.x, a.y + r * 0.06);
      ctx.textAlign = "start";
    } else {
      // Text sits on a translucent plate: a note written straight onto a busy photo is
      // unreadable, and an unreadable note teaches the model nothing.
      ctx.font = `600 ${a.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = "top";
      ctx.direction = /[֐-׿]/.test(a.text) ? "rtl" : "ltr";
      const lines = a.text.split("\n");
      const pad = Math.round(a.size * 0.35);
      const lh = Math.round(a.size * 1.3);
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const boxX = ctx.direction === "rtl" ? a.x - w - pad : a.x - pad;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(boxX, a.y - pad, w + pad * 2, lines.length * lh + pad * 2);
      ctx.fillStyle = a.color;
      lines.forEach((l, i) => ctx.fillText(l, a.x, a.y + i * lh));
    }
  }
  ctx.restore();
}

/** A copy of `src` with the markup drawn on top, at the document's resolution. */
export async function withAnnotations(
  src: string,
  items: Annotation[],
  width: number,
  height: number,
): Promise<string> {
  if (!items.length) return src;
  const img = await loadImage(src);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, width, height);
  drawAnnotations(ctx, items);
  return canvas.toDataURL("image/png");
}

/** Does this image carry real transparency?
 *
 *  Sampled rather than exhaustive: a 4K image is 8M pixels and this runs on the UI
 *  thread when a generation lands. A subject on a removed background has large
 *  transparent regions that a grid of this density cannot miss — but a single stray
 *  semi-transparent pixel can slip through, which is fine for a badge and would not be
 *  fine if anything depended on it for correctness. */
export async function hasTransparency(src: string, samples = 4096): Promise<boolean> {
  const img = await loadImage(src);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return false;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  // A grid, plus the four corners — where a cut-out subject is transparent first.
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / samples)));
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
    if (ctx.getImageData(x, y, 1, 1).data[3] < 255) return true;
  }
  for (let y = 0; y < h; y += step) {
    // One row at a time: far fewer getImageData calls than one per sample.
    const row = ctx.getImageData(0, y, w, 1).data;
    for (let x = 0; x < w; x += step) {
      if (row[x * 4 + 3] < 255) return true;
    }
  }
  return false;
}

/** The canvas background as a fill. A project can be transparent, in which case there
 *  is nothing to paint and the alpha of the layers is what survives. */
export const TRANSPARENT_BG = "transparent";
export function bgFill(backgroundColor: string | undefined): string {
  return !backgroundColor || backgroundColor === TRANSPARENT_BG ? "rgba(0,0,0,0)" : backgroundColor;
}

/** The separate areas of a mask, each as its own doc-sized mask — one erase patch per
 *  object. Areas close enough that their fill padding would overlap come back as one,
 *  since two patches over the same pixels would fight.
 *
 *  Components are found on a ≤1024px proxy (a 4K mask is 16M pixels to walk), then each
 *  group's full-resolution pixels are cut out of the real mask through a slightly grown
 *  stencil — grown so a stroke's soft edge is never clipped by the proxy's coarse grid. */
export async function maskAreas(
  mask: MaskState,
  width: number,
  height: number,
): Promise<{ masks: MaskState[]; boxes: RegionBox[] }> {
  const full = await loadImage(rasterizeMask(mask, width, height));
  const k = Math.min(1, 1024 / Math.max(width, height));
  const pw = Math.max(1, Math.round(width * k));
  const ph = Math.max(1, Math.round(height * k));
  const proxy = document.createElement("canvas");
  proxy.width = pw;
  proxy.height = ph;
  const pctx = proxy.getContext("2d", { willReadFrequently: true })!;
  pctx.drawImage(full, 0, 0, pw, ph);
  const data = pctx.getImageData(0, 0, pw, ph).data;
  const alpha = new Uint8Array(pw * ph);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];

  const { boxes, labels } = labelRegions(alpha, pw, ph);
  const groups = mergeNearby(boxes, Math.max(2, Math.round(24 * k)));
  const GROW = 2; // proxy px

  const masks: MaskState[] = [];
  const outBoxes: RegionBox[] = [];
  for (const members of groups) {
    const ids = new Set(members.map((m) => m + 1));
    const stencil = pctx.createImageData(pw, ph);
    for (let i = 0; i < labels.length; i++) {
      if (!ids.has(labels[i])) continue;
      const x = i % pw;
      const y = (i - x) / pw;
      for (let dy = -GROW; dy <= GROW; dy++) {
        for (let dx = -GROW; dx <= GROW; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < pw && yy < ph) stencil.data[(yy * pw + xx) * 4 + 3] = 255;
        }
      }
    }
    const sc = document.createElement("canvas");
    sc.width = pw;
    sc.height = ph;
    sc.getContext("2d")!.putImageData(stencil, 0, 0);

    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const octx = out.getContext("2d")!;
    octx.drawImage(full, 0, 0);
    octx.globalCompositeOperation = "destination-in";
    octx.drawImage(sc, 0, 0, width, height);
    masks.push({ strokes: [], rects: [], bitmaps: [out], inverted: false });

    const x0 = Math.min(...members.map((m) => boxes[m].x));
    const y0 = Math.min(...members.map((m) => boxes[m].y));
    const x1 = Math.max(...members.map((m) => boxes[m].x + boxes[m].w));
    const y1 = Math.max(...members.map((m) => boxes[m].y + boxes[m].h));
    outBoxes.push({ x: Math.floor(x0 / k), y: Math.floor(y0 / k), w: Math.ceil((x1 - x0) / k), h: Math.ceil((y1 - y0) / k) });
  }
  return { masks, boxes: outBoxes };
}

/** The image with the erase areas painted over it — what an engine without masks is shown
 *  so it knows what to remove. Opaque-ish on purpose: a faint tint over a busy photo is
 *  easy for a model to read as part of the picture. */
export async function paintMarks(src: string, maskUrl: string, width: number, height: number): Promise<string> {
  const [img, m] = await Promise.all([loadImage(src), loadImage(maskUrl)]);
  const tint = document.createElement("canvas");
  tint.width = width;
  tint.height = height;
  const t = tint.getContext("2d")!;
  t.drawImage(m, 0, 0, width, height);
  t.globalCompositeOperation = "source-in";
  t.fillStyle = "rgb(255,86,48)";
  t.fillRect(0, 0, width, height);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const o = out.getContext("2d")!;
  o.drawImage(img, 0, 0, width, height);
  o.globalAlpha = 0.85;
  o.drawImage(tint, 0, 0);
  return out.toDataURL("image/png");
}

/** White where the rectangle is, transparent elsewhere — a "keep" mask at a given size. */
export function rectMaskUrl(w: number, h: number, r: Box): string {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  return c.toDataURL("image/png");
}

/** One rectangle of an image, pixel for pixel. */
export async function cropImage(src: string, r: Box): Promise<string> {
  const img = await loadImage(src);
  const c = document.createElement("canvas");
  c.width = Math.round(r.w);
  c.height = Math.round(r.h);
  c.getContext("2d")!.drawImage(img, crisp(r.x), crisp(r.y), c.width, c.height, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

/** The photo at full size with a patch laid into it at `r` (its own pixels, unscaled). */
export async function pasteInto(baseSrc: string, patchSrc: string, r: Box, width: number, height: number): Promise<string> {
  const [base, patch] = await Promise.all([loadImage(baseSrc), loadImage(patchSrc)]);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(base, 0, 0, width, height);
  ctx.drawImage(patch, crisp(r.x), crisp(r.y), crisp(r.w), crisp(r.h));
  return c.toDataURL("image/png");
}
