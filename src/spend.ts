// Spend, grouped by month.
//
// The entry log is capped at the last 1000 generations, so months cannot be derived
// from it for long: after a busy year the early ones are simply gone. The month totals
// are therefore kept as their own running counters, incremented as spending happens,
// and only ever *seeded* from the entries.

import type { SpendData, SpendEntry } from "../shared/types";

export interface MonthTotal {
  total: number;
  count: number;
}

/** "YYYY-MM" in local time — the month the user believes they spent it in. */
export function monthKey(ts: string | number | Date): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Roll a list of entries up by month. Used to seed the counters, not to serve them. */
export function aggregateMonths(entries: SpendEntry[]): Record<string, MonthTotal> {
  const out: Record<string, MonthTotal> = {};
  for (const e of entries) {
    const k = monthKey(e.ts);
    if (!k) continue;
    const cur = out[k] ?? { total: 0, count: 0 };
    out[k] = { total: cur.total + (e.cost || 0), count: cur.count + 1 };
  }
  return out;
}

/** Give a spend file its months if it has none yet — a one-time seed from whatever
 *  entries survive. An existing map is never recomputed: it knows about months whose
 *  entries have already aged out of the log. */
export function backfillMonths(data: SpendData): SpendData {
  if (data.months && Object.keys(data.months).length) return data;
  return { ...data, months: aggregateMonths(data.entries) };
}

/** Add one generation's cost to its month. */
export function addToMonth(
  months: Record<string, MonthTotal> | undefined,
  ts: string,
  cost: number,
): Record<string, MonthTotal> {
  const k = monthKey(ts);
  const out = { ...(months ?? {}) };
  if (!k) return out;
  const cur = out[k] ?? { total: 0, count: 0 };
  out[k] = { total: cur.total + (cost || 0), count: cur.count + 1 };
  return out;
}

/** Months newest first, for the table. */
export function monthRows(months: Record<string, MonthTotal> | undefined) {
  return Object.entries(months ?? {})
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, v]) => ({ key, ...v }));
}

/** How a month reads in Hebrew: "אוגוסט 2026". */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString("he-IL", { month: "long", year: "numeric" });
}
