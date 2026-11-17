import { create } from "zustand";

/** The canvas view's size in screen pixels, published by CanvasStage so other panels (the
 *  navigator) can tell which part of the picture is on screen. Zoom and pan live in the
 *  main store; only the size was private to the stage. */
export const useView = create<{ w: number; h: number }>(() => ({ w: 0, h: 0 }));
