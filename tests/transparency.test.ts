import { describe, it, expect } from "vitest";
import { TRANSPARENT_BG, bgFill } from "../src/compositing";
import { Umage2Provider } from "../electron/providers/umage2/Umage2Provider";
import { TRANSPARENT_MODELS, TRANSPARENT_PROMPT } from "../electron/providers/umage2/Umage2Types";

describe("bgFill", () => {
  it("turns a transparent canvas into a no-op fill and leaves colours alone", () => {
    expect(bgFill(TRANSPARENT_BG)).toBe("rgba(0,0,0,0)");
    expect(bgFill(undefined)).toBe("rgba(0,0,0,0)");
    expect(bgFill("#ffffff")).toBe("#ffffff");
    expect(bgFill("#000")).toBe("#000");
  });
});

describe("the transparency option", () => {
  // NB: the option's identifier is its `key`; TRANSPARENT_BG in compositing is the CSS
  // colour string, a different export that happens to share the name.
  const optionKeys = (model: string) =>
    new Umage2Provider(model).getOptions?.().map((o: any) => o.key) ?? [];

  it("is offered on a model that supports it", () => {
    for (const m of TRANSPARENT_MODELS) expect(optionKeys(m)).toContain("transparentBackground");
  });

  it("is absent on a model that would reject it at the API", () => {
    expect(TRANSPARENT_MODELS.has("gpt-image-1")).toBe(false);
    expect(optionKeys("gpt-image-1")).not.toContain("transparentBackground");
  });

  it("steers the generation as well as the API, since the flag is not a post-process", () => {
    expect(TRANSPARENT_PROMPT).toMatch(/no (backdrop|background)/i);
    expect(TRANSPARENT_PROMPT.toLowerCase()).toContain("shadow");
  });
});
