// How heavy a generation request actually is on the wire.
//
// Pure arithmetic on data URLs, no decoding: both sides need it — the renderer to stay
// inside its upload budget, the main process to say how much really went out when a
// request dies in transit.

/** Decoded byte length of a data URL, without materialising the bytes. */
export function dataUrlBytes(url: string | undefined): number {
  if (!url) return 0;
  const comma = url.indexOf(",");
  if (comma < 0) return url.length;
  return Math.floor((url.length - comma - 1) * 0.75);
}

/** Every image a request carries: the source, the mask, and each reference. */
export function requestBytes(req: {
  image?: string;
  mask?: string;
  references?: { src: string }[];
}): number {
  return (
    dataUrlBytes(req.image) +
    dataUrlBytes(req.mask) +
    (req.references ?? []).reduce((n, r) => n + dataUrlBytes(r.src), 0)
  );
}

export const MB = (bytes: number): string => `${(bytes / 1e6).toFixed(1)}MB`;
