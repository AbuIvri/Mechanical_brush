import { describe, it, expect } from "vitest";
import { buildSessionExport, buildSkillExport, jsonFileName } from "../src/ui/exportJson";
import { parseSkill, type PromptSkill } from "../src/ui/skills";
import type { ChatSession } from "../src/state/chat";

const skill: PromptSkill = {
  id: "u1",
  name: "פרסומת מוצר",
  description: "בונה פרומפט לפרסומת",
  applySettings: { aspectRatio: "16:9" },
  steps: [
    { id: "audience", kind: "text", title: "מי קהל היעד?" },
    { id: "final", kind: "ai", title: "ניסוח", final: true, instruction: "For {{audience}}: write a prompt." },
  ],
};

const session = (over: Partial<ChatSession> = {}): ChatSession =>
  ({
    id: "s1",
    title: "פרסומת",
    titleAuto: false,
    provider: "openai",
    model: "gpt-5.5",
    msgs: [],
    attachments: [],
    carry: [],
    input: "",
    autoContext: true,
    busy: false,
    busySince: 0,
    error: null,
    skill: null,
    planner: null,
    updatedAt: 0,
    ...over,
  }) as ChatSession;

describe("buildSkillExport", () => {
  it("wraps the workflow with a kind and a timestamp", () => {
    const e = buildSkillExport(skill);
    expect(e.kind).toBe("mbrush.skill");
    expect(e.skill.steps).toHaveLength(2);
    expect(Date.parse(e.exportedAt)).not.toBeNaN();
  });

  it("round-trips back through parseSkill — an export can be pasted in again", () => {
    const { skill: back, errors } = parseSkill(JSON.stringify(buildSkillExport(skill)));
    expect(errors).toEqual([]);
    expect(back!.name).toBe("פרסומת מוצר");
    expect(back!.steps.map((s) => s.id)).toEqual(["audience", "final"]);
  });
});

describe("buildSessionExport", () => {
  it("exports the conversation with the images each turn was sent", () => {
    const e = buildSessionExport(
      session({
        msgs: [
          { role: "user", content: "מה כדאי פה?", ctxLabels: ["התמונה הפתוחה (אוטומטי)"] },
          { role: "assistant", content: "תשובה" },
          { role: "assistant", content: "🎓 סקיל התחיל", notice: true },
        ],
      }),
    );
    expect(e.model).toEqual({ provider: "openai", model: "gpt-5.5" });
    expect(e.conversation).toHaveLength(3);
    expect(e.conversation[0].images).toEqual(["התמונה הפתוחה (אוטומטי)"]);
    expect(e.conversation[2].role).toBe("notice");
    expect(e.run).toBeNull();
  });

  it("exports the run: every step, its answer, and the instruction that actually ran", () => {
    const e = buildSessionExport(
      session({
        skill: {
          skill,
          stepIdx: 3,
          answers: { audience: "הורים צעירים", mode: "generate", final: "A prompt." },
          stepDraft: "",
          finalPrompt: "A prompt.",
          askMode: false,
        },
      }),
    );
    // skillSteps() inserts the mode question before the final AI stage.
    expect(e.run!.steps.map((s) => s.id)).toEqual(["audience", "mode", "final"]);
    expect(e.run!.steps[0].answer).toBe("הורים צעירים");
    // {{audience}} was resolved by the time the final step ran.
    expect(e.run!.steps[2].instruction).toBe("For הורים צעירים: write a prompt.");
    expect(e.run!.mode).toBe("generate");
    expect(e.run!.applySettings).toEqual({ aspectRatio: "16:9" });
    expect(e.run!.finalPrompt).toBe("A prompt.");
  });

  it("marks steps that have not run yet", () => {
    const e = buildSessionExport(
      session({
        skill: { skill, stepIdx: 1, answers: { audience: "x" }, stepDraft: "", finalPrompt: null, askMode: false },
      }),
    );
    expect(e.run!.steps.map((s) => s.done)).toEqual([true, false, false]);
    expect(e.run!.steps[2].answer).toBeNull();
    // Nothing to interpolate from a step that never answered.
    expect(e.run!.steps[2].instruction).toBe("For x: write a prompt.");
  });
});

describe("jsonFileName", () => {
  it("keeps Hebrew, drops path characters, adds one extension", () => {
    expect(jsonFileName("פרסומת/מוצר")).toBe("פרסומת מוצר.json");
    expect(jsonFileName("  ")).toBe("export.json");
  });
});
