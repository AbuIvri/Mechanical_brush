// What the debug folder keeps, as pure decisions (no Electron, no disk).
//
// The dumps of what was sent to an engine and what came back were written on every run,
// in every build, forever: 18GB on the machine they were measured on. They are a
// development aid, so a packaged build writes none unless asked, and what a development
// build writes is capped.

export const DEBUG_CAP_BYTES = 2 * 1024 * 1024 * 1024;

/** Dumps are for development: on when running from source, or when asked for by name. */
export function debugDumpsEnabled(isPackaged: boolean, env: Record<string, string | undefined>): boolean {
  return !isPackaged || env.MBRUSH_DEBUG === "1";
}

export interface DebugFile {
  name: string;
  size: number;
  mtimeMs: number;
}

/** Which files to delete so the capped ones fit in `maxBytes`: oldest first.
 *
 *  Only files written at or after `capStart` count and only they can be deleted — what was
 *  in the folder before the cap existed is the user's to keep or clear, never ours. */
export function pickForPruning(files: DebugFile[], capStart: number, maxBytes: number = DEBUG_CAP_BYTES): string[] {
  const ours = files.filter((f) => f.mtimeMs >= capStart).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = ours.reduce((n, f) => n + f.size, 0);
  const out: string[] = [];
  for (const f of ours) {
    if (total <= maxBytes) break;
    out.push(f.name);
    total -= f.size;
  }
  return out;
}
