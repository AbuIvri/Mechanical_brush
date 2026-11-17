// Separate areas of a mask — so the erase brush can run one patch per object.
//
// Pure: works on an alpha array, no canvas. The canvas side (rasterizing the mask to a
// small proxy and turning each area back into a doc-sized bitmap) lives in compositing.

export interface RegionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 4-connected components of the pixels whose alpha is above `threshold`. Boxes are in
 *  the array's own pixel space; `labels` maps each pixel to its component (0 = none). */
export function labelRegions(
  alpha: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 8,
): { boxes: RegionBox[]; labels: Int32Array } {
  const labels = new Int32Array(width * height);
  const boxes: RegionBox[] = [];
  const stack: number[] = [];
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] || alpha[start] <= threshold) continue;
    const id = boxes.length + 1;
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    labels[start] = id;
    stack.push(start);
    // An explicit stack: recursion on a large brushed area would blow the call stack.
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const visit = (j: number) => {
        if (!labels[j] && alpha[j] > threshold) {
          labels[j] = id;
          stack.push(j);
        }
      };
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (y > 0) visit(i - width);
      if (y < height - 1) visit(i + width);
    }
    boxes.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return { boxes, labels };
}

const padded = (b: RegionBox, pad: number): RegionBox => {
  const p = Math.max(pad, Math.round(Math.max(b.w, b.h) * 0.14));
  return { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p };
};

const overlaps = (a: RegionBox, b: RegionBox) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Group areas whose padded boxes overlap — the padding matches what a fill run adds
 *  around its region, so two groups here are two patches that never share a pixel.
 *  Returns, for each group, the indices into `boxes` it holds. Repeats until stable: a
 *  merge grows a box, and the bigger box can now reach a third area. */
export function mergeNearby(boxes: RegionBox[], pad = 24): number[][] {
  let groups = boxes.map((b, i) => ({ box: b, members: [i] }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (overlaps(padded(groups[i].box, pad), padded(groups[j].box, pad))) {
          const a = groups[i].box;
          const b = groups[j].box;
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          groups[i] = {
            box: { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y },
            members: [...groups[i].members, ...groups[j].members],
          };
          groups.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return groups.map((g) => g.members.sort((a, b) => a - b));
}
