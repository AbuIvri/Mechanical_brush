// The ink, for the canvas.
//
// Konva draws with literal colours, so the one ink value the canvas needs is repeated
// here (tests/inkDiscipline.test.ts holds it equal to `--ink` in styles.css, and allows
// the literal in this file and nowhere else). On the canvas the ink appears only as the
// design system lets it: a hatch over what the person marked, and the plate behind a
// pin's number.
//
// None of this reaches an engine. The masks sent to engines are rasterised elsewhere
// (opaque white), and the picture shown to the prompt assistant is drawn by
// compositing.ts in the user's own note colours.

export const INK = "#e96a1b";
/** What sits on a wet stroke (`--on-ink`). */
export const ON_INK = "#1b1b1b";

const tiles = new Map<string, HTMLCanvasElement>();

/** A repeating tile of diagonal ink lines, `gap` document pixels apart: one direction for
 *  "fill this", crossed for "erase this" (crossed out). Tiles are made once per size. */
export function hatchTile(gap: number, crossed = false): HTMLCanvasElement {
  const g = Math.max(4, Math.round(gap));
  const key = `${g}:${crossed ? "x" : "/"}`;
  const hit = tiles.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = g;
  c.height = g;
  const ctx = c.getContext("2d")!;
  ctx.strokeStyle = INK;
  ctx.lineWidth = Math.max(1, g * 0.26);
  ctx.lineCap = "square";
  // Each diagonal is drawn with its two wrap-around neighbours so the tile is seamless.
  const diag = (flip: boolean) => {
    for (const o of [-g, 0, g]) {
      ctx.beginPath();
      if (flip) { ctx.moveTo(o, 0); ctx.lineTo(o + g, g); }
      else { ctx.moveTo(o, g); ctx.lineTo(o + g, 0); }
      ctx.stroke();
    }
  };
  diag(false);
  if (crossed) diag(true);
  tiles.set(key, c);
  return c;
}

/** The hatch spacing for a document: about 110 lines across its long edge, so the marks
 *  read the same on a small picture and a large one at the fit-to-window zoom. */
export function hatchGap(width: number, height: number): number {
  return Math.max(6, Math.round(Math.max(width, height) / 110));
}

/** A copy of a selection bitmap (alpha = selected) veiled in steel and hatched in ink. */
export function hatchBitmap(src: CanvasImageSource & { width: number; height: number }, tile: HTMLCanvasElement, veil: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = ctx.createPattern(tile, "repeat")!;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}
