import type { MBrushApi } from "../electron/preload";

declare global {
  interface Window {
    mbrush: MBrushApi;
  }
}

export {};
