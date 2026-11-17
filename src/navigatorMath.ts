// The navigator's geometry, kept apart from React so it can be tested.
//
// The canvas draws the picture at `zoom`, shifted by (panX, panY) screen pixels, in a view
// of viewW × viewH. A layer sits on the picture at (x, y, w, h). The navigator shows that
// layer whole, and marks the part of it that is on screen.

export interface Box { x: number; y: number; w: number; h: number }
export interface View { zoom: number; panX: number; panY: number; viewW: number; viewH: number }

/** The on-screen part of `layer`, as fractions of the layer (0..1), or null when the whole
 *  layer is in view (nothing to mark) or none of it is. */
export function visibleFraction(layer: Box, v: View): Box | null {
  if (!(v.zoom > 0) || !(layer.w > 0) || !(layer.h > 0) || !(v.viewW > 0) || !(v.viewH > 0)) return null;
  // The view, in picture coordinates.
  const vx = -v.panX / v.zoom, vy = -v.panY / v.zoom, vw = v.viewW / v.zoom, vh = v.viewH / v.zoom;
  const x0 = Math.max(layer.x, vx), y0 = Math.max(layer.y, vy);
  const x1 = Math.min(layer.x + layer.w, vx + vw), y1 = Math.min(layer.y + layer.h, vy + vh);
  if (x1 <= x0 || y1 <= y0) return null;
  const f = { x: (x0 - layer.x) / layer.w, y: (y0 - layer.y) / layer.h, w: (x1 - x0) / layer.w, h: (y1 - y0) / layer.h };
  const whole = f.x <= 0.001 && f.y <= 0.001 && f.w >= 0.998 && f.h >= 0.998;
  return whole ? null : f;
}

/** The pan that puts the point at fraction (u, v) of `layer` in the middle of the view. */
export function panToCenter(layer: Box, u: number, v: number, view: View): { panX: number; panY: number } {
  const cx = layer.x + Math.max(0, Math.min(1, u)) * layer.w;
  const cy = layer.y + Math.max(0, Math.min(1, v)) * layer.h;
  return { panX: Math.round(view.viewW / 2 - cx * view.zoom), panY: Math.round(view.viewH / 2 - cy * view.zoom) };
}
