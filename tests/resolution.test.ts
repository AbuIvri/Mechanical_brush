import { describe, it, expect } from "vitest";
import { fitFlexibleSize, boxToAspect, MAX_PIXELS } from "../shared/gptImageSize";
import { pickSize } from "../electron/providers/umage2/Umage2Mapper";
import { Umage2Provider } from "../electron/providers/umage2/Umage2Provider";
import { ReveProvider } from "../electron/providers/reve/ReveProvider";
import { NanoBananaProvider } from "../electron/providers/nano-banana/NanoBananaProvider";
import { GrokProvider } from "../electron/providers/grok/GrokProvider";
import { MockImageProvider } from "../electron/providers/mock/MockImageProvider";
import type { GenerationMode, ProviderOption } from "../shared/types";

describe("fitFlexibleSize", () => {
  it("clamps a square 4K to the pixel budget", () => {
    // 3840² is 14.7MP — over the 8.29MP budget, so the model gives 2880².
    expect(fitFlexibleSize(3840, 3840)).toEqual({ w: 2880, h: 2880 });
  });

  it("leaves 16:9 4K alone — it is exactly the budget", () => {
    expect(fitFlexibleSize(3840, 2160)).toEqual({ w: 3840, h: 2160 });
    expect(3840 * 2160).toBe(MAX_PIXELS);
  });

  it("never returns a size over the budget, whatever it is handed", () => {
    for (const [w, h] of [[8000, 8000], [3840, 1000], [12000, 400], [10, 10], [4096, 4096]]) {
      const f = fitFlexibleSize(w, h);
      expect(f.w * f.h).toBeLessThanOrEqual(MAX_PIXELS);
      expect(f.w % 16).toBe(0);
      expect(f.h % 16).toBe(0);
      expect(Math.max(f.w / f.h, f.h / f.w)).toBeLessThanOrEqual(3);
    }
  });

  it("fits an aspect into a box on the long edge", () => {
    expect(boxToAspect(16 / 9, 3840)).toEqual({ w: 3840, h: 2160 });
    expect(boxToAspect(9 / 16, 3840)).toEqual({ w: 2160, h: 3840 });
  });
});

describe("pickSize after the extraction", () => {
  it("still fits the source aspect into the 4K box when nothing is requested", () => {
    expect(pickSize("gpt-image-2", 1920, 1080)).toBe("3840x2160");
    expect(pickSize("gpt-image-2", 1024, 1024)).toBe("2880x2880");
  });

  it("still snaps gpt-image-1 to its fixed sizes", () => {
    expect(pickSize("gpt-image-1", 1920, 1080)).toBe("1536x1024");
    expect(pickSize("gpt-image-1", 1000, 1000)).toBe("1024x1024");
  });

  it("honours an explicit target", () => {
    expect(pickSize("gpt-image-2", 800, 600, { outputWidth: 2048, outputHeight: 1536 })).toBe("2048x1536");
  });
});

// The store's rule, mirrored here so the behaviour is pinned independently of React.
function targetFor(mode: "recreate" | "upscale", w: number, h: number, settings: any) {
  const srcLong = Math.max(w, h);
  const longEdge =
    mode === "upscale"
      ? Number(settings.upscaleLongEdge) || 3840
      : Number(settings.recreateLongEdge) || srcLong;
  const k = longEdge / srcLong;
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

describe("the recreate/upscale target size", () => {
  it("'כמו המקור' (0) reproduces the source exactly — the old behaviour", () => {
    expect(targetFor("recreate", 1024, 1024, { recreateLongEdge: 0 })).toEqual({ w: 1024, h: 1024 });
    expect(targetFor("recreate", 1920, 1080, {})).toEqual({ w: 1920, h: 1080 });
  });

  it("scales to the requested long edge without touching the aspect", () => {
    expect(targetFor("recreate", 1024, 768, { recreateLongEdge: 3840 })).toEqual({ w: 3840, h: 2880 });
    const t = targetFor("recreate", 1920, 1080, { recreateLongEdge: 2048 });
    expect(t.w / t.h).toBeCloseTo(16 / 9, 2);
  });

  it("defaults upscale to the 4K box, as it always did", () => {
    expect(targetFor("upscale", 1920, 1080, {})).toEqual({ w: 3840, h: 2160 });
    expect(targetFor("upscale", 1920, 1080, { upscaleLongEdge: 2048 })).toEqual({ w: 2048, h: 1152 });
  });

  it("a 1024² project asking for 4K really does end at 2880² — the engine's ceiling", () => {
    const t = targetFor("recreate", 1024, 1024, { recreateLongEdge: 3840 });
    expect(pickSize("gpt-image-2", 1024, 1024, { outputWidth: t.w, outputHeight: t.h })).toBe("2880x2880");
  });
});

describe("every engine offers a resolution control in every mode it supports", () => {
  const engines: { name: string; opts: ProviderOption[]; caps: any }[] = [
    { name: "umage2", ...grab(new Umage2Provider()) },
    { name: "reve", ...grab(new ReveProvider()) },
    { name: "nano-banana", ...grab(new NanoBananaProvider()) },
    { name: "grok", ...grab(new GrokProvider()) },
    { name: "mock", ...grab(new MockImageProvider()) },
  ];

  function grab(p: any) {
    return { opts: (p.getOptions?.() ?? []) as ProviderOption[], caps: p.getCapabilities() };
  }

  // The five modes the dock actually offers (PromptBar's MODES).
  const MODES: GenerationMode[] = ["upscale", "recreate", "fill", "ratio", "generate"];

  for (const e of engines) {
    for (const mode of MODES) {
      // An engine that refuses the mode outright owes the user no control for it.
      if (mode === "upscale" && !e.caps.supportsUpscale) continue;
      if (mode === "recreate" && !e.caps.supportsRecreate) continue;
      if (mode === "fill" && !e.caps.supportsInpainting) continue;

      it(`${e.name} · ${mode}`, () => {
        const shown = e.opts.filter((o) => !o.modes || o.modes.includes(mode));
        expect(shown.filter((o) => o.label.startsWith("רזולוצי"))).toHaveLength(1);
      });
    }
  }
});

describe("nano-banana's per-mode tiers", () => {
  const opts = new NanoBananaProvider().getOptions();
  const forMode = (m: GenerationMode) =>
    opts.filter((o) => o.label === "רזולוציה" && (!o.modes || o.modes.includes(m)))[0];

  it("stops showing 1K on an upscale — the default now matches what is sent", () => {
    expect(forMode("upscale").default).toBe("4K");
    expect(forMode("recreate").default).toBe("2K");
    expect(forMode("generate").default).toBe("1K");
  });

  it("gives each mode its own key, so one choice cannot leak into another", () => {
    const keys = new Set([forMode("upscale").key, forMode("recreate").key, forMode("generate").key]);
    expect(keys.size).toBe(3);
  });
});

// --- the upload budget: added after a recreate started failing with "Connection error" ---
import { describeError } from "../shared/errors";

const HI_SEND_EDGE = 4096;
const MAX_SEND_BYTES = 8_000_000;
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(",");
  if (comma < 0) return url.length;
  return Math.floor((url.length - comma - 1) * 0.75);
}
/** The store's step-down, in isolation: given an encoded size, what edge do we retry at? */
function retryEdge(edge: number, bytes: number, canvasLong: number): number {
  if (bytes <= MAX_SEND_BYTES) return edge;
  return Math.max(canvasLong, Math.floor(edge * Math.sqrt(MAX_SEND_BYTES / bytes)));
}

describe("the send-size budget", () => {
  it("measures a data URL without decoding it", () => {
    const payload = "A".repeat(1000); // 1000 base64 chars ≈ 750 bytes
    expect(dataUrlBytes(`data:image/png;base64,${payload}`)).toBe(750);
  });

  it("steps a 23MB photographic 4K send down to something that actually uploads", () => {
    const edge = retryEdge(HI_SEND_EDGE, 23_000_000, 1024);
    expect(edge).toBeLessThan(HI_SEND_EDGE);
    // PNG size tracks pixel count, so the retry should land near the budget, not miles under.
    const projected = 23_000_000 * (edge / HI_SEND_EDGE) ** 2;
    expect(projected).toBeLessThanOrEqual(MAX_SEND_BYTES);
    expect(projected).toBeGreaterThan(MAX_SEND_BYTES * 0.9);
  });

  it("never steps below the canvas size — that is the fallback, not a target", () => {
    expect(retryEdge(HI_SEND_EDGE, 51_000_000, 2048)).toBe(2048);
  });

  it("leaves a send that already fits alone", () => {
    expect(retryEdge(HI_SEND_EDGE, 3_000_000, 1024)).toBe(HI_SEND_EDGE);
  });
});

describe("describeError", () => {
  it("unwraps the cause the OpenAI SDK hides behind 'Connection error.'", () => {
    const err = new Error("Connection error.");
    (err as any).cause = new Error("terminated");
    expect(describeError(err)).toContain("terminated");
    // What to try now depends on what the request weighed: a heavy upload is its own
    // suspect, an unknown or small one is a transport hiccup worth retrying.
    expect(describeError(err, 30_000_000)).toContain("רזולוציית האזור");
    expect(describeError(err)).toMatch(/לחץ הרץ שוב/);
  });

  it("leaves an ordinary API message intact", () => {
    expect(describeError(new Error("invalid_request: bad size"))).toBe("invalid_request: bad size");
  });

  it("does not repeat a cause that echoes the message", () => {
    const err = new Error("boom");
    (err as any).cause = new Error("boom");
    expect(describeError(err)).toBe("boom");
  });
});
