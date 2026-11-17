import { describe, it, expect } from "vitest";
import { MockImageProvider } from "../electron/providers/mock/MockImageProvider";
import { ProviderRegistry } from "../electron/providers/registry";
import type { BaseGenerationRequest } from "../shared/types";

// A 2x2 red PNG as a data URL (generated once, stable).
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAjUwQGn6t1lwAAAABJRU5ErkJggg==";

describe("MockImageProvider", () => {
  const mock = new MockImageProvider();

  it("exposes capabilities and does not require a key", () => {
    expect(mock.requiresApiKey()).toBe(false);
    expect(mock.getCapabilities().supportsInpainting).toBe(true);
  });

  it("echoes the source image for upscale (alignment preserved)", async () => {
    const req: BaseGenerationRequest = { providerId: "mock", mode: "upscale", image: TINY_PNG };
    const res = await mock.upscaleImage(req);
    expect(res.images).toHaveLength(1);
    expect(res.images[0].width).toBe(2);
    expect(res.images[0].height).toBe(2);
    expect(res.images[0].src.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("synthesizes an image for text-to-image at requested size", async () => {
    const req: BaseGenerationRequest = {
      providerId: "mock",
      mode: "generate",
      settings: { outputWidth: 64, outputHeight: 48 },
    };
    const res = await mock.generateImage(req);
    expect(res.images[0].width).toBe(64);
    expect(res.images[0].height).toBe(48);
  });
});

describe("ProviderRegistry", () => {
  const registry = new ProviderRegistry();

  it("lists registered providers including umage2, nano-banana, reve and mock", () => {
    const ids = registry.list().map((p) => p.id);
    expect(ids).toContain("umage2");
    expect(ids).toContain("nano-banana");
    expect(ids).toContain("reve");
    expect(ids).toContain("mock");
  });

  it("nano-banana advertises edit/reference support without native masks", () => {
    const nb = registry.list().find((p) => p.id === "nano-banana");
    expect(nb?.requiresApiKey).toBe(true);
    expect(nb?.capabilities.supportsReferenceImages).toBe(true);
    expect(nb?.capabilities.supportsMasks).toBe(false);
  });

  it("dispatches by mode to the right provider", async () => {
    const res = await registry.dispatch({ providerId: "mock", mode: "upscale", image: TINY_PNG });
    expect(res.providerId).toBe("mock");
  });

  it("throws for unknown provider", () => {
    expect(() => registry.get("nope")).toThrow();
  });
});

describe("Grok Imagine models", () => {
  it("offers 2.0 and defaults to it", async () => {
    const { GrokProvider } = await import("../electron/providers/grok/GrokProvider");
    const p = new GrokProvider();
    const ids = p.getModels().map((m) => m.id);
    // grok-2-image-1212 is gone; these three are what docs.x.ai lists.
    expect(ids).toEqual(["grok-imagine-image-2.0", "grok-imagine-image-quality", "grok-imagine-image"]);
    expect(p.getCapabilities().maxReferenceImages).toBe(3); // the edits endpoint's own limit
  });
});
