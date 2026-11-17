// Pure helpers for the Mosaic compare view. Kept side-effect-free so the
// "identical-shape selection" rule and the grid math live in ONE place (used by the
// layers panel to enable the toggle, the canvas to render, and the store to auto-exit)
// and are unit testable.
import type { Layer } from "../shared/types";

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The layers that should appear in the mosaic: visible, ticked, and sharing the FIRST
 * ticked layer's width×height. Returns [] when fewer than 2 qualify (mosaic disabled).
 */
export function getMosaicLayers(layers: Layer[], selectedIds: string[]): Layer[] {
  const sel = layers.filter((l) => l.visible && selectedIds.includes(l.id));
  if (sel.length < 2) return [];
  const shape = `${sel[0].width}x${sel[0].height}`;
  const same = sel.filter((l) => `${l.width}x${l.height}` === shape);
  return same.length >= 2 ? same : [];
}

/**
 * Grid cells that fill the canvas rect for `count` tiles. cols = ceil(sqrt(count)),
 * rows = ceil(count/cols); cells are evenly spaced with `gap` between them.
 */
export function mosaicCells(count: number, canvasW: number, canvasH: number, gap = 0): Cell[] {
  if (count <= 0) return [];
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cw = (canvasW - gap * (cols - 1)) / cols;
  const ch = (canvasH - gap * (rows - 1)) / rows;
  const cells: Cell[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cells.push({ x: col * (cw + gap), y: row * (ch + gap), w: cw, h: ch });
  }
  return cells;
}

/** Aspect-fit (contain) a source box into a cell, returning the scaled w/h. */
export function fitContain(srcW: number, srcH: number, cellW: number, cellH: number): { w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { w: cellW, h: cellH };
  const scale = Math.min(cellW / srcW, cellH / srcH);
  return { w: srcW * scale, h: srcH * scale };
}
