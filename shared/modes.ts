import type { GenerationMode } from "./types.js";

/** The Hebrew name of each generation mode.
 *
 *  Pure and dependency-free on purpose: the store builds a zustand store at import time
 *  and touches localStorage, so anything that only needs a label should not have to drag
 *  that in — tests included.
 */
export function modeLabel(m: GenerationMode): string {
  return {
    upscale: "אפסקייל",
    recreate: "יצירה מחדש",
    fill: "מילוי גנרטיבי",
    generate: "יצירה",
    expand: "הרחבה",
    ratio: "שינוי פורמט",
    removebg: "הסרת רקע",
  }[m];
}

/** The modes the generation dock offers, in the order it shows them. `expand` is a
 *  separate canvas flow and deliberately absent. */
export const DOCK_MODES: GenerationMode[] = [
  "upscale",
  "recreate",
  "removebg",
  "fill",
  "ratio",
  "generate",
];
