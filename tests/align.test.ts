import { describe, it, expect } from "vitest";
import { estimateSimilarity, type Gray } from "../src/align";

// A textured pattern with enough structure for NCC to lock onto.
function pattern(x: number, y: number): number {
  return 128 + 60 * Math.sin(x * 0.6) + 50 * Math.cos(y * 0.45) + 40 * Math.sin((x + y) * 0.3);
}

function build(w: number, h: number, ox: number, oy: number): Gray {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data[y * w + x] = pattern(x + ox, y + oy);
  return { data, w, h };
}

describe("estimateSimilarity", () => {
  it("recovers a known integer translation", () => {
    const w = 64;
    const h = 64;
    const ref = build(w, h, 0, 0);
    // mov is ref translated by (SX, SY): mov(x,y) = ref(x - SX, y - SY).
    // Model ref(X,Y) ≈ mov(X - dx) ⇒ estimator should return dx = -SX, dy = -SY.
    const SX = 2;
    const SY = -3;
    const mov = build(w, h, -SX, -SY);
    const r = estimateSimilarity(ref, mov, { scales: [1], maxShift: 6, step: 1 });
    expect(r.dx).toBe(-SX);
    expect(r.dy).toBe(-SY);
    expect(r.score).toBeGreaterThan(0.9);
  });

  it("prefers scale 1 and zero shift for identical images", () => {
    const g = build(48, 48, 0, 0);
    const g2 = build(48, 48, 0, 0);
    const r = estimateSimilarity(g, g2, { scales: [0.98, 1.0, 1.02], maxShift: 4, step: 1 });
    expect(r.scale).toBe(1);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.score).toBeGreaterThan(0.99);
  });

  it("mask-weighting ignores a corrupted (edited) region and still recovers the shift", () => {
    const w = 64;
    const h = 64;
    const SX = 2;
    const SY = -3;
    const ref = build(w, h, 0, 0);
    const mov = build(w, h, -SX, -SY);
    // Corrupt a central block of `mov` (simulate generated content that differs):
    for (let y = 26; y < 38; y++) for (let x = 26; x < 38; x++) mov.data[y * w + x] = 0;
    // Weight = 0 over the corrupted region (the "edited" area to exclude).
    const weight = new Float32Array(w * h).fill(1);
    for (let y = 26; y < 38; y++) for (let x = 26; x < 38; x++) weight[y * w + x] = 0;
    const r = estimateSimilarity(ref, mov, { scales: [1], maxShift: 6, step: 1, weight });
    expect(r.dx).toBe(-SX); // shift still recovered despite the corrupted block
    expect(r.dy).toBe(-SY);
    expect(r.score).toBeGreaterThan(0.8);
  });
});
