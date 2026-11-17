import type { Project } from "../../shared/types.js";

export const MBRUSH_FORMAT = "mechanical-brush-project";
export const MBRUSH_VERSION = 1;

interface MBrushFile {
  format: string;
  version: number;
  project: Project;
}

/**
 * Serialize a project to the .mbrush container.
 * MVP uses a single JSON document with assets inlined as data URLs.
 * NOTE: API keys are never part of a project and must not be serialized here.
 */
export function serializeProject(project: Project): string {
  const safe: Project = { ...project, updatedAt: new Date().toISOString() };
  const file: MBrushFile = {
    format: MBRUSH_FORMAT,
    version: MBRUSH_VERSION,
    project: safe,
  };
  return JSON.stringify(file, null, 2);
}

export function deserializeProject(raw: string): Project {
  let parsed: MBrushFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("קובץ הפרויקט פגום (JSON לא תקין)");
  }
  if (parsed.format !== MBRUSH_FORMAT) {
    throw new Error("זה אינו קובץ .mbrush תקין");
  }
  if (parsed.version > MBRUSH_VERSION) {
    throw new Error(
      `הפרויקט נוצר בגרסה חדשה יותר (${parsed.version}). עדכן את האפליקציה.`,
    );
  }
  const p = parsed.project;
  if (!p?.canvas || !Array.isArray(p.layers)) {
    throw new Error("מבנה הפרויקט אינו תקין");
  }
  // Light normalization / forward-compat defaults.
  p.references ??= [];
  p.promptHistory ??= [];
  p.jobs ??= [];
  return p;
}
