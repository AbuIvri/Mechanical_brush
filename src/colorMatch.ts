/**
 * Colour matching for a generated patch against the image it was made from.
 *
 * A model returns the crop it was sent with a colour drift on top: measured on real
 * fills, OpenAI's raise saturation by ~19% and contrast by ~6% even where nothing was
 * meant to change. The drift is measured on the context the model was told to keep
 * (the pixels outside the edit mask) and undone across the whole patch, the edited
 * part included.
 *
 * The correction is one affine colour transform (a 3×3 matrix plus an offset), which
 * is what saturation, contrast, brightness and a colour cast all are. The matrix maps
 * the colour spread of the output's context onto the source's (a linear Monge–
 * Kantorovich match of the two covariances). Matching distributions, not individual
 * pixels, matters here: a pixel-by-pixel least-squares fit on images that are a pixel
 * or two out of register shrinks its slope, and it took contrast down by 8% on real
 * pairs. A coarse field of offsets on top takes up drift that differs across the patch.
 *
 * It only acts when it helps: the fit is first made on half the context and scored on
 * the other half, and is dropped when it does not clearly beat leaving the patch alone.
 * Some providers return the untouched area exactly (Ideogram); there, any correction
 * could only add error, and the check leaves those patches as they are.
 *
 * Pure: pixel arrays in, pixel arrays out. The caller samples the images.
 */

export interface ColorFit {
  /** Rows r, g, b: [kr, kg, kb, offset], on values scaled 0..1. */
  m: number[][];
  /** Per-cell residual offsets (0..1 units), `grid`×`grid`; empty when global. */
  offsets: number[][];
  grid: number;
  /** Context pixels the fit rests on, after the robust pass. */
  inliers: number;
}

const GRID = 4;
const MIN_PIXELS = 200;
const CELL_SHRINK = 60; // pixels at which a cell's own offset counts half
const MIN_DRIFT = 1.5 / 255; // median error below this: nothing worth correcting
const MUST_IMPROVE = 0.9; // the held-out error has to fall at least 10%
// A rectangle selection is sent exactly as drawn, so its mask covers the whole crop and
// leaves nothing "outside" to measure from. Then the crop's outer band stands in for the
// context: it is where the patch meets the untouched photo, so it is what has to match.
const MIN_CONTEXT_SHARE = 0.1;
const EDGE_BAND = 0.06; // of the short side

type Mat3 = number[][];
const I3 = (): Mat3 => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mul = (A: Mat3, B: Mat3): Mat3 =>
  A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));

/** Eigen-decomposition of a symmetric 3×3 matrix (cyclic Jacobi). */
function eigSym(S: Mat3): { vals: number[]; vecs: Mat3 } {
  const a = S.map((r) => r.slice());
  const v = I3();
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { vals: [a[0][0], a[1][1], a[2][2]], vecs: v };
}

/** S^pow for a symmetric positive-definite S. */
function powSym(S: Mat3, pow: number): Mat3 {
  const { vals, vecs } = eigSym(S);
  const d = vals.map((x) => Math.max(x, 1e-9) ** pow);
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => vecs[i][0] * d[0] * vecs[j][0] + vecs[i][1] * d[1] * vecs[j][1] + vecs[i][2] * d[2] * vecs[j][2]));
}

/** 3×3 box blur on RGB, so a pixel or two of misalignment does not read as a colour change. */
function blur(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = r / n / 255; out[o + 1] = g / n / 255; out[o + 2] = b / n / 255;
    }
  return out;
}

/** Affine transform taking the colour distribution of `mov` onto `ref` over `use`. */
function fitAffine(mov: Float32Array, ref: Float32Array, use: Uint8Array): number[][] | null {
  let n = 0;
  const mm = [0, 0, 0], mr = [0, 0, 0];
  for (let p = 0; p < use.length; p++) {
    if (!use[p]) continue;
    for (let c = 0; c < 3; c++) { mm[c] += mov[p * 3 + c]; mr[c] += ref[p * 3 + c]; }
    n++;
  }
  if (n < MIN_PIXELS) return null;
  for (let c = 0; c < 3; c++) { mm[c] /= n; mr[c] /= n; }
  const Sm: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Sr: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let p = 0; p < use.length; p++) {
    if (!use[p]) continue;
    const o = p * 3;
    for (let i = 0; i < 3; i++)
      for (let j = i; j < 3; j++) {
        Sm[i][j] += (mov[o + i] - mm[i]) * (mov[o + j] - mm[j]);
        Sr[i][j] += (ref[o + i] - mr[i]) * (ref[o + j] - mr[j]);
      }
  }
  // A small floor keeps a flat context (a plain sky) from dividing by its own noise.
  const eps = 4e-5;
  for (let i = 0; i < 3; i++)
    for (let j = i; j < 3; j++) {
      Sm[i][j] = Sm[i][j] / n + (i === j ? eps : 0); Sm[j][i] = Sm[i][j];
      Sr[i][j] = Sr[i][j] / n + (i === j ? eps : 0); Sr[j][i] = Sr[i][j];
    }
  const h = powSym(Sm, 0.5), hi = powSym(Sm, -0.5);
  const T = mul(mul(hi, powSym(mul(mul(h, Sr), h), 0.5)), hi);
  const m = [0, 1, 2].map((c) => [...T[c], mr[c] - (T[c][0] * mm[0] + T[c][1] * mm[1] + T[c][2] * mm[2])]);
  // Keep it a colour correction, not a re-grade.
  for (let c = 0; c < 3; c++)
    for (let k = 0; k < 4; k++) {
      const [lo, hi2] = k === 3 ? [-0.3, 0.3] : k === c ? [0.6, 1.5] : [-0.35, 0.35];
      m[c][k] = Math.min(hi2, Math.max(lo, m[c][k]));
    }
  return m;
}

const applyM = (m: number[][], r: number, g: number, b: number, c: number) =>
  m[c][0] * r + m[c][1] * g + m[c][2] * b + m[c][3];

function errAt(m: number[][] | null, mov: Float32Array, ref: Float32Array, p: number): number {
  const o = p * 3;
  let e = 0;
  for (let c = 0; c < 3; c++) {
    const v = m ? applyM(m, mov[o], mov[o + 1], mov[o + 2], c) : mov[o + c];
    e += (v - ref[o + c]) ** 2;
  }
  return Math.sqrt(e);
}

function medianErr(m: number[][] | null, mov: Float32Array, ref: Float32Array, use: Uint8Array): number {
  const e: number[] = [];
  for (let p = 0; p < use.length; p++) if (use[p]) e.push(errAt(m, mov, ref, p));
  e.sort((a, b) => a - b);
  return e.length ? e[e.length >> 1] : 0;
}

/** First fit, then refit without the pixels it cannot explain (content that moved). */
function robustFit(mov: Float32Array, ref: Float32Array, use: Uint8Array): { m: number[][]; use: Uint8Array } | null {
  const m0 = fitAffine(mov, ref, use);
  if (!m0) return null;
  const cut = Math.max(6 / 255, 2.5 * medianErr(m0, mov, ref, use));
  const kept = new Uint8Array(use.length);
  for (let p = 0; p < use.length; p++) kept[p] = use[p] && errAt(m0, mov, ref, p) <= cut ? 1 : 0;
  const m1 = fitAffine(mov, ref, kept);
  return m1 ? { m: m1, use: kept } : { m: m0, use };
}

/**
 * Fit the drift from `mov` (the model's output) back to `ref` (what was sent), both
 * sampled to the same `w`×`h`. `exclude` (alpha > 16) marks the edited region, which is
 * meant to differ and is left out; when it covers (almost) the whole crop, the crop's
 * outer band is used instead. Returns null when there is nothing to correct, or
 * when correcting would not clearly help.
 */
export function fitColorMatch(
  mov: Uint8ClampedArray,
  ref: Uint8ClampedArray,
  w: number,
  h: number,
  exclude: Uint8ClampedArray | null,
  local: boolean,
): ColorFit | null {
  const bm = blur(mov, w, h);
  const br = blur(ref, w, h);
  const use = new Uint8Array(w * h);
  const band = Math.max(3, Math.round(Math.min(w, h) * EDGE_BAND));
  let context = 0;
  if (exclude) for (let p = 0; p < w * h; p++) if (exclude[p * 4 + 3] <= 16) context++;
  const edgeOnly = !!exclude && context < MIN_CONTEXT_SHARE * w * h;
  for (let p = 0; p < w * h; p++) {
    if (edgeOnly) {
      const x = p % w, y = (p / w) | 0;
      if (x >= band && y >= band && x < w - band && y < h - band) continue;
    } else if (exclude && exclude[p * 4 + 3] > 16) continue;
    if (mov[p * 4 + 3] < 250 || ref[p * 4 + 3] < 250) continue;
    const o = p * 3;
    let clipped = false; // clipped pixels have lost what a linear match needs
    for (let c = 0; c < 3; c++) {
      const a = bm[o + c], b = br[o + c];
      if (a > 0.99 || a < 0.01 || b > 0.99 || b < 0.01) clipped = true;
    }
    if (!clipped) use[p] = 1;
  }

  // Is there drift, and does a fit made on half the context reduce it on the other half?
  const before = medianErr(null, bm, br, use);
  if (before < MIN_DRIFT) return null;
  const halfA = new Uint8Array(w * h), halfB = new Uint8Array(w * h);
  const B = 16; // blocks, so the halves are not neighbouring pixels of each other
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!use[p]) continue;
      if ((((x / B) | 0) + ((y / B) | 0)) % 2) halfB[p] = 1; else halfA[p] = 1;
    }
  const trial = robustFit(bm, br, halfA);
  if (!trial) return null;
  if (medianErr(trial.m, bm, br, halfB) > MUST_IMPROVE * medianErr(null, bm, br, halfB)) return null;

  const fit = robustFit(bm, br, use);
  if (!fit) return null;
  const { m } = fit;
  let inliers = 0;
  for (let p = 0; p < w * h; p++) if (fit.use[p]) inliers++;

  let offsets: number[][] = [];
  if (local) {
    const sum = Array.from({ length: GRID * GRID }, () => [0, 0, 0]);
    const cnt = new Array(GRID * GRID).fill(0);
    for (let y = 0; y < h; y++) {
      const gy = Math.min(GRID - 1, ((y / h) * GRID) | 0);
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!fit.use[p]) continue;
        const ci = gy * GRID + Math.min(GRID - 1, ((x / w) * GRID) | 0);
        const o = p * 3;
        for (let c = 0; c < 3; c++) sum[ci][c] += br[o + c] - applyM(m, bm[o], bm[o + 1], bm[o + 2], c);
        cnt[ci]++;
      }
    }
    offsets = sum.map((s, ci) =>
      s.map((v) => {
        if (!cnt[ci]) return 0;
        const shrunk = (v / cnt[ci]) * (cnt[ci] / (cnt[ci] + CELL_SHRINK));
        return Math.min(0.12, Math.max(-0.12, shrunk));
      }),
    );
  }
  return { m, offsets, grid: local ? GRID : 0, inliers };
}

/** Apply a fit to RGBA pixels in place. `strength` 0..1 blends from none to full. */
export function applyColorFit(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  fit: ColorFit,
  strength: number,
): void {
  const k = Math.max(0, Math.min(1, strength));
  const G = fit.grid;
  const offAt = (x: number, y: number, c: number): number => {
    if (!G) return 0;
    const fx = Math.max(0, Math.min(G - 1.001, (x / w) * G - 0.5));
    const fy = Math.max(0, Math.min(G - 1.001, (y / h) * G - 0.5));
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = Math.min(G - 1, x0 + 1), y1 = Math.min(G - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const o = fit.offsets;
    return (
      o[y0 * G + x0][c] * (1 - tx) * (1 - ty) + o[y0 * G + x1][c] * tx * (1 - ty) +
      o[y1 * G + x0][c] * (1 - tx) * ty + o[y1 * G + x1][c] * tx * ty
    );
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const tr = applyM(fit.m, r, g, b, 0) + offAt(x, y, 0);
      const tg = applyM(fit.m, r, g, b, 1) + offAt(x, y, 1);
      const tb = applyM(fit.m, r, g, b, 2) + offAt(x, y, 2);
      // Uint8ClampedArray clamps and rounds.
      d[i] = (r + k * (tr - r)) * 255;
      d[i + 1] = (g + k * (tg - g)) * 255;
      d[i + 2] = (b + k * (tb - b)) * 255;
    }
}
