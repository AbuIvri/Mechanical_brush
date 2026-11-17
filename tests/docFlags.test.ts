import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DOC_KEYS, extractSlice } from "../src/state/docs";

// `busy` and friends belong to ONE document. newDocTab() parks the live state into the
// tab it is leaving, so a doc-scoped flag raised before a tab switch is carried into the
// old tab and stays there — the matching reset only ever reaches the tab that is active
// at the end. That is how opening several images left the first one on the spinner.

const SRC = readFileSync("src/state/store.ts", "utf8");

/** The body of one store action, comments stripped — a comment explaining the trap is
 *  not the trap. */
function actionBody(name: string): string {
  const start = SRC.indexOf(`  ${name}(`) >= 0 ? SRC.indexOf(`  ${name}(`) : SRC.indexOf(`  async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = SRC.slice(start + 1);
  const end = rest.search(/\n {2}(?:async )?[a-zA-Z]\w*[(:]/);
  return rest
    .slice(0, end > 0 ? end : rest.length)
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

describe("document-scoped flags", () => {
  it("busy really is per-document — the whole reason this matters", () => {
    expect(DOC_KEYS).toContain("busy");
  });

  it("extractSlice carries busy into the parked tab", () => {
    const live = Object.fromEntries(DOC_KEYS.map((k) => [k, null])) as Record<string, unknown>;
    live.busy = true;
    expect(extractSlice(live).busy).toBe(true);
  });

  it("openImages does not raise busy — it switches tabs while it works", () => {
    const body = actionBody("openImages");
    expect(body).toContain("newDocTab");
    expect(body).not.toMatch(/busy:\s*(true|false)/);
  });

  it("no action that creates tabs raises a per-document flag", () => {
    // The general rule, so the next multi-tab action cannot repeat it.
    const risky = ["openImages"];
    for (const name of risky) {
      const body = actionBody(name);
      for (const k of ["busy", "genStartedAt"]) {
        expect(`${name}: ${body.includes(`${k}:`)}`).toBe(`${name}: false`);
      }
    }
  });

  it("exportAllDocs may use busy — it never switches tabs", () => {
    const body = actionBody("exportAllDocs");
    expect(body).not.toContain("newDocTab");
    expect(body).toMatch(/busy:\s*true/);
  });
});
