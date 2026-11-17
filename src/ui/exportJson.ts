// Exporting work as JSON: a workflow on its own, or a whole tab — the conversation
// plus, when a workflow ran, every step with the answer it got and the instruction
// that actually went to the model.

import type { ChatSession, SkillRun } from "../state/chat";
import { interpolate, skillSteps, type PromptSkill } from "./skills";

export interface SkillExport {
  kind: "mbrush.skill";
  version: 1;
  exportedAt: string;
  skill: PromptSkill;
}

export interface RunStepExport {
  id: string;
  kind: string;
  title: string;
  /** ai steps: the instruction after {{refs}} were filled in — what really ran. */
  instruction?: string;
  /** The user's answer, or the model's output for an ai step. */
  answer: string | null;
  done: boolean;
}

export interface SessionExport {
  kind: "mbrush.session";
  version: 1;
  exportedAt: string;
  title: string;
  model: { provider: string; model: string };
  conversation: { role: string; content: string; images?: string[] }[];
  run: {
    skill: PromptSkill;
    steps: RunStepExport[];
    mode: string | null;
    applySettings: PromptSkill["applySettings"] | null;
    finalPrompt: string | null;
  } | null;
}

const now = () => new Date().toISOString();

export function buildSkillExport(skill: PromptSkill): SkillExport {
  return { kind: "mbrush.skill", version: 1, exportedAt: now(), skill };
}

/** Replay the run for the record: each step with the answer it produced, and — for
 *  ai steps — the instruction as it stood when it ran, i.e. interpolated with the
 *  answers that existed at that point and no later ones. */
function runExport(run: SkillRun): SessionExport["run"] {
  const acc: Record<string, string> = {};
  const steps: RunStepExport[] = skillSteps(run.skill).map((s, i) => {
    const answer = run.answers[s.id];
    const entry: RunStepExport = {
      id: s.id,
      kind: s.kind,
      title: s.title,
      ...(s.kind === "ai" ? { instruction: interpolate(s.instruction ?? "", { ...acc }) } : {}),
      answer: answer ?? null,
      done: i < run.stepIdx,
    };
    if (answer !== undefined) acc[s.id] = answer;
    return entry;
  });
  return {
    skill: run.skill,
    steps,
    mode: run.answers.mode ?? null,
    applySettings: run.skill.applySettings ?? null,
    finalPrompt: run.finalPrompt,
  };
}

export function buildSessionExport(session: ChatSession): SessionExport {
  return {
    kind: "mbrush.session",
    version: 1,
    exportedAt: now(),
    title: session.title,
    model: { provider: session.provider, model: session.model },
    conversation: session.msgs.map((m) => ({
      role: m.notice ? "notice" : m.role,
      content: m.content,
      ...(m.ctxLabels?.length ? { images: m.ctxLabels } : {}),
    })),
    run: session.skill ? runExport(session.skill) : null,
  };
}

/** btoa() is Latin-1 only, and every label here is Hebrew. */
function jsonDataUrl(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:application/json;base64,${btoa(bin)}`;
}

/** Keep it a legal, single-extension filename. */
export function jsonFileName(base: string): string {
  const clean = base.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "export";
  return `${clean.slice(0, 60)}.json`;
}

/** Save through a native save dialog. exportImage is the app's generic "write this
 *  data URL to a file the user picks" channel — it decodes any base64 data URL and
 *  takes the extension from the name, so JSON needs no second IPC route. */
export async function saveJson(data: unknown, baseName: string): Promise<string | null> {
  const res = await window.mbrush.exportImage(jsonDataUrl(JSON.stringify(data, null, 2)), jsonFileName(baseName));
  if (!res.ok) throw new Error(res.error ?? "הייצוא נכשל");
  return res.data?.path ?? null;
}
