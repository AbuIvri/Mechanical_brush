// Confining the series reader to the folder the user actually picked.
//
// Kept out of the Electron module so it can be tested directly: this is the check that
// stands between "the renderer names a file" and "the app reads any file on the disk".

import path from "node:path";

/** True when `target` is the root itself or lives inside it.
 *
 *  A plain `startsWith` is not enough — "/data/photos-private" starts with
 *  "/data/photos" but is a different folder. Relative resolution answers the real
 *  question, and a path that has to climb out with ".." is refused. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** Is `target` reachable from what the user actually granted?
 *
 *  Two kinds of grant: a folder picked in a dialog (everything under it), and individual
 *  files picked in a dialog (exactly those). Anything else is refused — the renderer can
 *  name a path, but naming one must never be the same as being allowed to read it. */
export function isGranted(roots: Iterable<string>, files: Iterable<string>, target: string): boolean {
  const t = path.resolve(target);
  for (const f of files) if (path.resolve(f) === t) return true;
  for (const root of roots) if (isInside(root, t)) return true;
  return false;
}
