import { Icon } from "./Icon";
import { Navigator } from "./Navigator";
import { useRef } from "react";
import { useLayout } from "../state/layout";
import { useStore } from "../state/store";
import { LayersPanel } from "./LayersPanel";
import { PromptBar } from "./PromptBar";
import { Notices } from "./Notices";

export function Splitter({ axis, onResize }: { axis: "x" | "y"; onResize: (delta: number) => void }) {
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    let last = axis === "x" ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const cur = axis === "x" ? ev.clientX : ev.clientY;
      onResize(cur - last);
      last = cur;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };
  return <div className={`splitter ${axis}`} onPointerDown={onDown} />;
}

export function LayersDock() {
  const layersWidth = useLayout((s) => s.layersWidth);
  const collapsed = useLayout((s) => s.layersCollapsed);
  const autoHide = useLayout((s) => s.layersAutoHide);
  const setLayersWidth = useLayout((s) => s.setLayersWidth);
  const toggleCollapsed = useLayout((s) => s.toggleLayersCollapsed);
  const toggleAutoHide = useLayout((s) => s.toggleLayersAutoHide);
  const project = useStore((s) => s.project);
  const addImageLayer = useStore((s) => s.addImageLayer);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickLayer = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => addImageLayer(String(reader.result), f.name, { path: window.mbrush.pathForFile(f) || undefined });
    reader.readAsDataURL(f);
  };

  const bar = (
    <div className="dock-bar">
      <span className="dock-title">שכבות</span>
      <div className="dock-actions">
        <button
          title={project ? "הוסף שכבה מתמונה" : "פתח פרוייקט כדי להוסיף שכבה"}
          aria-label="הוסף שכבה מתמונה"
          disabled={!project}
          onClick={() => fileRef.current?.click()}
        ><Icon name="plus" size={15} /></button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onPickLayer(e.target.files)} />
        <button className={autoHide ? "on" : ""} title={autoHide ? "ביטול שליפה אוטומטית (נעיצה)" : "שליפה בריחוף"} aria-label={autoHide ? "ביטול שליפה אוטומטית (נעיצה)" : "שליפה בריחוף"} aria-pressed={autoHide} onClick={toggleAutoHide}><Icon name="dock-pin" size={15} /></button>
        {!autoHide && <button title="כווץ פאנל" aria-label="כווץ פאנל" onClick={toggleCollapsed}><Icon name="chevron" size={15} /></button>}
      </div>
    </div>
  );

  if (autoHide) {
    return (
      <aside className="layers-dock autohide" style={{ width: layersWidth }}>
        <div className="autohide-rail">שכבות</div>
        <div className="autohide-body">
          {bar}
          <Navigator />
          <div className="layers-dock-inner-scroll"><LayersPanel /></div>
        </div>
      </aside>
    );
  }

  if (collapsed) {
    return (
      <button className="dock-rail" onClick={toggleCollapsed} title="הצג שכבות">
        שכבות
      </button>
    );
  }

  return (
    <aside className="layers-dock" style={{ width: layersWidth }}>
      <Splitter axis="x" onResize={(d) => setLayersWidth(useLayout.getState().layersWidth + d)} />
      <div className="layers-dock-inner">
        {bar}
        <Navigator />
        <div className="layers-dock-inner-scroll"><LayersPanel /></div>
      </div>
    </aside>
  );
}

export function PromptDock() {
  const height = useLayout((s) => s.promptHeight);
  const collapsed = useLayout((s) => s.promptCollapsed);
  const setHeight = useLayout((s) => s.setPromptHeight);
  const toggleCollapsed = useLayout((s) => s.togglePromptCollapsed);

  if (collapsed) {
    return (
      <div className="prompt-dock collapsed">
        <button className="dock-rail-h" onClick={toggleCollapsed} title="הצג פקדי יצירה">
          ⌃ פקדי יצירה
        </button>
        {/* Messages still have somewhere to be with the dock folded away. */}
        <Notices />
      </div>
    );
  }

  return (
    <div className="prompt-dock" style={{ height }}>
      <Splitter axis="y" onResize={(d) => setHeight(useLayout.getState().promptHeight - d)} />
      <div className="prompt-dock-bar">
        <span className="dock-title">פקדי יצירה</span>
        <button className="dock-mini caret-down" title="כווץ" aria-label="כווץ" onClick={toggleCollapsed}><Icon name="chevron" size={12} /></button>
      </div>
      <div className="prompt-dock-body">
        <PromptBar />
      </div>
    </div>
  );
}
