// Matching the folders on disk to the rows in the spreadsheet.
//
// Everything here was written against a real dataset — 30 folders of photos and an HR
// sheet of 34 people — and every rule below exists because that data broke a simpler
// version of this code:
//   · the person's name is split across two columns (first / last), in either order;
//   · folder names carry noise: "תמונות מיכל ששון", "אריק כרסנטי תמונות", "עומר בר נוב -תמונות";
//   · and after all of that, two folders still don't match, because "מיקי" is the sheet's
//     "מיכאל" and "רון בן סימון" is its "אהרון בן סמון". No string rule solves those —
//     a person (or a model) has to decide, which is what `unmatched` is for.

import type { DatasetFolder } from "../../shared/types";

export interface JoinedItem {
  /** The person, as the run will refer to them from here on. */
  name: string;
  folder: DatasetFolder;
  row: Record<string, string>;
  /** How the pair was made — shown in the review so a loose match can be checked. */
  via: "exact" | "normalized" | "manual";
}

export interface JoinResult {
  matched: JoinedItem[];
  foldersWithoutRow: DatasetFolder[];
  rowsWithoutFolder: Record<string, string>[];
}

/** Words in a folder name that describe the folder, not the person. */
const NOISE = ["תמונות", "תמונה", "צילומים", "photos", "photo", "images", "pics"];

/** Fold away the differences that are never meaningful in a name. */
export function normalizeKey(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[_\-–—.,'"()]+/g, " ")
    .replace(/\s+/g, " ")
    // Hebrew final forms, so "ששון" and "ששונ" are not two different people.
    .replace(/ך/g, "כ")
    .replace(/ם/g, "מ")
    .replace(/ן/g, "נ")
    .replace(/ף/g, "פ")
    .replace(/ץ/g, "צ")
    .trim();
}

/** A folder name reduced to just the person in it.
 *
 *  Note the plain split/join instead of a \b word boundary: in JavaScript \b is defined
 *  on [A-Za-z0-9_], so beside Hebrew letters it never matches and the noise word
 *  survives — which is exactly why an earlier version matched 0 of 30 folders. */
export function folderPerson(folderName: string): string {
  let s = normalizeKey(folderName);
  for (const n of NOISE) s = s.split(normalizeKey(n)).join(" ");
  return s.replace(/\s+/g, " ").trim();
}

/** Every way this row might name its person: "first last" and "last first". */
export function rowNameKeys(row: Record<string, string>, nameColumns: string[]): string[] {
  const parts = nameColumns.map((c) => (row[c] ?? "").trim()).filter(Boolean);
  if (!parts.length) return [];
  if (parts.length === 1) return [normalizeKey(parts[0])];
  const joined = normalizeKey(parts.join(" "));
  const reversed = normalizeKey([...parts].reverse().join(" "));
  return joined === reversed ? [joined] : [joined, reversed];
}

/** The display name for a row — the name columns in the order given. */
export function rowDisplayName(row: Record<string, string>, nameColumns: string[]): string {
  return nameColumns.map((c) => (row[c] ?? "").trim()).filter(Boolean).join(" ");
}

/** Pair folders with rows. `manual` overrides (folder name → row name) are applied
 *  first and win outright — they are how a human resolves what the rules cannot. */
export function joinDataset(
  folders: DatasetFolder[],
  rows: Record<string, string>[],
  nameColumns: string[],
  manual: Record<string, string> = {},
): JoinResult {
  const byKey = new Map<string, Record<string, string>[]>();
  const byDisplay = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const display = rowDisplayName(row, nameColumns);
    if (!display) continue;
    byDisplay.set(display, row);
    for (const k of rowNameKeys(row, nameColumns)) {
      byKey.set(k, [...(byKey.get(k) ?? []), row]);
    }
  }

  const matched: JoinedItem[] = [];
  const foldersWithoutRow: DatasetFolder[] = [];
  const used = new Set<Record<string, string>>();

  for (const folder of folders) {
    const forced = manual[folder.name];
    if (forced && byDisplay.has(forced)) {
      const row = byDisplay.get(forced)!;
      matched.push({ name: forced, folder, row, via: "manual" });
      used.add(row);
      continue;
    }
    const key = folderPerson(folder.name);
    const hits = (byKey.get(key) ?? []).filter((r) => !used.has(r));
    // One candidate is a match. Two means the data is ambiguous, and guessing there
    // would quietly attach a person's photos to someone else's row.
    if (hits.length === 1) {
      const row = hits[0];
      const exact = rowNameKeys(row, nameColumns).includes(normalizeKey(folder.name));
      matched.push({ name: rowDisplayName(row, nameColumns), folder, row, via: exact ? "exact" : "normalized" });
      used.add(row);
    } else {
      foldersWithoutRow.push(folder);
    }
  }

  return {
    matched,
    foldersWithoutRow,
    rowsWithoutFolder: rows.filter((r) => !used.has(r) && rowDisplayName(r, nameColumns)),
  };
}

/** The columns that look like they hold the person's name. Prefers a pair of columns
 *  whose combination lines up with the folder names, since a split first/last name is
 *  the common case in an exported HR sheet. */
export function guessNameColumns(
  folders: DatasetFolder[],
  sheet: { columns: string[]; rows: Record<string, string>[] },
): string[] {
  const targets = new Set(folders.map((f) => folderPerson(f.name)));
  const score = (cols: string[]) =>
    sheet.rows.filter((r) => rowNameKeys(r, cols).some((k) => targets.has(k))).length;

  let best: string[] = sheet.columns.slice(0, 1);
  let bestScore = score(best);
  for (const a of sheet.columns) {
    const single = score([a]);
    if (single > bestScore) {
      best = [a];
      bestScore = single;
    }
    for (const b of sheet.columns) {
      if (a === b) continue;
      const pair = score([a, b]);
      if (pair > bestScore) {
        best = [a, b];
        bestScore = pair;
      }
    }
  }
  return best;
}
