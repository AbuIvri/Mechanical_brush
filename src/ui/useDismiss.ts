import { useEffect, type RefObject } from "react";

/** Close a popup when the user clicks anywhere outside it, or presses Escape.
 *
 *  Put the ref on a wrapper that contains BOTH the popup and the control that
 *  opens it — otherwise clicking the trigger would close the popup here and
 *  immediately re-open it in the trigger's own handler, which reads as "the menu
 *  won't open".
 *
 *  Listens on pointerdown rather than click so the menu is gone before whatever
 *  was clicked reacts, and in the capture phase so a handler that stops
 *  propagation can't leave the menu stuck open. */
export function useDismiss(ref: RefObject<HTMLElement | null>, close: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, close, active]);
}
