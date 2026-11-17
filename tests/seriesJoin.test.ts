import { describe, it, expect } from "vitest";
import { folderPerson, guessNameColumns, joinDataset, normalizeKey, rowNameKeys } from "../src/series/join";
import type { DatasetFolder } from "../shared/types";

const folder = (name: string): DatasetFolder => ({ name, path: `/root/${name}`, images: [] });
// The shape the real HR export has: the name split across two columns.
const p = (last: string, first: string, extra: Record<string, string> = {}) => ({
  "שם משפחה": last, "שם פרטי": first, ...extra,
});
const NAME_COLS = ["שם פרטי", "שם משפחה"];

describe("folderPerson", () => {
  it("drops the folder's noise words in every position", () => {
    // These three spellings are all in the real dataset.
    expect(folderPerson("תמונות מיכל ששון")).toBe(folderPerson("מיכל ששון"));
    expect(folderPerson("אריק כרסנטי תמונות")).toBe(folderPerson("אריק כרסנטי"));
    expect(folderPerson("עומר בר נוב -תמונות")).toBe(folderPerson("עומר בר נוב"));
  });

  it("strips the noise word even though \\b never matches beside Hebrew", () => {
    // A /\bתמונות\b/ version of this matched 0 of 30 folders: in JavaScript \b is
    // defined on [A-Za-z0-9_], so between a space and "ת" there is no boundary.
    expect(folderPerson("תמונות דוד זיסמן")).not.toContain("תמונות");
  });
});

describe("normalizeKey", () => {
  it("folds case, spacing and separators", () => {
    expect(normalizeKey("  Alfa_Romeo ")).toBe("alfa romeo");
    expect(normalizeKey("Alfa-Romeo")).toBe(normalizeKey("alfa romeo"));
  });
  it("treats Hebrew final letters as the same letter", () => {
    expect(normalizeKey("ששון")).toBe(normalizeKey("ששונ"));
  });
});

describe("rowNameKeys", () => {
  it("offers both name orders, because folders use both", () => {
    expect(rowNameKeys(p("ששון", "מיכל"), NAME_COLS)).toEqual([
      normalizeKey("מיכל ששון"),
      normalizeKey("ששון מיכל"),
    ]);
  });
});

describe("joinDataset", () => {
  const rows = [
    p("ששון", "מיכל", { תפקיד: "פיתוח" }),
    p("כרסנטי", "אריק"),
    p("סילברסטון", "מיכאל"),
    p("ליפר", "נטלי"),
  ];

  it("matches the real folder spellings against a split name", () => {
    const r = joinDataset(
      [folder("תמונות מיכל ששון"), folder("אריק כרסנטי תמונות")],
      rows,
      NAME_COLS,
    );
    expect(r.matched.map((m) => m.name)).toEqual(["מיכל ששון", "אריק כרסנטי"]);
    expect(r.matched[0].row.תפקיד).toBe("פיתוח");
    expect(r.matched[0].via).toBe("normalized");
  });

  it("leaves a nickname unmatched instead of guessing", () => {
    // "מיקי סילברסטון" on disk is "מיכאל סילברסטון" in the sheet. No string rule gets
    // that right, and inventing the link would attach the wrong person's photos.
    const r = joinDataset([folder("תמונות מיקי סילברסטון")], rows, NAME_COLS);
    expect(r.matched).toEqual([]);
    expect(r.foldersWithoutRow.map((f) => f.name)).toEqual(["תמונות מיקי סילברסטון"]);
    expect(r.rowsWithoutFolder.length).toBe(4);
  });

  it("accepts a human's decision through the manual map", () => {
    const r = joinDataset([folder("תמונות מיקי סילברסטון")], rows, NAME_COLS, {
      "תמונות מיקי סילברסטון": "מיכאל סילברסטון",
    });
    expect(r.matched[0].name).toBe("מיכאל סילברסטון");
    expect(r.matched[0].via).toBe("manual");
    expect(r.rowsWithoutFolder.map((x) => x["שם פרטי"])).not.toContain("מיכאל");
  });

  it("reports rows that never got a folder", () => {
    const r = joinDataset([folder("תמונות מיכל ששון")], rows, NAME_COLS);
    expect(r.rowsWithoutFolder.map((x) => x["שם פרטי"])).toContain("נטלי");
  });

  it("never hands the same row to two folders", () => {
    const r = joinDataset([folder("תמונות מיכל ששון"), folder("מיכל ששון תמונות")], rows, NAME_COLS);
    expect(r.matched).toHaveLength(1);
    expect(r.foldersWithoutRow).toHaveLength(1);
  });

  it("skips rows whose name cells are empty", () => {
    const r = joinDataset([folder("תמונות מיכל ששון")], [...rows, p("", "")], NAME_COLS);
    expect(r.rowsWithoutFolder.every((x) => (x["שם פרטי"] || x["שם משפחה"]).trim())).toBe(true);
  });
});

describe("guessNameColumns", () => {
  it("finds the first/last pair rather than a single column", () => {
    const sheet = {
      columns: ["מספר עובד", "שם משפחה", "שם פרטי", "מחלקה"],
      rows: [p("ששון", "מיכל", { "מספר עובד": "1241", מחלקה: "פיתוח" })],
    };
    const cols = guessNameColumns([folder("תמונות מיכל ששון")], sheet);
    expect(cols.sort()).toEqual(["שם משפחה", "שם פרטי"]);
  });
});
