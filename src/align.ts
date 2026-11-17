// Lightweight image registration (alignment), pure JS — no wasm, no runtime load.
//
// Why: AI engines re-render content and return results with small geometric drift
// (a few px shift + slight scale) vs the source. For generative fill and upscale the
// result must sit *exactly* on the layer beneath it, or masks/blends ghost. After
// aspect-conform (center-crop) the residual is small, so we estimate a uniform
// scale + translation by normalized cross-correlation on tiny grayscale proxies,
// then warp the full-res image with the canvas 2D transform (GPU). On a weak match
// we return the input unchanged (never warp on a bad estimate).

export interface Gray {
  data: Float32Array;
  w: number;
  h: number;
}

export interface Similarity {
  scale: number;
  dx: number; // common-proxy pixels (reference frame)
  dy: number;
  rot: number; // radians (0 unless rotation search enabled)
  score: number; // normalized cross-correlation [-1, 1]
}

/** 2×3 affine, row-major: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface AffineMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY_MATRIX: AffineMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export interface AlignResult {
  src: string;
  ok: boolean;
  score: number;
  /** Similarity transform in the REFERENCE-full pixel frame (scale + translation;
   *  rotation only if allowRotation produced one). Identity when ok is false. */
  matrix: AffineMatrix;
}

const COARSE_EDGE = 160;
const REFINE_EDGE = 360;
const COARSE_SHIFT_FRAC = 0.08;
const COARSE_SCALES = [0.96, 0.98, 1.0, 1.02, 1.04];
const MIN_SCORE = 0.35;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("טעינת תמונה ליישור נכשלה"));
    img.src = src;
  });
}

/** Draw an image to a w×h grayscale buffer (resampled to exactly those dims). */
function grayFromImage(img: HTMLImageElement, w: number, h: number): Gray {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const data = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    data[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  return { data, w, h };
}

function proxyDims(iw: number, ih: number, longEdge: number): { w: number; h: number } {
  const s = Math.min(1, longEdge / Math.max(iw, ih));
  return { w: Math.max(1, Math.round(iw * s)), h: Math.max(1, Math.round(ih * s)) };
}

/** Bilinear sample of a Gray buffer (edge-clamped). */
function sample(g: Gray, x: number, y: number): number {
  if (x < 0) x = 0;
  else if (x > g.w - 1) x = g.w - 1;
  if (y < 0) y = 0;
  else if (y > g.h - 1) y = g.h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, g.w - 1);
  const y1 = Math.min(y0 + 1, g.h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = g.data[y0 * g.w + x0];
  const b = g.data[y0 * g.w + x1];
  const c = g.data[y1 * g.w + x0];
  const d = g.data[y1 * g.w + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/**
 * Estimate a uniform scale + translation mapping `mov` onto `ref` (same dims) by
 * maximizing normalized cross-correlation. Pure (no DOM) — unit-testable.
 * Model: ref(X,Y) ≈ mov(X/s - dx, Y/s - dy). Searches scale × (dx,dy) around an
 * optional center; NCC is taken over an inner window (margin avoids edge effects).
 */
export function estimateSimilarity(
  ref: Gray,
  mov: Gray,
  opts: {
    scales?: number[];
    maxShift?: number;
    step?: number;
    center?: { dx: number; dy: number };
    /** Per-pixel weights in the REFERENCE frame (0..1, same dims as ref). Pixels
     *  with weight ~0 are ignored — used to exclude the edited/generated region so
     *  alignment leans on stable surrounding context only. */
    weight?: Float32Array;
    /** Rotation angles to search, in radians (default [0] = none). */
    rotations?: number[];
  } = {},
): Similarity {
  const scales = opts.scales ?? COARSE_SCALES;
  const rotations = opts.rotations ?? [0];
  const maxShift = opts.maxShift ?? Math.round(Math.max(ref.w, ref.h) * COARSE_SHIFT_FRAC);
  const step = opts.step ?? 1;
  const cx = opts.center?.dx ?? 0;
  const cy = opts.center?.dy ?? 0;
  const W = opts.weight;
  const margin = Math.floor(Math.min(ref.w, ref.h) * 0.15) + maxShift + Math.ceil(Math.abs(cx) + Math.abs(cy));
  const x0 = margin;
  const x1 = ref.w - margin;
  const y0 = margin;
  const y1 = ref.h - margin;
  if (x1 <= x0 || y1 <= y0) return { scale: 1, dx: 0, dy: 0, rot: 0, score: 0 };

  // Weighted reference mean (and total weight) over the inner window.
  const cxw = (ref.w - 1) / 2;
  const cyw = (ref.h - 1) / 2;
  let rSum = 0;
  let wSum = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const w = W ? W[y * ref.w + x] : 1;
      rSum += ref.data[y * ref.w + x] * w;
      wSum += w;
    }
  if (wSum < 1e-3) return { scale: 1, dx: cx, dy: cy, rot: 0, score: 0 };
  const rMean = rSum / wSum;

  let best: Similarity = { scale: 1, dx: cx, dy: cy, rot: 0, score: -Infinity };
  for (const rot of rotations) {
    const cosA = Math.cos(rot);
    const sinA = Math.sin(rot);
    for (const s of scales) {
      for (let ldy = -maxShift; ldy <= maxShift; ldy += step) {
        const dy = cy + ldy;
        for (let ldx = -maxShift; ldx <= maxShift; ldx += step) {
          const dx = cx + ldx;
          // Pass 1: weighted moving mean over the (rotated/scaled/shifted) sample.
          let mSum = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const w = W ? W[y * ref.w + x] : 1;
              if (w === 0) continue;
              // rotate about the image center, then scale, then translate
              const rx = (x - cxw) * cosA - (y - cyw) * sinA + cxw;
              const ry = (x - cxw) * sinA + (y - cyw) * cosA + cyw;
              mSum += sample(mov, rx / s - dx, ry / s - dy) * w;
            }
          }
          const mMean = mSum / wSum;
          // Pass 2: weighted NCC.
          let num = 0, rVar = 0, mVar = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const w = W ? W[y * ref.w + x] : 1;
              if (w === 0) continue;
              const rx = (x - cxw) * cosA - (y - cyw) * sinA + cxw;
              const ry = (x - cxw) * sinA + (y - cyw) * cosA + cyw;
              const rv = ref.data[y * ref.w + x] - rMean;
              const mv = sample(mov, rx / s - dx, ry / s - dy) - mMean;
              num += w * rv * mv;
              rVar += w * rv * rv;
              mVar += w * mv * mv;
            }
          }
          const score = num / (Math.sqrt(rVar * mVar) || 1e-9);
          if (score > best.score) best = { scale: s, dx, dy, rot, score };
        }
      }
    }
  }
  return best;
}

/**
 * Register `moving` onto `reference` and return `moving` warped into the
 * reference's pixel frame (uniform scale + translation). On a weak match, returns
 * `moving` unchanged with `ok:false`.
 */
export async function alignToReference(
  moving: string,
  reference: string,
  opts: { minScore?: number; excludeMask?: string; allowRotation?: boolean } = {},
): Promise<AlignResult> {
  const minScore = opts.minScore ?? MIN_SCORE;
  try {
    const movImg = await loadImage(moving);
    const refImg = await loadImage(reference);
    const refW = refImg.naturalWidth || refImg.width;
    const refH = refImg.naturalHeight || refImg.height;
    const movW = movImg.naturalWidth || movImg.width;

    // Mask-weighting: build a REFERENCE-frame weight buffer where the edited region
    // (white in the mask) is ~0, so alignment uses only the stable surrounding
    // context and never relies on the generated content itself.
    const maskImg = opts.excludeMask ? await loadImage(opts.excludeMask) : null;
    const weightAt = (w: number, h: number): Float32Array | undefined => {
      if (!maskImg) return undefined;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d")!;
      x.drawImage(maskImg, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data;
      const out = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) out[i] = 1 - d[i * 4 + 3] / 255; // alpha = edited
      return out;
    };

    // Common proxy frames sized to the REFERENCE; moving is resampled to match,
    // so the estimated dx/dy live in one shared coordinate frame.
    const cp = proxyDims(refW, refH, COARSE_EDGE);
    const refC = grayFromImage(refImg, cp.w, cp.h);
    const movC = grayFromImage(movImg, cp.w, cp.h);
    const coarse = estimateSimilarity(refC, movC, { weight: weightAt(cp.w, cp.h) });

    const rp = proxyDims(refW, refH, REFINE_EDGE);
    const refR = grayFromImage(refImg, rp.w, rp.h);
    const movR = grayFromImage(movImg, rp.w, rp.h);
    const up = rp.w / cp.w; // coarse → refine proxy ratio
    const rotations = opts.allowRotation
      ? [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((d) => (d * Math.PI) / 180)
      : [0];
    const fine = estimateSimilarity(refR, movR, {
      scales: [coarse.scale - 0.01, coarse.scale, coarse.scale + 0.01],
      maxShift: Math.max(2, Math.round(up) + 1),
      step: 1,
      center: { dx: coarse.dx * up, dy: coarse.dy * up },
      weight: weightAt(rp.w, rp.h),
      rotations,
    });

    if (!isFinite(fine.score) || fine.score < minScore) {
      console.warn("[align] weak match (score", fine.score?.toFixed?.(2), ") → unaligned");
      return { src: moving, ok: false, score: isFinite(fine.score) ? fine.score : 0, matrix: { ...IDENTITY_MATRIX } };
    }

    // Proxy → full-res. canvas: x' = S*x + tx (in reference-full px).
    const k = refW / rp.w; // refine-proxy → reference-full
    const Sdraw = fine.scale * (refW / movW); // rescales moving-full → reference size
    const tx = fine.scale * fine.dx * k;
    const ty = fine.scale * fine.dy * k;

    // Residual similarity in the REFERENCE-full frame (what callers store/apply
    // non-destructively). Scale = fine.scale (residual only, not the resample),
    // rotation about the reference center.
    const cosA = Math.cos(fine.rot);
    const sinA = Math.sin(fine.rot);
    const matrix: AffineMatrix = {
      a: fine.scale * cosA,
      b: fine.scale * sinA,
      c: -fine.scale * sinA,
      d: fine.scale * cosA,
      e: tx,
      f: ty,
    };

    // Warped src kept for preview / back-compat callers.
    const out = document.createElement("canvas");
    out.width = refW;
    out.height = refH;
    const ctx = out.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (fine.rot) {
      ctx.translate(refW / 2, refH / 2);
      ctx.rotate(fine.rot);
      ctx.translate(-refW / 2, -refH / 2);
    }
    ctx.setTransform(Sdraw, 0, 0, Sdraw, tx, ty);
    ctx.drawImage(movImg, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { src: out.toDataURL("image/png"), ok: true, score: fine.score, matrix };
  } catch (e) {
    console.warn("[align] failed → unaligned", e);
    return { src: moving, ok: false, score: 0, matrix: { ...IDENTITY_MATRIX } };
  }
}
