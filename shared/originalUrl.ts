// The URL the renderer loads a full-resolution original from. One place, because the
// main process serves the scheme and the renderer must ask for it in the same shape.

export const ORIGINAL_SCHEME = "mbrush-original";

export const originalUrl = (token: string): string => `${ORIGINAL_SCHEME}://o/${encodeURIComponent(token)}`;

export const isOriginalUrl = (src: string): boolean => src.startsWith(`${ORIGINAL_SCHEME}:`);
