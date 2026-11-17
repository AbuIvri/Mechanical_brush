import { describe, it, expect } from "vitest";
import { BUILTIN_SKILLS, interpolate, skillSteps } from "../src/ui/skills";

// The rewind is a UI affordance over one guarantee in the run model: answers are kept
// per step, and re-answering a step only invalidates what comes AFTER it. These lock
// that guarantee for the case it was built for — two characters for the same person,
// where the identity analysis must not run twice.
describe("going back a step keeps the work before it", () => {
  const sheet = BUILTIN_SKILLS[0];
  const steps = skillSteps(sheet);
  const idx = (id: string) => steps.findIndex((s) => s.id === id);

  it("puts the character step after the identity analysis", () => {
    // If context came first, changing the character WOULD invalidate the identity.
    expect(idx("identity")).toBeLessThan(idx("context"));
  });

  it("re-runs only the stages after the step being changed", () => {
    const answers: Record<string, string> = {
      photo: "3",
      identity: "a forensic paragraph",
      context: "בלש נואר",
      wardrobeRef: "1",
      wardrobe: "a trench coat",
      mode: "generate",
    };
    const changed = idx("context");
    const rerun = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => i > changed && s.kind === "ai")
      .map(({ s }) => s.id);
    expect(rerun).toEqual(["wardrobe", "sheet"]);
    // identity is before the change, so its answer survives untouched…
    expect(answers.identity).toBe("a forensic paragraph");
    // …and the stage that re-runs still reads it through interpolation.
    const finalStep = steps.find((s) => s.id === "sheet")!;
    const filled = interpolate(finalStep.instruction!, { ...answers, context: "גיבור על" });
    expect(filled).toContain("a forensic paragraph");
    expect(filled).toContain("גיבור על");
    expect(filled).not.toContain("{{identity}}");
  });

  it("leaves a step's stored answer to come back to", () => {
    const answers = { context: "בלש נואר" };
    // What the editor is refilled with when you step back onto it.
    expect(answers["context" as keyof typeof answers] ?? "").toBe("בלש נואר");
  });
});
