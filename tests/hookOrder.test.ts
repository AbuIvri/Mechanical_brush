import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// A hook placed after an early return runs only on some renders. React then throws
// "Rendered more hooks than during the previous render", the tree unmounts, and the
// window goes black. TypeScript cannot see it and nothing here renders components, so
// this reads the source instead.
//
// Heuristic, deliberately: at two-space indentation we are in a component's own body.
// A `return` there ends some renders early, and every hook must come before it.

const HOOK = /^ {2}(?:const .*?=\s*)?(use[A-Z]\w*)\s*\(/;
/** A return that ends the render early: an `if (...) {` block at the body's own level. */
const EARLY_IF = /^ {2}if \s*\(.*\)\s*\{/;
/** Where a new top-level function body begins — every form this codebase uses. */
const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?const\s+[A-Z]\w*\s*[:=]/;

function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...componentFiles(p));
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Split a file into its top-level function bodies, so one component's final return is
 *  never mistaken for another component's early one. */
function blocks(src: string): { start: number; lines: string[] }[] {
  const lines = src.split("\n");
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (DECL.test(l)) starts.push(i);
  });
  return starts.map((s, k) => ({
    start: s,
    lines: lines.slice(s, starts[k + 1] ?? lines.length),
  }));
}

/** Hooks that sit after an early return inside the same body. */
function hooksAfterEarlyReturn(src: string): { hook: string; line: number; after: number }[] {
  const bad: { hook: string; line: number; after: number }[] = [];
  for (const b of blocks(src)) {
    let early = -1;
    for (let i = 0; i < b.lines.length; i++) {
      const l = b.lines[i];
      // An `if (…) {` at body level that contains a return ends some renders early.
      if (early === -1 && EARLY_IF.test(l)) {
        const closes = b.lines.slice(i).findIndex((x, k) => k > 0 && /^ {2}\}/.test(x));
        const body = b.lines.slice(i, closes > 0 ? i + closes : i + 12).join("\n");
        if (/\breturn\b/.test(body)) early = i;
      }
      const m = l.match(HOOK);
      if (m && early !== -1 && i > early) {
        bad.push({ hook: m[1], line: b.start + i + 1, after: b.start + early + 1 });
      }
    }
  }
  return bad;
}

describe("hooks never sit after an early return", () => {
  const files = [...componentFiles("src/ui"), ...componentFiles("src/canvas"), "src/App.tsx"];

  it("scans every component file", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const f of files) {
    it(path.basename(f), () => {
      const bad = hooksAfterEarlyReturn(readFileSync(f, "utf8"));
      expect(
        bad.map((b) => `${b.hook} on line ${b.line}, after the early return on line ${b.after}`),
      ).toEqual([]);
    });
  }
});

describe("the rule this encodes", () => {
  it("catches the exact shape that blanked the assistant", () => {
    const broken = `
export function Panel() {
  const [a, setA] = useState(0);
  if (!open) {
    return <button />;
  }
  const [b, setB] = useState(1);
  return <div />;
}`;
    const bad = hooksAfterEarlyReturn(broken);
    expect(bad).toHaveLength(1);
    expect(bad[0].hook).toBe("useState");
  });

  it("does not flag a component whose hooks all come first", () => {
    const fine = `
export function Panel() {
  const [a, setA] = useState(0);
  const [b, setB] = useState(1);
  if (!open) {
    return <button />;
  }
  return <div />;
}`;
    expect(hooksAfterEarlyReturn(fine)).toEqual([]);
  });
});
