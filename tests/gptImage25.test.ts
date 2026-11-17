import { describe, it, expect } from "vitest";
import {
  UMAGE2_MODELS,
  UMAGE2_DEFAULT_MODEL,
  TRANSPARENT_MODELS,
  FLEXIBLE_MODELS,
  XQUALITY_MODELS,
  clampQuality,
} from "../electron/providers/umage2/Umage2Types";
import { pickSize, estimateCost } from "../electron/providers/umage2/Umage2Mapper";
import { Umage2Provider } from "../electron/providers/umage2/Umage2Provider";
import { canRemoveBackground } from "../shared/capabilities";

const FLARE = "gpt-image-2.5-flare";
const SUNBURST = "gpt-image-2.5-sunburst";

describe("GPT Image 2.5", () => {
  it("offers both variants, and Flare is the default", () => {
    const ids = UMAGE2_MODELS.map((m) => m.id);
    expect(ids).toContain(FLARE);
    expect(ids).toContain(SUNBURST);
    expect(UMAGE2_DEFAULT_MODEL).toBe(FLARE);
    // setProvider() picks models[0], so the order is what a user actually lands on.
    expect(ids[0]).toBe(FLARE);
    // The older models stay reachable — this is an addition, not a replacement.
    expect(ids).toContain("gpt-image-2");
    expect(ids).toContain("gpt-image-1");
  });

  it("treats them as flexible-size, so fill and ratio keep working", () => {
    for (const m of [FLARE, SUNBURST]) {
      expect(FLEXIBLE_MODELS.has(m)).toBe(true);
      // Same documented envelope as gpt-image-2: <=3840/edge, <=8.29MP, multiples of 16.
      expect(pickSize(m, 1920, 1080)).toBe(pickSize("gpt-image-2", 1920, 1080));
      const [w, h] = pickSize(m, 1000, 1000).split("x").map(Number);
      expect(w % 16).toBe(0);
      expect(h % 16).toBe(0);
      expect(w * h).toBeLessThanOrEqual(8294400);
      expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
    }
  });

  it("can remove a background, and the gpt-image-1 family still cannot", () => {
    const p = new Umage2Provider();
    const info = { capabilities: p.getCapabilities(), models: p.getModels() };
    expect(canRemoveBackground(info, FLARE)).toBe(true);
    expect(canRemoveBackground(info, SUNBURST)).toBe(true);
    expect(canRemoveBackground(info, "gpt-image-2")).toBe(true);
    expect(canRemoveBackground(info, "gpt-image-1")).toBe(false);
    for (const m of [FLARE, SUNBURST]) expect(TRANSPARENT_MODELS.has(m)).toBe(true);
  });

  it("offers xhigh/max only on 2.5, tagged with the models that accept them", () => {
    const quality = new Umage2Provider().getOptions().find((o) => o.key === "quality")!;
    const values = quality.choices!.map((c) => String(c.value));
    expect(values).toEqual(["low", "medium", "high", "xhigh", "max", "auto"]);

    for (const v of ["xhigh", "max"]) {
      const c = quality.choices!.find((x) => String(x.value) === v)!;
      expect(c.models).toEqual([...XQUALITY_MODELS]);
      // What the renderer does with the tag.
      expect(c.models!.includes(FLARE)).toBe(true);
      expect(c.models!.includes("gpt-image-2")).toBe(false);
    }
    // The shared tiers carry no tag at all, so every model keeps them.
    for (const v of ["low", "medium", "high", "auto"]) {
      expect(quality.choices!.find((x) => String(x.value) === v)!.models).toBeUndefined();
    }
  });

  it("never sends a quality the chosen model would reject", () => {
    // The stale-settings path: picked "max" on 2.5, then switched model. The API answers
    // an unknown quality with a 400, so it has to be clamped rather than passed through.
    expect(clampQuality("gpt-image-2", "max")).toBe("high");
    expect(clampQuality("gpt-image-2", "xhigh")).toBe("high");
    expect(clampQuality("gpt-image-1", "xhigh")).toBe("high");
    expect(clampQuality(FLARE, "max")).toBe("max");
    expect(clampQuality(SUNBURST, "xhigh")).toBe("xhigh");
    // Everything else is untouched, including the unset default.
    expect(clampQuality("gpt-image-2", "medium")).toBe("medium");
    expect(clampQuality(FLARE, undefined)).toBe("high");
  });

  it("prices the new quality tiers above high, and never falls back to a tier without them", () => {
    for (const m of [FLARE, SUNBURST]) {
      const high = estimateCost(m, 1024, 1024, "high");
      const xhigh = estimateCost(m, 1024, 1024, "xhigh");
      const max = estimateCost(m, 1024, 1024, "max");
      expect(xhigh).toBeGreaterThan(high);
      expect(max).toBeGreaterThan(xhigh);
    }
    // An unknown model falls back to the default tier, which must know xhigh/max —
    // falling back to a table without them silently prices them as "high".
    expect(estimateCost("gpt-image-9", 1024, 1024, "max")).toBeGreaterThan(
      estimateCost("gpt-image-9", 1024, 1024, "high"),
    );
  });
});
