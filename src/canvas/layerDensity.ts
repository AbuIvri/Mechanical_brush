// How dense a layer's pixels are, as the canvas badge and the dock both need to know it.
//
// A fill is generated at the real pixel size of the area it covers (see fillRegion.ts),
// which depends on the natural width of each layer's image — known only once the image
// has decoded. This keeps those widths, so the badge on a rectangle and the size the dock
// predicts are worked out by the same rule the run uses.

import { useEffect, useState } from "react";
import { regionDensity, type Box as RegionBox } from "../fillRegion";
import type { Layer } from "../../shared/types";

/** Natural pixel widths of layer images, by src. Module-level so a re-render, or the
 *  canvas and the dock asking about the same picture, never decodes it twice. A src is a
 *  data URL of up to tens of MB, so the map keeps only the open project's layers — it
 *  must not be what keeps a deleted layer's pixels alive. */
const naturalWidthBySrc = new Map<string, number>();
const decoding = new Set<string>();
/** Every mounted user re-renders when any width arrives — the dock may be waiting on a
 *  picture the canvas started decoding. */
const listeners = new Set<() => void>();

export function useLayerNaturalWidths(layers: Layer[] | undefined): Map<string, number> {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    const live = new Set((layers ?? []).map((l) => l.src));
    for (const src of [...naturalWidthBySrc.keys()]) if (!live.has(src)) naturalWidthBySrc.delete(src);
    for (const src of live) {
      if (!src || naturalWidthBySrc.has(src) || decoding.has(src)) continue;
      decoding.add(src);
      const img = new window.Image();
      img.onload = () => {
        decoding.delete(src);
        naturalWidthBySrc.set(src, img.naturalWidth || img.width);
        for (const fn of listeners) fn();
      };
      img.onerror = () => decoding.delete(src);
      img.src = src;
    }
  }, [layers]);
  return naturalWidthBySrc;
}

/** The density a fill under `box` will be cut at — the same rule the store uses. */
export function markDensity(layers: Layer[], widths: Map<string, number>, box: RegionBox): number {
  return regionDensity(layers.map((l) => ({ ...l, natW: widths.get(l.src) })), box);
}

