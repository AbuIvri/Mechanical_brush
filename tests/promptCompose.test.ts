import { describe, it, expect } from "vitest";
import { composePrompt, stripMedium, stripStyle, extractCore } from "../src/promptCompose";

describe("composePrompt", () => {
  it("prepends the medium and appends the style", () => {
    expect(composePrompt("oil painting", "a cat", "film noir")).toBe(
      "oil painting, a cat in the style of film noir",
    );
  });
  it("handles medium only", () => {
    expect(composePrompt("oil painting", "", "")).toBe("oil painting");
  });
  it("handles core only", () => {
    expect(composePrompt("", "a cat", "")).toBe("a cat");
  });
  it("handles style only", () => {
    expect(composePrompt("", "", "film noir")).toBe("in the style of film noir");
  });
  it("handles medium + style with empty core", () => {
    expect(composePrompt("oil painting", "", "film noir")).toBe(
      "oil painting in the style of film noir",
    );
  });
});

describe("stripMedium / stripStyle / extractCore", () => {
  it("strips a leading medium token", () => {
    expect(stripMedium("oil painting, a cat", "oil painting")).toBe("a cat");
  });
  it("leaves the prompt untouched when the medium doesn't match", () => {
    expect(stripMedium("a cat", "oil painting")).toBe("a cat");
  });
  it("strips a trailing style token", () => {
    expect(stripStyle("a cat in the style of film noir", "film noir")).toBe("a cat");
  });
  it("extracts the core from a fully composed prompt (round-trip)", () => {
    const composed = composePrompt("oil painting", "a cat", "film noir");
    expect(extractCore(composed, "oil painting", "film noir")).toBe("a cat");
  });
  it("swapping the medium does not stack (strip old, compose new)", () => {
    const composed = composePrompt("oil painting", "a cat", "film noir");
    const core = extractCore(composed, "oil painting", "film noir");
    expect(composePrompt("watercolor painting", core, "film noir")).toBe(
      "watercolor painting, a cat in the style of film noir",
    );
  });
});
