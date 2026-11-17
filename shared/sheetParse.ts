// Delimited-text parsing for the series dataset. Pure text in, rows out — no Electron
// and no filesystem, so it is testable and shared by both sides of the app.

import type { SheetData } from "./types";

/** Split one CSV/TSV line, honouring quoted fields and doubled quotes inside them. */
export function splitDelimited(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Rows keyed by the header line. Blank rows are dropped, not kept as empty subjects. */
export function parseDelimited(text: string, delim: string): SheetData {
  // A BOM would otherwise become part of the first column's name, and every lookup
  // against that column would silently miss.
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return { columns: [], rows: [] };
  const columns = splitDelimited(lines[0], delim).map((c, i) => c || `עמודה ${i + 1}`);
  const rows = lines.slice(1).map((line) => {
    const cells = splitDelimited(line, delim);
    const row: Record<string, string> = {};
    columns.forEach((c, i) => (row[c] = cells[i] ?? ""));
    return row;
  });
  return { columns, rows: rows.filter((r) => Object.values(r).some((v) => v !== "")) };
}
