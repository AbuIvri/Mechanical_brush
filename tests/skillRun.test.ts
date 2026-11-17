import { describe, it, expect } from "vitest";
import { BUILTIN_SKILLS, parseSkill, skillSteps } from "../src/ui/skills";
import type { SavedSkillRun } from "../shared/types";

// A run stored in a .mbrush file is data the app did not write this session, so the
// resume path treats it as untrusted and re-validates it.
describe("resuming a saved skill run", () => {
  const sheet = BUILTIN_SKILLS[0];
  const run: SavedSkillRun = {
    skill: JSON.parse(JSON.stringify(sheet)),
    answers: { photo: "3", identity: "a paragraph", context: "בלש נואר", wardrobe: "a coat", mode: "generate" },
    finalPrompt: "the prompt",
    referenceIds: ["r1", "r2"],
    savedAt: "2026-08-25T10:00:00.000Z",
  };

  it("round-trips through the file and back through the validator", () => {
    const fromFile = JSON.parse(JSON.stringify(run)) as SavedSkillRun;
    const { skill, errors } = parseSkill(fromFile.skill);
    expect(errors).toEqual([]);
    expect(skill!.steps.map((s) => s.id)).toEqual(sheet.steps.map((s) => s.id));
  });

  it("lands finished, with every answer, so stepping back is what costs nothing", () => {
    const { skill } = parseSkill(run.skill);
    const steps = skillSteps(skill!);
    // Resumed at the end of the trail…
    expect(steps.length).toBeGreaterThan(0);
    // …with the expensive stage's answer already in hand.
    expect(run.answers.identity).toBe("a paragraph");
    const contextIdx = steps.findIndex((s) => s.id === "context");
    const rerun = steps.filter((s, i) => i > contextIdx && s.kind === "ai").map((s) => s.id);
    expect(rerun).toEqual(["wardrobe", "sheet"]);
    expect(rerun).not.toContain("identity");
  });

  it("refuses a corrupted run rather than starting a broken workflow", () => {
    const broken = { ...run, skill: { name: "x", steps: [{ id: "a", kind: "nope", title: "t" }] } };
    const { skill, errors } = parseSkill(broken.skill);
    expect(errors.length).toBeGreaterThan(0);
    expect(skill!.steps).toEqual([]); // nothing runnable survives
  });

  it("remembers which reference images it put in the project", () => {
    expect(run.referenceIds).toEqual(["r1", "r2"]);
  });
});
