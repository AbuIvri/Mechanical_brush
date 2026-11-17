// What the toolbar is made of, as data.
//
// The bar used to be six hard-coded groups with contextual controls wedged between
// them. It is now a flat, ordered list of items the user can rearrange and hide — and
// the default order below reproduces the old bar exactly, so nothing moves for anyone
// who never opens the editor. Rendering still lives in Toolbar.tsx, keyed by id; this
// file only says what exists, what it is called, and in what order it starts.

import type { IconName } from "./iconNames";

export type ToolbarKind = "tool" | "note" | "aux" | "divider";

export interface ToolbarItem {
  id: string;
  kind: ToolbarKind;
  /** The icon drawn in the bar — a name from iconNames.ts (dividers have none). */
  icon?: IconName;
  /** The name in the customise editor, and the tooltip's first line. */
  label: string;
}

export const TOOLBAR_ITEMS: ToolbarItem[] = [
  { id: "div:arrange", kind: "divider", label: "הזזה" },
  { id: "tool:move", kind: "tool", icon: "move", label: "הזזה ומתיחה" },
  { id: "aux:rotateCCW", kind: "aux", icon: "rotate-ccw", label: "סובב נגד השעון" },
  { id: "aux:rotateCW", kind: "aux", icon: "rotate-cw", label: "סובב עם השעון" },

  { id: "div:mark", kind: "divider", label: "סימון" },
  { id: "tool:rect", kind: "tool", icon: "rect", label: "סימון מלבני" },
  { id: "tool:brush", kind: "tool", icon: "brush", label: "מברשת סימון" },
  { id: "aux:rectSquare", kind: "aux", icon: "square", label: "נעילה לריבוע" },
  { id: "aux:clearMask", kind: "aux", icon: "clear-rect", label: "נקה סימון" },

  { id: "div:note", kind: "divider", label: "הסבר" },
  { id: "note:brush", kind: "note", icon: "pen", label: "ציור חופשי" },
  { id: "note:text", kind: "note", icon: "text", label: "הערת טקסט" },
  { id: "note:arrow", kind: "note", icon: "arrow", label: "חץ" },
  { id: "note:rect", kind: "note", icon: "frame", label: "מסגרת" },
  { id: "note:pin", kind: "note", icon: "pin", label: "סיכה" },
  { id: "aux:annVisible", kind: "aux", icon: "eye", label: "הצג/הסתר סימוני הסבר" },
  { id: "aux:annClear", kind: "aux", icon: "clear-notes", label: "מחק סימוני הסבר" },

  { id: "div:select", kind: "divider", label: "בחירה" },
  { id: "tool:wand", kind: "tool", icon: "wand", label: "מטה קסם" },
  { id: "tool:element", kind: "tool", icon: "target", label: "בחירת אלמנט" },
  { id: "aux:showMask", kind: "aux", icon: "mask-view", label: "הצג/הסתר את הסימון" },

  { id: "div:erase", kind: "divider", label: "מחיקה" },
  { id: "tool:remove", kind: "tool", icon: "heal", label: "מברשת מחיקה (הסרת אובייקט)" },
  { id: "tool:erase-layer", kind: "tool", icon: "eraser", label: "מחק שכבה" },

  { id: "div:view", kind: "divider", label: "תצוגה" },
  { id: "tool:pan", kind: "tool", icon: "hand", label: "ניווט" },
  { id: "aux:compare", kind: "aux", icon: "compare", label: "לפני / אחרי" },
  { id: "aux:bgTransparent", kind: "aux", icon: "checker", label: "רקע קנבס שקוף" },
  { id: "aux:zoom", kind: "aux", icon: "zoom", label: "זום" },
];

export const DEFAULT_TOOL_ORDER = TOOLBAR_ITEMS.map((i) => i.id);

export function itemById(id: string): ToolbarItem | undefined {
  return TOOLBAR_ITEMS.find((i) => i.id === id);
}

/** Reconcile a stored order against the items this build actually has.
 *
 *  Ids that no longer exist are dropped, and items added since the arrangement was
 *  saved are appended rather than lost — so shipping a new tool can never corrupt
 *  somebody's toolbar, and can never leave it unreachable either. */
export function reconcileOrder(stored: string[] | undefined, all: string[] = DEFAULT_TOOL_ORDER): string[] {
  const known = new Set(all);
  const seen = new Set<string>();
  const kept = (stored ?? []).filter((id) => {
    if (!known.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...kept, ...all.filter((id) => !seen.has(id))];
}

/** Move `id` so it sits where `target` was. Returns a new array. */
export function moveItem(order: string[], id: string, target: string): string[] {
  if (id === target) return order;
  const from = order.indexOf(id);
  const to = order.indexOf(target);
  if (from < 0 || to < 0) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(next.indexOf(target) + (from < to ? 1 : 0), 0, id);
  return next;
}
