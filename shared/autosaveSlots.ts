// Recovery slots: one per open document.
//
// There used to be a single slot, holding whichever tab was active when the debounce
// fired. Switching tabs replaced it, and saving or closing any tab deleted it — so a crash
// with five tabs open recovered at most one. Now every document with unsaved work has its
// own slot, named by its document id; the old single slot is still read, as "legacy".

export const LEGACY_SLOT = "legacy";

export interface AutosaveSlot {
  id: string;
  name: string;
  originalPath: string | null;
  savedAt: number;
}

/** A slot id becomes a file name, so it is held to what the app itself generates. */
export function isSlotId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Newest first — the order they are offered and restored in. */
export function sortSlots(slots: AutosaveSlot[]): AutosaveSlot[] {
  return [...slots].sort((a, b) => b.savedAt - a.savedAt);
}

// ---- Discarded work, kept in development builds ----
//
// Declining the recovery offer, or closing a tab with unsaved changes, deletes that work's
// slot. In a release that is the promise: you said no, it goes. On the developer's own
// builds a mis-click there cost a morning's project (2026-11-17), so a dev build moves the
// slot aside instead, into autosave/discarded/, never offered again but there to open.

/** Keep discarded slots? Development builds only, or a release run with MBRUSH_KEEP_DISCARDED=1. */
export function keepDiscardedSlots(isPackaged: boolean, env: Record<string, string | undefined>): boolean {
  return !isPackaged || env.MBRUSH_KEEP_DISCARDED === "1";
}

/** How many discarded projects to keep. Each can be ~100MB, so the folder is capped. */
export const DISCARDED_KEEP = 10;

/** The file name a discarded slot is kept under: when it went, then whose it was. */
export function discardedName(id: string, at: Date, ext: "mbrush" | "json"): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `${stamp}_${id}.${ext}`;
}

/** Which kept files to delete so only the newest `keep` projects remain. Names start with
 *  an ISO stamp, so they sort by time; a project's .mbrush and .json go together. */
export function discardedToPrune(names: string[], keep = DISCARDED_KEEP): string[] {
  const stems = [...new Set(names.filter((n) => /\.(mbrush|json)$/.test(n)).map((n) => n.replace(/\.(mbrush|json)$/, "")))]
    .sort()
    .reverse();
  const drop = new Set(stems.slice(keep));
  return names.filter((n) => drop.has(n.replace(/\.(mbrush|json)$/, "")));
}
