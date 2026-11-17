// The names of the icons the app draws, as plain data — so files that only describe the
// interface (toolbarItems.ts) can name an icon without importing React.

export const ICON_NAMES = [
  // tools
  "move", "rect", "brush", "pin", "text", "arrow", "wand", "target", "heal", "eraser", "hand", "pen", "frame",
  // tool actions and toggles
  "rotate-ccw", "rotate-cw", "square", "clear-rect", "clear-notes", "mask-view", "compare", "checker", "zoom", "scan", "pencil",
  // layers
  "eye", "eye-off", "lock", "unlock", "up", "down", "expand", "contain", "sliders", "droplet", "duplicate",
  "merge-down", "export", "trash", "plus", "flatten", "mosaic", "stack", "dock-pin", "chevron",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
