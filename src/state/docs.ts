// Several projects open at once.
//
// The store keeps ONE document's worth of state and 254 references to `project`, so
// threading a document id through every action was never the right change. Instead a
// document IS that slice of the store, and switching tabs swaps the slice: the live
// state is written back to the registry and the target's is loaded in. Every existing
// action keeps operating on "the current document" and none of them had to change.
//
// What did have to change is where a finished generation lands. A render started in one
// project must arrive in that project even if the user has moved on — see commitToDoc
// in store.ts, which writes either to the live state or straight into a parked slice.

import type { GenerationMode, GenerationSettings, Project, ReferenceImage } from "../../shared/types";
import { maskHasContent, type MaskState } from "../compositing";

/** One undo step. Lives here because it is document state, and both the store and the
 *  slice need to agree on its type. */
export interface Snapshot {
  project: Project;
  mask: MaskState;
  /** Optional only because snapshots taken before the erase brush existed lack it. */
  removeMask?: MaskState;
  activeLayerId: string | null;
}

/** Everything that belongs to one open document rather than to the app. */
export interface DocSlice {
  project: Project | null;
  filePath: string | null;
  dirty: boolean;
  activeLayerId: string | null;
  zoom: number;
  panX: number;
  panY: number;
  selectedLayerIds: string[];
  hoveredLayerId: string | null;
  mosaic: boolean;
  compare: boolean;
  mask: MaskState;
  /** What the erase brush painted — kept apart from `mask` so erasing never touches the
   *  region marked for an ordinary fill, and the reverse. */
  removeMask: MaskState;
  thumbnails: Record<string, string>;
  mode: GenerationMode;
  prompt: string;
  references: ReferenceImage[];
  settings: GenerationSettings;
  promptHistory: string[];
  past: Snapshot[];
  future: Snapshot[];
  /** Per document, so one project can render while another is edited. */
  busy: boolean;
  genStartedAt: number | null;
  /** A result arrived while you were looking at another tab. */
  unseen: boolean;
  /** This document's own failure. Per document because runs happen in parallel: a
   *  global error would be overwritten by whichever tab failed last, which is exactly
   *  how nine failed runs once reported as one. */
  error: string | null;
}

/** The keys that make up a document — the single source of truth for the swap, so a
 *  field can never be copied on the way out and forgotten on the way in. */
export const DOC_KEYS = [
  "project", "filePath", "dirty", "activeLayerId", "zoom", "panX", "panY",
  "selectedLayerIds", "hoveredLayerId", "mosaic", "compare", "mask", "removeMask", "thumbnails",
  "mode", "prompt", "references", "settings", "promptHistory", "past", "future",
  "busy", "genStartedAt", "unseen", "error",
] as const;

export interface OpenDoc {
  id: string;
  slice: DocSlice;
}

/** Lift the current document out of a full store state. */
export function extractSlice(state: Record<string, unknown>): DocSlice {
  const out = {} as Record<string, unknown>;
  for (const k of DOC_KEYS) out[k] = state[k];
  return out as unknown as DocSlice;
}

/** The tab's caption: the project's name, the file's name, or a placeholder. */
export function docTitle(slice: DocSlice, index: number): string {
  const name = slice.project?.name?.trim();
  if (name) return name;
  if (slice.filePath) return slice.filePath.split("/").pop() ?? `פרויקט ${index + 1}`;
  return `פרויקט ${index + 1}`;
}

/** The open documents that hold unsaved work, by tab caption. `live` is the active
 *  document's own state — its entry in `docs` is a placeholder until you switch away. */
export function unsavedDocNames(
  docs: OpenDoc[],
  activeDocId: string,
  live: Pick<DocSlice, "project" | "filePath" | "dirty">,
): string[] {
  const out: string[] = [];
  docs.forEach((d, i) => {
    const s = d.id === activeDocId ? live : d.slice;
    if (s.project && s.dirty) out.push(docTitle(s as DocSlice, i));
  });
  // Before the first tab is registered the store is the only document there is.
  if (!docs.length && live.project && live.dirty) out.push(docTitle(live as DocSlice, 0));
  return out;
}

/** One open document, as the autosave sees it. */
export interface AutosaveDoc {
  id: string;
  project: Project | null;
  filePath: string | null;
  dirty: boolean;
}

/** Every open document — the active one read from the live state, the rest from their
 *  parked slices. The single-slot autosave only ever looked at the active one. */
export function autosaveDocs(
  docs: OpenDoc[],
  activeDocId: string,
  live: Pick<DocSlice, "project" | "filePath" | "dirty">,
): AutosaveDoc[] {
  const pick = (id: string, s: Pick<DocSlice, "project" | "filePath" | "dirty">) => ({
    id, project: s.project, filePath: s.filePath, dirty: s.dirty,
  });
  if (!docs.length) return activeDocId ? [pick(activeDocId, live)] : [];
  return docs.map((d) => pick(d.id, d.id === activeDocId ? live : d.slice));
}

/** The documents whose slot is out of date: unsaved work whose project object is not the
 *  one last written. Projects are replaced, never mutated, so identity is the test. */
export function pendingAutosaves(docs: AutosaveDoc[], written: Map<string, unknown>): AutosaveDoc[] {
  return docs.filter((d) => d.project && d.dirty && written.get(d.id) !== d.project);
}

export function newDocId(): string {
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A filename that has not been used yet in this export.
 *
 *  Ten tabs opened from ten folders can easily share a filename, and silently writing
 *  one over another loses work with no error to notice. Suffix instead. */
export function uniqueExportName(base: string, used: Set<string>): string {
  const clean = (base || "ללא שם").replace(/\.(png|jpe?g|webp|tiff?|bmp|gif|mbrush)$/i, "");
  let name = clean;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${clean} (${n})`;
  used.add(name.toLowerCase());
  return name;
}

/** Why a document cannot be run right now, or null if it can.
 *
 *  This exists because "run every tab" once fired a text-to-image generate with a blank
 *  prompt at nine freshly-opened tabs — every new tab starts in `generate` mode with no
 *  prompt. Nine paid requests, nine failures, one surviving error message. A tab with
 *  nothing to run must be skipped and reported, never sent. */
export type DocRunBlock = "no-project" | "busy" | "empty-prompt" | "no-mask" | null;

export function docRunBlocker(slice: Pick<DocSlice, "project" | "busy" | "mode" | "prompt" | "mask">): DocRunBlock {
  if (!slice.project) return "no-project";
  if (slice.busy) return "busy";
  if (slice.mode === "generate" && !slice.prompt.trim()) return "empty-prompt";
  if (slice.mode === "fill" && !maskHasContent(slice.mask)) return "no-mask";
  return null;
}

export const RUN_BLOCK_LABEL: Record<NonNullable<DocRunBlock>, string> = {
  "no-project": "אין פרויקט",
  busy: "כבר רץ",
  "empty-prompt": "מצב יצירה בלי פרומפט",
  "no-mask": "מילוי בלי אזור מסומן",
};
