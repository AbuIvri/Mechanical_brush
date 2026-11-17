import { describe, it, expect } from "vitest";
import { parseSkill, skillSteps, interpolate, BUILTIN_SKILLS } from "../src/ui/skills";
import type { PromptSkill } from "../src/ui/skills";

const good = {
  name: "פרסומת מוצר",
  description: "בונה פרומפט לפרסומת ממוצר וקהל יעד",
  applySettings: { aspectRatio: "16:9", bogus: 7 },
  steps: [
    { id: "photo", kind: "images", title: "צרף תמונת מוצר", refDefault: true },
    { id: "audience", kind: "text", title: "מי קהל היעד?" },
    { id: "final", kind: "ai", title: "ניסוח", final: true, instruction: "Audience: {{audience}}. Write a prompt." },
  ],
};

describe("parseSkill", () => {
  it("accepts a well-formed workflow and keeps only whitelisted settings", () => {
    const { skill, errors, warnings } = parseSkill(good);
    expect(errors).toEqual([]);
    expect(skill!.steps).toHaveLength(3);
    expect(skill!.applySettings).toEqual({ aspectRatio: "16:9" });
    expect(warnings.join(" ")).toContain("bogus");
  });

  it("parses a JSON string as well as an object", () => {
    expect(parseSkill(JSON.stringify(good)).errors).toEqual([]);
  });

  it("reports unparseable JSON instead of throwing", () => {
    const r = parseSkill("{ not json");
    expect(r.skill).toBeNull();
    expect(r.errors).toHaveLength(1);
  });

  it("survives the JSON models actually emit: // comments and trailing commas", () => {
    const messy = `{
      // the workflow
      "name": "פרסומת מוצר",
      "description": "בונה פרומפט", /* inline */
      "steps": [
        { "id": "audience", "kind": "text", "title": "מי קהל היעד?" },
        { "id": "final", "kind": "ai", "title": "ניסוח", "final": true, "instruction": "For {{audience}} // not a comment" },
      ],
    }`;
    const { skill, errors } = parseSkill(messy);
    expect(errors).toEqual([]);
    expect(skill!.name).toBe("פרסומת מוצר");
    expect(skill!.steps).toHaveLength(2);
    // A "//" inside a string is content, not a comment.
    expect(skill!.steps[1].instruction).toContain("// not a comment");
  });

  it("keeps a comma that is not trailing", () => {
    const r = parseSkill('{"name":"a","description":"b","steps":[{"id":"x","kind":"ai","title":"t","instruction":"a, b, c"}]}');
    expect(r.errors).toEqual([]);
    expect(r.skill!.steps[0].instruction).toBe("a, b, c");
  });

  it("rejects a bad step kind, a missing title and a duplicate id", () => {
    const { errors } = parseSkill({
      name: "x",
      description: "y",
      steps: [
        { id: "a", kind: "text", title: "שאלה" },
        { id: "a", kind: "text", title: "שוב" },
        { id: "b", kind: "magic", title: "?" },
        { id: "c", kind: "ai", final: true, instruction: "go" },
      ],
    });
    expect(errors.some((e) => e.includes("פעמיים"))).toBe(true);
    expect(errors.some((e) => e.includes("magic"))).toBe(true);
    expect(errors.some((e) => e.includes("כותרת"))).toBe(true);
  });

  it("requires two options on a choice step and an instruction on an ai step", () => {
    const { errors } = parseSkill({
      name: "x",
      description: "y",
      steps: [
        { id: "a", kind: "choice", title: "בחר", options: ["רק אחת"] },
        { id: "b", kind: "ai", title: "נסח", final: true },
      ],
    });
    expect(errors.some((e) => e.includes("שתי אפשרויות"))).toBe(true);
    expect(errors.some((e) => e.includes("הוראה"))).toBe(true);
  });

  it("flags a {{ref}} that does not point at an earlier step", () => {
    const { errors } = parseSkill({
      name: "x",
      description: "y",
      steps: [
        { id: "a", kind: "ai", title: "1", instruction: "use {{later}} and {{a}}" },
        { id: "later", kind: "text", title: "2" },
        { id: "z", kind: "ai", title: "3", final: true, instruction: "ok {{a}}" },
      ],
    });
    expect(errors.some((e) => e.includes("{{later}}"))).toBe(true);
    expect(errors.some((e) => e.includes("{{a}}"))).toBe(true); // self-reference
    expect(errors.some((e) => e.includes("{{ok}}"))).toBe(false);
  });

  it("marks the last ai step final when the model forgot to, and keeps only one", () => {
    const one = parseSkill({
      name: "x",
      description: "y",
      steps: [{ id: "a", kind: "ai", title: "t", instruction: "go" }],
    });
    expect(one.errors).toEqual([]);
    expect(one.skill!.steps[0].final).toBe(true);

    const many = parseSkill({
      name: "x",
      description: "y",
      steps: [
        { id: "a", kind: "ai", title: "t", instruction: "go", final: true },
        { id: "b", kind: "ai", title: "t2", instruction: "go2", final: true },
      ],
    });
    expect(many.skill!.steps.filter((s) => s.final)).toHaveLength(1);
    expect(many.skill!.steps[1].final).toBe(true);
  });

  it("refuses a workflow with no ai step — it would never produce a prompt", () => {
    const { errors } = parseSkill({
      name: "x",
      description: "y",
      steps: [{ id: "a", kind: "text", title: "רק שאלה" }],
    });
    expect(errors.some((e) => e.includes("שלב AI"))).toBe(true);
  });

  it("keeps a per-step model override only when the provider is real", () => {
    const { skill } = parseSkill({
      name: "x",
      description: "y",
      steps: [
        { id: "a", kind: "ai", title: "t", instruction: "go", provider: "google", model: "gemini-2.5-pro" },
        { id: "b", kind: "ai", title: "t", instruction: "go", final: true, provider: "skynet", model: "" },
      ],
    });
    expect(skill!.steps[0].provider).toBe("google");
    expect(skill!.steps[0].model).toBe("gemini-2.5-pro");
    expect(skill!.steps[1].provider).toBeUndefined();
    expect(skill!.steps[1].model).toBeUndefined();
  });

  it("round-trips a built-in skill through export/import unchanged", () => {
    const sheet = BUILTIN_SKILLS[0];
    const { skill, errors } = parseSkill(JSON.parse(JSON.stringify(sheet)));
    expect(errors).toEqual([]);
    expect(skill!.steps.map((s) => s.id)).toEqual(sheet.steps.map((s) => s.id));
    expect(skill!.applySettings).toEqual(sheet.applySettings);
  });
});

describe("skillSteps", () => {
  const mk = (steps: PromptSkill["steps"]): PromptSkill => ({ id: "t", name: "t", description: "d", steps });

  it("inserts the mode step just before the final ai step", () => {
    const s = skillSteps(mk([
      { id: "a", kind: "text", title: "1" },
      { id: "f", kind: "ai", title: "2", final: true, instruction: "x" },
    ]));
    expect(s.map((x) => x.kind)).toEqual(["text", "mode", "ai"]);
  });

  it("appends the mode step when there is no final ai step", () => {
    const s = skillSteps(mk([{ id: "a", kind: "text", title: "1" }]));
    expect(s[s.length - 1].kind).toBe("mode");
  });

  it("leaves a skill that declares its own mode step alone", () => {
    const steps = [
      { id: "m", kind: "mode" as const, title: "מצב" },
      { id: "f", kind: "ai" as const, title: "2", final: true, instruction: "x" },
    ];
    expect(skillSteps(mk(steps))).toHaveLength(2);
  });
});

describe("interpolate", () => {
  it("replaces known refs and blanks unknown ones", () => {
    expect(interpolate("a {{x}} b {{y}}", { x: "1" })).toBe("a 1 b ");
  });
});

describe("the built-in character sheet", () => {
  const sheet = BUILTIN_SKILLS[0];

  it("keeps the person's photos and the wardrobe reference in separate steps", () => {
    const ids = skillSteps(sheet).map((s) => s.id);
    expect(ids).toEqual(["photo", "identity", "context", "wardrobeRef", "wardrobe", "mode", "sheet"]);
    const imageSteps = sheet.steps.filter((s) => s.kind === "images");
    expect(imageSteps.map((s) => s.id)).toEqual(["photo", "wardrobeRef"]);
  });

  it("sends each AI stage only the images it should see", () => {
    const by = (id: string) => sheet.steps.find((s) => s.id === id)!;
    expect(by("identity").usesImages).toEqual(["photo"]);
    expect(by("wardrobe").usesImages).toEqual(["wardrobeRef"]);
    // The final stage works from the two paragraphs — no need to pay for the photos again.
    expect(by("sheet").usesImages).toEqual([]);
  });

  it("keeps the wardrobe reference out of the image engine", () => {
    const ref = sheet.steps.find((s) => s.id === "wardrobeRef")!;
    expect(ref.refDefault).toBe(false); // never promoted to a generation reference
    expect(ref.optional).toBe(true); // and a run without one still completes
  });

  it("has a fixed turnaround and exactly one free pose", () => {
    const f = sheet.steps.find((s) => s.id === "sheet")!.instruction!;
    expect(f).toContain("five views in total");
    // The action panel is the only one allowed to move — everything else stays put,
    // because that is what makes the sheet usable as an identity reference.
    expect(f).toContain("This is the only panel whose pose is free");
    expect(f).toContain("Panel 4 differs in pose alone");
    const w = sheet.steps.find((s) => s.id === "wardrobe")!.instruction!;
    expect(w).toContain("ONE ACTION POSE");
    expect(w).toContain("Keep both feet in shot");
  });

  it("takes the medium from the context and stops hard-coding a photograph", () => {
    const f = sheet.steps.find((s) => s.id === "sheet")!.instruction!;
    expect(f).toContain("MEDIUM. Read it from the character context");
    // The two lines that used to force a photograph must now follow the medium.
    expect(f).not.toContain("85mm lens, f/8, photorealistic RAW detail. One person");
    expect(f).not.toContain("Not an illustration, not a render, not a drawing — a photograph");
    expect(f).toContain("that medium's own equivalent");
    // …without ever loosening the likeness.
    expect(f).toContain("still has to be recognisably this person");
    const ctx = sheet.steps.find((s) => s.id === "context")!;
    expect(ctx.hint).toContain("פיקסר");
  });

  it("asks for the person and the character to be written as one", () => {
    const f = sheet.steps.find((s) => s.id === "sheet")!.instruction!;
    expect(f).toContain("WEAVE, DO NOT STACK");
    expect(f).toContain("not one fact in it may change");
    expect(f).toContain("fit the garments to this body");
  });

  it("validates, including the new fields", () => {
    const r = parseSkill(JSON.parse(JSON.stringify(sheet)));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.skill!.steps.find((s) => s.id === "wardrobe")!.usesImages).toEqual(["wardrobeRef"]);
  });

  it("refuses a stage that reads images from a step that has not run yet", () => {
    const broken = JSON.parse(JSON.stringify(sheet));
    broken.steps.find((s: any) => s.id === "identity").usesImages = ["wardrobeRef"];
    const { errors } = parseSkill(broken);
    expect(errors.some((e) => e.includes("wardrobeRef"))).toBe(true);
  });
});
