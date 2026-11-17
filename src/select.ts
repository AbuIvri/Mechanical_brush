// Smart selection: magic wand (instant, pure JS) + AI segments (MediaPipe,
// loaded lazily at runtime from local files in public/ — never via the bundler,
// never from the network). Both produce doc-sized selection canvases whose
// alpha channel is the selection (consumed by MaskState.bitmaps).

import { flattenLayers } from "./compositing";
import type { Layer } from "../shared/types";

const SELECT_TINT = { r: 80, g: 140, b: 255 }; // matches the rect-selection blue
const PROXY_EDGE = 1024;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("טעינת תמונה נכשלה"));
    img.src = src;
  });
}

export interface WandProxy {
  data: ImageData;
  w: number;
  h: number;
  scale: number; // proxy px per doc px (within the box)
  docW: number;
  docH: number;
  /** The doc-space region this proxy covers (the active layer's box). Proxying
   *  just the box — not the whole canvas — is what lets the AI models see the
   *  layer's content full-frame instead of a thumbnail in transparent padding. */
  box: { x: number; y: number; w: number; h: number };
}

/** Render the given layers and proxy the `box` region for fast pixel ops. */
export async function buildSelectProxy(
  layers: Layer[],
  docW: number,
  docH: number,
  background: string,
  box?: { x: number; y: number; w: number; h: number },
): Promise<WandProxy> {
  const b = box ?? { x: 0, y: 0, w: docW, h: docH };
  const flat = await flattenLayers(layers, docW, docH, background);
  const img = await loadImage(flat);
  const scale = Math.min(1, PROXY_EDGE / Math.max(b.w, b.h));
  const w = Math.max(1, Math.round(b.w * scale));
  const h = Math.max(1, Math.round(b.h * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, b.x, b.y, b.w, b.h, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h), w, h, scale, docW, docH, box: b };
}

/**
 * Magic wand: contiguous flood fill from (x,y) — proxy coords — selecting
 * pixels whose color is within `tolerance` (0–100) of the clicked color.
 */
export function floodSelect(proxy: WandProxy, x: number, y: number, tolerance: number): Uint8Array {
  const { data, w, h } = proxy;
  const d = data.data;
  const sel = new Uint8Array(w * h);
  const sx = Math.max(0, Math.min(w - 1, Math.round(x)));
  const sy = Math.max(0, Math.min(h - 1, Math.round(y)));
  const si = sy * w + sx;
  if (d[si * 4 + 3] < 10) return sel; // clicked a transparent spot — nothing to select
  const r0 = d[si * 4], g0 = d[si * 4 + 1], b0 = d[si * 4 + 2];
  const t = tolerance * 2.55;
  const thr = t * t * 3;
  const stack = [si];
  sel[si] = 255;
  while (stack.length) {
    const i = stack.pop()!;
    const ix = i % w;
    const iy = (i / w) | 0;
    const neighbors = [
      ix > 0 ? i - 1 : -1,
      ix < w - 1 ? i + 1 : -1,
      iy > 0 ? i - w : -1,
      iy < h - 1 ? i + w : -1,
    ];
    for (const n of neighbors) {
      if (n < 0 || sel[n]) continue;
      if (d[n * 4 + 3] < 10) continue; // never cross into transparency (layer bounds)
      const dr = d[n * 4] - r0;
      const dg = d[n * 4 + 1] - g0;
      const db = d[n * 4 + 2] - b0;
      if (dr * dr + dg * dg + db * db <= thr) {
        sel[n] = 255;
        stack.push(n);
      }
    }
  }
  return sel;
}

/** Keep only selected pixels where the proxy itself is opaque (layer bounds). */
export function intersectWithAlpha(sel: Uint8Array, proxy: WandProxy, w: number, h: number): Uint8Array {
  // sel may be at a different resolution than the proxy — sample proportionally.
  const d = proxy.data.data;
  const out = new Uint8Array(sel.length);
  for (let y = 0; y < h; y++) {
    const py = Math.min(proxy.h - 1, Math.round((y / h) * proxy.h));
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!sel[i]) continue;
      const px = Math.min(proxy.w - 1, Math.round((x / w) * proxy.w));
      if (d[(py * proxy.w + px) * 4 + 3] >= 10) out[i] = 255;
    }
  }
  return out;
}

/** Convert a proxy-resolution selection to a doc-sized tinted canvas (alpha = selection),
 *  placed at the proxy's box position. */
export function selectionToCanvas(sel: Uint8Array, proxy: WandProxy): HTMLCanvasElement {
  const { w, h, docW, docH, box } = proxy;
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d")!;
  const im = sctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    if (sel[i]) {
      im.data[i * 4] = SELECT_TINT.r;
      im.data[i * 4 + 1] = SELECT_TINT.g;
      im.data[i * 4 + 2] = SELECT_TINT.b;
      im.data[i * 4 + 3] = 255;
    }
  }
  sctx.putImageData(im, 0, 0);
  const doc = document.createElement("canvas");
  doc.width = docW;
  doc.height = docH;
  const dctx = doc.getContext("2d")!;
  dctx.imageSmoothingEnabled = true;
  dctx.drawImage(small, box.x, box.y, box.w, box.h); // upscale into the box → soft 1px edge
  return doc;
}

// ---------- AI segments (MediaPipe Image Segmenter, fully local) ----------

export const SEGMENT_CLASSES: { id: number; he: string }[] = [
  { id: 0, he: "רקע" },
  { id: 1, he: "שיער" },
  { id: 2, he: "גוף" },
  { id: 3, he: "פנים" },
  { id: 4, he: "בגדים" },
  { id: 5, he: "אחר" },
];

let segmenterPromise: Promise<any> | null = null;
let visionModPromise: Promise<any> | null = null;
let interactivePromise: Promise<any> | null = null;

function loadVisionModule(): Promise<any> {
  if (!visionModPromise) {
    const base = new URL(".", document.baseURI).href;
    visionModPromise = import(/* @vite-ignore */ `${base}mediapipe/vision_bundle.mjs`).catch((e) => {
      visionModPromise = null;
      throw e;
    });
  }
  return visionModPromise;
}

/** Click-to-select-an-element segmenter (MediaPipe "magic touch"), local files. */
export function loadInteractiveSegmenter(): Promise<any> {
  if (!interactivePromise) {
    interactivePromise = (async () => {
      const base = new URL(".", document.baseURI).href;
      const mod = await loadVisionModule();
      const fileset = await mod.FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
      return mod.InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/magic_touch.tflite` },
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })().catch((e) => {
      interactivePromise = null;
      throw e;
    });
  }
  return interactivePromise;
}

/** Select the single element at (x,y) — proxy coords. Returns selection + its dims. */
export async function elementSelectAt(
  proxy: WandProxy,
  x: number,
  y: number,
): Promise<{ sel: Uint8Array; w: number; h: number }> {
  const seg = await loadInteractiveSegmenter();
  const c = document.createElement("canvas");
  c.width = proxy.w;
  c.height = proxy.h;
  c.getContext("2d")!.putImageData(proxy.data, 0, 0);
  const res = seg.segment(c, { keypoint: { x: x / proxy.w, y: y / proxy.h } });
  const mask = res.categoryMask;
  const cats = new Uint8Array(mask.getAsUint8Array());
  const mw = mask.width as number;
  const mh = mask.height as number;
  res.close();
  // Category mask: non-zero where the clicked object is. Some model versions
  // invert this — if the "selection" covers most of the frame, flip it.
  let sel: Uint8Array = new Uint8Array(mw * mh);
  let on = 0;
  for (let i = 0; i < sel.length; i++) {
    if (cats[i] > 0) {
      sel[i] = 255;
      on++;
    }
  }
  if (on > sel.length * 0.55) {
    for (let i = 0; i < sel.length; i++) sel[i] = sel[i] ? 0 : 255;
  }
  // Confine to layer pixels and to the proxy frame.
  sel = intersectWithAlpha(sel, proxy, mw, mh);
  return { sel, w: mw, h: mh };
}

/** Lazy-load MediaPipe vision (local files under public/mediapipe + public/models).
 *  Runtime URL import — the bundler never sees it (lesson learned from opencv). */
export function loadSegmenter(): Promise<any> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const base = new URL(".", document.baseURI).href;
      const mod = await loadVisionModule();
      const fileset = await mod.FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
      const segmenter = await mod.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${base}models/selfie_multiclass_256x256.tflite` },
        runningMode: "IMAGE",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
      return segmenter;
    })().catch((e) => {
      segmenterPromise = null; // allow retry
      throw e;
    });
  }
  return segmenterPromise;
}

export interface SegmentResult {
  categories: Uint8Array; // class id per proxy pixel
  w: number;
  h: number;
}

/** Run the segmenter on the proxy image. ~50–200ms after the one-time load. */
export async function segmentProxy(proxy: WandProxy): Promise<SegmentResult> {
  const segmenter = await loadSegmenter();
  const c = document.createElement("canvas");
  c.width = proxy.w;
  c.height = proxy.h;
  c.getContext("2d")!.putImageData(proxy.data, 0, 0);
  const res = segmenter.segment(c);
  const mask = res.categoryMask;
  const cats = new Uint8Array(mask.getAsUint8Array()); // copy before close
  const out: SegmentResult = { categories: cats, w: mask.width, h: mask.height };
  res.close();
  return out;
}

/** Build a doc-sized selection canvas from one or more segment class ids. */
export function segmentsToCanvas(seg: SegmentResult, classIds: number[], proxy: WandProxy): HTMLCanvasElement {
  const wanted = new Set(classIds);
  let sel: Uint8Array = new Uint8Array(seg.w * seg.h);
  for (let i = 0; i < sel.length; i++) if (wanted.has(seg.categories[i])) sel[i] = 255;
  sel = intersectWithAlpha(sel, proxy, seg.w, seg.h); // confine to the layer's pixels
  // segment mask may differ from proxy dims — reuse selectionToCanvas via a shim proxy
  const shim: WandProxy = { ...proxy, w: seg.w, h: seg.h };
  return selectionToCanvas(sel, shim);
}

/** Doc-sized canvas from an element selection (proxy/mask-res Uint8Array). */
export function elementToCanvas(sel: Uint8Array, w: number, h: number, proxy: WandProxy): HTMLCanvasElement {
  const shim: WandProxy = { ...proxy, w, h };
  return selectionToCanvas(sel, shim);
}
