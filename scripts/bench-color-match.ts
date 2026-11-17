/**
 * Offline benchmark for fill colour matching, on the SENT/OUT pairs the app dumps to
 * <userData>/debug. No network, no model calls.
 *
 *   npx vite-node scripts/bench-color-match.ts -- "<debug dir>" [pairs per provider]
 *
 * Hold-out: the patch is split into an 8×8 checkerboard. Correction is fitted on one
 * colour of squares (standing in for "context outside the mask") and scored on the
 * other, so a method cannot score well by memorising the pixels it is judged on.
 */
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { fitColorMatch, applyColorFit } from "../src/colorMatch";

const dir = process.argv[2];
const PER = Number(process.argv[3] || 40);
const S = 256;

function resize(png: PNG, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = png.width / w, sy = png.height / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * png.width + xx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += png.data[i + c];
          n++;
        }
      const o = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = acc[c] / n;
    }
  return out;
}

// --- The correction the app ships today (src/compositing.ts applyFillColor), on arrays.
function legacy(mov: Uint8ClampedArray, ref: Uint8ClampedArray, w: number, h: number, ex: Uint8ClampedArray, local: boolean, k: number) {
  const G = 4;
  const mSum = [0, 0, 0], rSum = [0, 0, 0];
  let n = 0;
  const cellM = Array.from({ length: G * G }, () => [0, 0, 0]);
  const cellR = Array.from({ length: G * G }, () => [0, 0, 0]);
  const cellN = new Array(G * G).fill(0);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(G - 1, ((y / h) * G) | 0);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ex[i * 4 + 3] > 16) continue;
      const ci = gy * G + Math.min(G - 1, ((x / w) * G) | 0);
      for (let c = 0; c < 3; c++) {
        mSum[c] += mov[i * 4 + c]; rSum[c] += ref[i * 4 + c];
        cellM[ci][c] += mov[i * 4 + c]; cellR[ci][c] += ref[i * 4 + c];
      }
      n++; cellN[ci]++;
    }
  }
  const out = new Uint8ClampedArray(mov);
  if (n < 300) return out;
  const mMean = mSum.map((v) => v / n), rMean = rSum.map((v) => v / n);
  const mVar = [0, 0, 0], rVar = [0, 0, 0];
  for (let i = 0; i < w * h; i++) {
    if (ex[i * 4 + 3] > 16) continue;
    for (let c = 0; c < 3; c++) {
      mVar[c] += (mov[i * 4 + c] - mMean[c]) ** 2;
      rVar[c] += (ref[i * 4 + c] - rMean[c]) ** 2;
    }
  }
  const gain = [0, 1, 2].map((c) => {
    const ms = Math.sqrt(mVar[c] / n), rs = Math.sqrt(rVar[c] / n);
    return ms < 2 ? 1 : Math.min(1.5, Math.max(0.66, rs / ms));
  });
  const gOff = [0, 1, 2].map((c) => rMean[c] - mMean[c] * gain[c]);
  const offs = local
    ? Array.from({ length: G * G }, (_, ci) =>
        cellN[ci] < 120 ? gOff.slice() : [0, 1, 2].map((c) => Math.max(-80, Math.min(80, cellR[ci][c] / cellN[ci] - (cellM[ci][c] / cellN[ci]) * gain[c]))))
    : [gOff];
  const offAt = (x: number, y: number, c: number) => {
    if (!local) return offs[0][c];
    const fx = Math.max(0, Math.min(G - 1.001, (x / w) * G - 0.5)), fy = Math.max(0, Math.min(G - 1.001, (y / h) * G - 0.5));
    const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(G - 1, x0 + 1), y1 = Math.min(G - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
    return offs[y0 * G + x0][c] * (1 - tx) * (1 - ty) + offs[y0 * G + x1][c] * tx * (1 - ty) + offs[y1 * G + x0][c] * (1 - tx) * ty + offs[y1 * G + x1][c] * tx * ty;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out[i + c] = mov[i + c] + k * (mov[i + c] * gain[c] + offAt(x, y, c) - mov[i + c]);
    }
  return out;
}

// --- Scoring in CIELAB on the held-out squares.
const LUT = Array.from({ length: 256 }, (_, i) => { const v = i / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
function lab(d: Uint8ClampedArray, i: number): [number, number, number] {
  const r = LUT[d[i]], g = LUT[d[i + 1]], b = LUT[d[i + 2]];
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function score(out: Uint8ClampedArray, ref: Uint8ClampedArray, evalMask: Uint8Array) {
  const de: number[] = [];
  let cO = 0, cR = 0, lO = 0, lR = 0, lO2 = 0, lR2 = 0, n = 0;
  for (let p = 0; p < evalMask.length; p++) {
    if (!evalMask[p]) continue;
    const a = lab(out, p * 4), b = lab(ref, p * 4);
    de.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    cO += Math.hypot(a[1], a[2]); cR += Math.hypot(b[1], b[2]);
    lO += a[0]; lR += b[0]; lO2 += a[0] ** 2; lR2 += b[0] ** 2; n++;
  }
  de.sort((x, y) => x - y);
  const sd = (s: number, s2: number) => Math.sqrt(s2 / n - (s / n) ** 2);
  return { de: de[de.length >> 1], chroma: cO / cR, contrast: sd(lO, lO2) / sd(lR, lR2) };
}

const METHODS = ["none", "legacy-global", "legacy-local", "new-global", "new-local"] as const;
type M = (typeof METHODS)[number];

const files = fs.readdirSync(dir);
const outs = files.filter((x) => /_fill_[a-z0-9-]+_OUT_/.test(x)).sort().reverse();
const rows: Record<string, Record<M, ReturnType<typeof score>[]>> = {};
let fails = 0;
for (const out of outs) {
  const prov = out.match(/_fill_([a-z0-9-]+)_OUT/)![1];
  rows[prov] ??= Object.fromEntries(METHODS.map((m) => [m, []])) as any;
  if (rows[prov].none.length >= PER) continue;
  const stamp = out.split("_fill_")[0];
  const sent = files.find((x) => x.startsWith(`${stamp}_fill_${prov}_SENT`));
  if (!sent) continue;
  let po: PNG, ps: PNG;
  try {
    po = PNG.sync.read(fs.readFileSync(path.join(dir, out)));
    ps = PNG.sync.read(fs.readFileSync(path.join(dir, sent)));
  } catch { fails++; continue; }
  const w = S, h = Math.max(16, Math.round((S * ps.height) / ps.width));
  const mov = resize(po, w, h), ref = resize(ps, w, h);
  const ex = new Uint8ClampedArray(w * h * 4);
  const evalMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const odd = (((x * 8) / w) | 0) + (((y * 8) / h) | 0);
      if (odd % 2) { ex[(y * w + x) * 4 + 3] = 255; evalMask[y * w + x] = 1; }
    }
  for (const m of METHODS) {
    let res: Uint8ClampedArray;
    if (m === "none") res = mov;
    else if (m.startsWith("legacy")) res = legacy(mov, ref, w, h, ex, m === "legacy-local", 0.85);
    else {
      res = new Uint8ClampedArray(mov);
      const fit = fitColorMatch(mov, ref, w, h, ex, m === "new-local");
      if (fit) applyColorFit(res, w, h, fit, 1);
    }
    rows[prov][m].push(score(res, ref, evalMask));
  }
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`hold-out scoring · median per provider · ΔE = CIE76 (lower is better; ~2.3 is a just-noticeable difference)${fails ? ` · ${fails} unreadable` : ""}`);
for (const [prov, byM] of Object.entries(rows)) {
  const n = byM.none.length;
  if (!n) continue;
  console.log(`\n${prov} (${n} pairs)`);
  for (const m of METHODS) {
    const s = byM[m];
    const worse = s.filter((r, i) => r.de > byM.none[i].de + 0.25).length;
    console.log(
      `  ${m.padEnd(14)} ΔE ${med(s.map((r) => r.de)).toFixed(2).padStart(5)}   chroma ×${med(s.map((r) => r.chroma)).toFixed(2)}   contrast ×${med(s.map((r) => r.contrast)).toFixed(2)}` +
        (m === "none" ? "" : `   worse than none: ${worse}/${n}`),
    );
  }
}
