import { describe, it, expect } from "vitest";
import { fitColorMatch, applyColorFit } from "../src/colorMatch";
import { DEFAULT_FILL_COLOR } from "../src/compositing";

const W = 128, H = 96;

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A colourful, textured stand-in for a photo crop. */
function scene(seed = 1): Uint8ClampedArray {
  const r = rng(seed);
  const ph = [r() * 6, r() * 6, r() * 6];
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++)
        d[i + c] = 128 + 60 * Math.sin(x / (9 + c * 3) + ph[c]) * Math.cos(y / (11 + c * 2)) + (r() - 0.5) * 16;
      d[i + 3] = 255;
    }
  return d;
}

/** What OpenAI does to an untouched area: more saturation and contrast, a little darker. */
function drift(src: Uint8ClampedArray, sat = 1.2, con = 1.08, bri = -4): Uint8ClampedArray {
  const d = new Uint8ClampedArray(src);
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    for (let c = 0; c < 3; c++) {
      const s = l + (src[i + c] - l) * sat;
      d[i + c] = 128 + (s - 128) * con + bri;
    }
  }
  return d;
}

function shift(src: Uint8ClampedArray, dx: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(src.length);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1, Math.max(0, x - dx));
      for (let c = 0; c < 4; c++) d[(y * W + x) * 4 + c] = src[(y * W + sx) * 4 + c];
    }
  return d;
}

const err = (a: Uint8ClampedArray, b: Uint8ClampedArray, only?: (p: number) => boolean) => {
  let s = 0, n = 0;
  for (let p = 0; p < W * H; p++) {
    if (only && !only(p)) continue;
    for (let c = 0; c < 3; c++) s += Math.abs(a[p * 4 + c] - b[p * 4 + c]);
    n += 3;
  }
  return s / n;
};
const spread = (d: Uint8ClampedArray) => {
  let s = 0, s2 = 0;
  for (let i = 0; i < d.length; i += 4) { const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; s += l; s2 += l * l; }
  const n = d.length / 4;
  return Math.sqrt(s2 / n - (s / n) ** 2);
};

describe("fill colour match", () => {
  it("is on by default for every fill", () => {
    expect(DEFAULT_FILL_COLOR.mode).not.toBe("off");
    expect(DEFAULT_FILL_COLOR.strength).toBe(1);
  });

  it("leaves an exact copy alone (providers that return the untouched area as it was)", () => {
    const ref = scene();
    expect(fitColorMatch(new Uint8ClampedArray(ref), ref, W, H, null, true)).toBeNull();
  });

  it("undoes a saturation and contrast boost", () => {
    const ref = scene(2);
    const mov = drift(ref);
    const fit = fitColorMatch(mov, ref, W, H, null, true);
    expect(fit).not.toBeNull();
    const out = new Uint8ClampedArray(mov);
    applyColorFit(out, W, H, fit!, 1);
    expect(err(out, ref)).toBeLessThan(err(mov, ref) * 0.35);
  });

  it("measures on the context only, and corrects the edited part with it", () => {
    const ref = scene(3);
    const mov = drift(ref);
    // The model painted something new in the middle; the mask says so.
    const inside = (p: number) => { const x = p % W, y = (p / W) | 0; return x > 40 && x < 88 && y > 30 && y < 66; };
    const mask = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p++) if (inside(p)) { mov[p * 4] = 250; mov[p * 4 + 1] = 20; mov[p * 4 + 2] = 20; mask[p * 4 + 3] = 255; }
    const fit = fitColorMatch(mov, ref, W, H, mask, false);
    expect(fit).not.toBeNull();
    const out = new Uint8ClampedArray(mov);
    applyColorFit(out, W, H, fit!, 1);
    const outside = (p: number) => !inside(p);
    expect(err(out, ref, outside)).toBeLessThan(err(mov, ref, outside) * 0.35);
  });

  it("does not flatten contrast when the output is a pixel out of register", () => {
    // A pixel-by-pixel regression shrank contrast by 8% on real pairs like this.
    const ref = scene(4);
    const mov = shift(drift(ref, 1.15, 1.06, 0), 2);
    const fit = fitColorMatch(mov, ref, W, H, null, true);
    expect(fit).not.toBeNull();
    const out = new Uint8ClampedArray(mov);
    applyColorFit(out, W, H, fit!, 1);
    expect(spread(out) / spread(ref)).toBeGreaterThan(0.97);
    expect(spread(out) / spread(ref)).toBeLessThan(1.03);
  });

  it("does nothing when the output is a different picture (it cannot help there)", () => {
    expect(fitColorMatch(scene(5), scene(6), W, H, null, true)).toBeNull();
  });

  it("a flat sky moves its level without inventing a re-grade", () => {
    const r = rng(9);
    const ref = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < ref.length; i += 4) {
      ref[i] = 120 + r() * 3; ref[i + 1] = 160 + r() * 3; ref[i + 2] = 210 + r() * 3; ref[i + 3] = 255;
    }
    const mov = new Uint8ClampedArray(ref);
    for (let i = 0; i < mov.length; i += 4) { mov[i] -= 10; mov[i + 1] -= 6; mov[i + 2] += 4; }
    const fit = fitColorMatch(mov, ref, W, H, null, false);
    expect(fit).not.toBeNull();
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) expect(Math.abs(fit!.m[c][k] - (c === k ? 1 : 0))).toBeLessThan(0.6);
    const out = new Uint8ClampedArray(mov);
    applyColorFit(out, W, H, fit!, 1);
    expect(err(out, ref)).toBeLessThan(2.5);
  });

  it("strength 0 changes nothing", () => {
    const ref = scene(7);
    const mov = drift(ref);
    const fit = fitColorMatch(mov, ref, W, H, null, true)!;
    const out = new Uint8ClampedArray(mov);
    applyColorFit(out, W, H, fit, 0);
    expect(err(out, mov)).toBe(0);
  });
  it("a rectangle fill (mask over the whole crop) is matched on the crop's edge band", () => {
    const ref = scene(11);
    // The whole crop is marked; the model changed the middle and drifted everywhere.
    const changed = new Uint8ClampedArray(ref);
    for (let y = 30; y < 66; y++) for (let x = 40; x < 88; x++) { const i = (y * W + x) * 4; changed[i] = 240; changed[i + 1] = 30; changed[i + 2] = 30; }
    const mov = drift(changed);
    const all = new Uint8ClampedArray(W * H * 4).fill(255);
    const fit = fitColorMatch(mov, ref, W, H, all, true);
    expect(fit).not.toBeNull();
    const out = new Uint8ClampedArray(mov);
    applyColorFit(out, W, H, fit!, 1);
    const edge = (p: number) => { const x = p % W, y = (p / W) | 0; return x < 6 || y < 6 || x >= W - 6 || y >= H - 6; };
    expect(err(out, ref, edge)).toBeLessThan(err(mov, ref, edge) * 0.35);
  });
});
