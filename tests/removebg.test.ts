import { describe, it, expect } from "vitest";
import { canRemoveBackground } from "../shared/capabilities";
import { targetLongEdge, aspectOutputDims, BATCH_MODES } from "../src/batchRun";
import { Umage2Provider } from "../electron/providers/umage2/Umage2Provider";
import { NanoBananaProvider } from "../electron/providers/nano-banana/NanoBananaProvider";
import { buildModePrompt } from "../electron/providers/umage2/Umage2Mapper";
import { REMOVEBG_BASE_PROMPT } from "../electron/providers/options";
import type { GenerationSettings } from "../shared/types";

const umage2 = new Umage2Provider();
const info = (p: any) => ({ capabilities: p.getCapabilities(), models: p.getModels() });

describe("who may remove a background", () => {
  it("allows umage2 on the model that actually returns alpha", () => {
    expect(canRemoveBackground(info(umage2), "gpt-image-2")).toBe(true);
  });

  it("refuses the gpt-image-1 family — the API rejects background=transparent there", () => {
    expect(canRemoveBackground(info(umage2), "gpt-image-1")).toBe(false);
    expect(canRemoveBackground(info(umage2), "gpt-image-1-mini")).toBe(false);
  });

  it("refuses an engine that never returns alpha, whatever the model", () => {
    const nano = info(new NanoBananaProvider());
    expect(nano.capabilities.supportsTransparency).toBe(false);
    expect(canRemoveBackground(nano, nano.models[0].id)).toBe(false);
  });

  it("refuses a missing engine instead of throwing", () => {
    expect(canRemoveBackground(undefined, "gpt-image-2")).toBe(false);
  });

  it("reads the SELECTED model, not the engine's default — the bug this guards", () => {
    // provider.options is built once from the default model, so it can never answer
    // "is the model chosen right now capable?". The model flag can.
    const models = umage2.getModels();
    expect(models.find((m) => m.id === "gpt-image-2")!.supportsTransparency).toBe(true);
    expect(models.find((m) => m.id === "gpt-image-1")!.supportsTransparency).toBeFalsy();
  });
});

describe("the removebg prompt", () => {
  const p = buildModePrompt("removebg", undefined, {});

  it("uses the isolation prompt, not the recreate one", () => {
    expect(p).toContain(REMOVEBG_BASE_PROMPT);
    expect(p).not.toContain("Recreate this image at higher fidelity");
  });

  it("forbids the things a model invents behind a subject", () => {
    for (const banned of ["backdrop", "floor", "cast shadow", "reflection"]) {
      expect(REMOVEBG_BASE_PROMPT.toLowerCase()).toContain(banned);
    }
  });

  it("carries the preserve guards through, and the user's own words last", () => {
    const withGuards = buildModePrompt("removebg", "keep the label sharp", {
      preserveIdentity: true,
      preserveGeometry: true,
      preserveColor: true,
    } as GenerationSettings);
    expect(withGuards).toContain("preserve subject identity");
    expect(withGuards.trim().endsWith("keep the label sharp")).toBe(true);
  });
});

describe("the removebg resolution", () => {
  const opt = umage2.getOptions().find((o) => o.key === "removebgLongEdge")!;

  it("defaults to 2K and offers the source's own size", () => {
    expect(opt.default).toBe(2048);
    expect(opt.choices!.map((c) => c.value)).toEqual([0, 1024, 1536, 2048, 3840]);
    expect(opt.choices![0].label).toBe("כמו המקור");
  });

  it("shows up only in its own mode", () => {
    expect(opt.modes).toEqual(["removebg"]);
  });

  it("means the source's long edge when set to 0, and the number otherwise", () => {
    expect(targetLongEdge("removebg", { removebgLongEdge: 0 }, 1500)).toBe(1500);
    expect(targetLongEdge("removebg", { removebgLongEdge: 2048 }, 1500)).toBe(2048);
    expect(targetLongEdge("removebg", undefined, 1500)).toBe(1500);
  });
});

describe("the batch runner no longer ignores the chosen resolution", () => {
  it("follows the setting instead of the old hard-coded ladder", () => {
    // 2048 was the constant this file used to hard-code for every recreate.
    expect(aspectOutputDims("recreate", "16:9", { recreateLongEdge: 3840 }, 1024))
      .toEqual({ outputWidth: 3840, outputHeight: 2160 });
    expect(aspectOutputDims("upscale", "1:1", { upscaleLongEdge: 2048 }, 1024))
      .toEqual({ outputWidth: 2048, outputHeight: 2048 });
  });

  it("falls back to the source's long edge, not a constant", () => {
    expect(aspectOutputDims("recreate", "1:1", {}, 1234))
      .toEqual({ outputWidth: 1234, outputHeight: 1234 });
  });

  it("still returns null for auto", () => {
    expect(aspectOutputDims("recreate", "auto", {}, 1024)).toBeNull();
    expect(aspectOutputDims("recreate", undefined, {}, 1024)).toBeNull();
  });

  it("offers background removal as a per-file batch too", () => {
    expect(BATCH_MODES).toContain("removebg");
  });
});
