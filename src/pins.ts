// Numbered pins: a point on the canvas and the change wanted there.
//
// Pure on purpose — no store, no DOM. The store builds a zustand store at import time and
// touches localStorage, so anything tests need has to live outside it.

import type { Annotation } from "../shared/types";

export type Pin = Extract<Annotation, { kind: "pin" }>;

/** The tag typed into the prompt box. The emoji is the whole syntax: it cannot occur in a
 *  prompt by accident, so a digit after it is always a pin number. */
export const PIN_TAG = "📍";
const TAG_RE = /📍\s?(\d+)/gu;

export const pinsOf = (items: Annotation[] | undefined): Pin[] =>
  (items ?? []).filter((a): a is Pin => a.kind === "pin").sort((a, b) => a.n - b.n);

/** The next pin number: one past both the highest pin on the canvas and the highest ever
 *  handed out (`seq`), so a deleted pin's number is never reused and a tag already typed
 *  for it can't quietly land on a new spot. `seq` is optional because projects saved
 *  before pins existed don't have one. */
export function nextPinNumber(items: Annotation[] | undefined, seq = 0): number {
  return Math.max(seq, pinsOf(items).reduce((m, p) => Math.max(m, p.n), 0)) + 1;
}

/** Percent of the image from the top-left, clamped and rounded — the form the image
 *  models read reliably, and the one ChatGPT's own point edits use. */
export function pinPercent(pin: { x: number; y: number }, width: number, height: number): { x: number; y: number } {
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
  return { x: clamp((pin.x / width) * 100), y: clamp((pin.y / height) * 100) };
}

const coords = (pin: Pin, w: number, h: number) => {
  const p = pinPercent(pin, w, h);
  return `(x: ${p.x}%, y: ${p.y}%)`;
};

/** The pin list the assistant reads, one line per pin. A pin with no note says so out
 *  loud — that is the model's cue to ask. */
export function pinListNote(pins: Pin[], width: number, height: number): string {
  if (!pins.length) return "";
  const lines = pins.map((p) =>
    `סיכה ${p.n} ${coords(p, width, height)}: ${p.note.trim() ? `"${p.note.trim()}"` : "ללא הערה"}`,
  );
  return (
    `על הקנבס ${pins.length === 1 ? "סיכה ממוספרת אחת" : `${pins.length} סיכות ממוספרות`} ` +
    "(המיקום באחוזים מרוחב וגובה התמונה, מהפינה השמאלית העליונה):\n" +
    lines.join("\n")
  );
}

/** The line appended after tags are expanded. English, because it goes to the engine. */
export const PIN_LEGEND =
  "Pin coordinates are percentages of the image width and height, measured from the " +
  "top-left corner. Apply each change only at its pin and leave the rest of the image unchanged.";

/** Every pin number the prompt names, in order of first appearance. */
export function pinTagsIn(prompt: string): number[] {
  const seen: number[] = [];
  for (const m of prompt.matchAll(TAG_RE)) {
    const n = Number(m[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}

/** Turn "📍1 make it asphalt" into "pin 1 (x: 58%, y: 95%) make it asphalt".
 *
 *  `missing` lists tags with no pin behind them; the caller refuses the run rather than
 *  send a coordinate-less instruction the model would apply somewhere at random. */
export function expandPinTags(
  prompt: string,
  pins: Pin[],
  width: number,
  height: number,
): { text: string; used: number[]; missing: number[] } {
  const named = pinTagsIn(prompt);
  if (!named.length) return { text: prompt, used: [], missing: [] };
  const byN = new Map(pins.map((p) => [p.n, p]));
  const missing = named.filter((n) => !byN.has(n));
  const used = named.filter((n) => byN.has(n));
  const text = prompt.replace(TAG_RE, (whole, d: string) => {
    const pin = byN.get(Number(d));
    return pin ? `pin ${pin.n} ${coords(pin, width, height)}` : whole;
  });
  return { text: used.length ? `${text.trim()}\n${PIN_LEGEND}` : text, used, missing };
}
