import { describe, it, expect } from "vitest";
import { addToMonth, aggregateMonths, backfillMonths, monthKey, monthLabel, monthRows } from "../src/spend";
import type { SpendData } from "../shared/types";

const at = (iso: string, cost: number) => ({ ts: iso, cost });

describe("monthKey", () => {
  it("keys by local month, padded", () => {
    expect(monthKey("2026-03-07T10:00:00")).toBe("2026-03");
  });
  it("crosses a year boundary without wrapping to month 0 or 13", () => {
    expect(monthKey("2025-12-31T23:00:00")).toBe("2025-12");
    expect(monthKey("2026-01-01T01:00:00")).toBe("2026-01");
  });
  it("returns nothing for an unparseable timestamp instead of NaN-NaN", () => {
    expect(monthKey("not a date")).toBe("");
  });
});

describe("aggregateMonths", () => {
  it("sums cost and counts per month", () => {
    const m = aggregateMonths([at("2026-01-05T00:00:00", 0.05), at("2026-01-20T00:00:00", 0.02), at("2026-02-01T00:00:00", 0.1)]);
    expect(m["2026-01"]).toEqual({ total: 0.07000000000000001, count: 2 });
    expect(m["2026-02"]).toEqual({ total: 0.1, count: 1 });
  });
  it("skips entries with a broken timestamp", () => {
    expect(Object.keys(aggregateMonths([at("nope", 1)]))).toEqual([]);
  });
});

describe("backfillMonths", () => {
  const base: SpendData = { total: 0.07, count: 2, entries: [at("2026-01-05T00:00:00", 0.05), at("2026-01-20T00:00:00", 0.02)] };

  it("seeds months from the entries when the file has none", () => {
    expect(backfillMonths(base).months!["2026-01"].count).toBe(2);
  });

  it("never recomputes an existing map", () => {
    // The map knows about months whose entries have already aged out of the capped log;
    // rebuilding it from `entries` would quietly erase them.
    const withOld: SpendData = { ...base, months: { "2024-05": { total: 9, count: 40 } } };
    expect(backfillMonths(withOld).months).toEqual({ "2024-05": { total: 9, count: 40 } });
  });
});

describe("addToMonth", () => {
  it("starts a month and then accumulates into it", () => {
    const one = addToMonth(undefined, "2026-08-01T00:00:00", 0.04);
    expect(one["2026-08"]).toEqual({ total: 0.04, count: 1 });
    const two = addToMonth(one, "2026-08-09T00:00:00", 0.02);
    expect(two["2026-08"].count).toBe(2);
    expect(two["2026-08"].total).toBeCloseTo(0.06, 5);
  });
  it("does not mutate what it was given", () => {
    const before = { "2026-08": { total: 1, count: 1 } };
    addToMonth(before, "2026-08-02T00:00:00", 5);
    expect(before["2026-08"].total).toBe(1);
  });
  it("leaves the map alone for an unusable timestamp", () => {
    expect(addToMonth({ "2026-08": { total: 1, count: 1 } }, "nope", 5)["2026-08"].count).toBe(1);
  });
});

describe("monthRows", () => {
  it("orders newest first, across a year boundary", () => {
    const rows = monthRows({ "2025-12": { total: 1, count: 1 }, "2026-01": { total: 2, count: 1 }, "2026-09": { total: 3, count: 1 } });
    expect(rows.map((r) => r.key)).toEqual(["2026-09", "2026-01", "2025-12"]);
  });
  it("copes with nothing at all", () => {
    expect(monthRows(undefined)).toEqual([]);
  });
});

describe("monthLabel", () => {
  it("reads as a month and a year", () => {
    expect(monthLabel("2026-08")).toContain("2026");
    expect(monthLabel("garbage")).toBe("garbage");
  });
});
