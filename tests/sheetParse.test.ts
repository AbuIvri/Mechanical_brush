import { describe, it, expect } from "vitest";
import { parseDelimited, splitDelimited } from "../shared/sheetParse";

describe("splitDelimited", () => {
  it("keeps a comma that lives inside quotes", () => {
    expect(splitDelimited('אבנר,"מכונאי, ותיק",1974', ",")).toEqual(["אבנר", "מכונאי, ותיק", "1974"]);
  });
  it("unescapes a doubled quote", () => {
    expect(splitDelimited('a,"say ""hi""",b', ",")).toEqual(["a", 'say "hi"', "b"]);
  });
  it("keeps empty cells in place", () => {
    expect(splitDelimited("a,,c", ",")).toEqual(["a", "", "c"]);
  });
});

describe("parseDelimited", () => {
  it("keys the rows by the header", () => {
    const s = parseDelimited("שם,תפקיד\nאבנר,מכונאי\nדנה,רופאה", ",");
    expect(s.columns).toEqual(["שם", "תפקיד"]);
    expect(s.rows).toHaveLength(2);
    expect(s.rows[1]).toEqual({ שם: "דנה", תפקיד: "רופאה" });
  });

  it("strips a UTF-8 BOM instead of gluing it to the first column name", () => {
    // Excel writes one, and every lookup against that column would silently miss.
    const s = parseDelimited("﻿name,role\nAvner,mechanic", ",");
    expect(s.columns[0]).toBe("name");
    expect(s.rows[0].name).toBe("Avner");
  });

  it("handles CRLF endings and drops blank lines", () => {
    const s = parseDelimited("a,b\r\n1,2\r\n\r\n3,4\r\n", ",");
    expect(s.rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
  });

  it("pads a short row rather than shifting its cells", () => {
    const s = parseDelimited("a,b,c\n1,2", ",");
    expect(s.rows[0]).toEqual({ a: "1", b: "2", c: "" });
  });

  it("names an unnamed column instead of collapsing two of them", () => {
    const s = parseDelimited("שם,,תפקיד\nא,ב,ג", ",");
    expect(s.columns).toEqual(["שם", "עמודה 2", "תפקיד"]);
    expect(s.rows[0]["עמודה 2"]).toBe("ב");
  });

  it("reads tabs when told to", () => {
    expect(parseDelimited("a\tb\n1\t2", "\t").rows[0]).toEqual({ a: "1", b: "2" });
  });

  it("returns nothing for an empty file", () => {
    expect(parseDelimited("   \n\n", ",")).toEqual({ columns: [], rows: [] });
  });
});
