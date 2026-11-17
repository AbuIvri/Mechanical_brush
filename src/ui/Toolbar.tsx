import { Icon } from "./Icon";
import type { IconName } from "./iconNames";
import { useRef, useState } from "react";
import { useStore, type NoteShape, type Tool } from "../state/store";
import { useLayout } from "../state/layout";
import { itemById, moveItem, type ToolbarItem } from "./toolbarItems";
import { SEGMENT_CLASSES } from "../select";

// Markup that explains an intent to the prompt assistant. Not a selection, and never
// part of the image sent to the image engine.
const NOTE_COLORS = ["#ff2d55", "#ffd60a", "#32d74b", "#0a84ff", "#ffffff"];


export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const brushSize = useStore((s) => s.brushSize);
  const setBrushSize = useStore((s) => s.setBrushSize);
  const brushHardness = useStore((s) => s.brushHardness);
  const setBrushHardness = useStore((s) => s.setBrushHardness);
  const compare = useStore((s) => s.compare);
  const toggleCompare = useStore((s) => s.toggleCompare);
  const clearMask = useStore((s) => s.clearMask);
  const showMask = useStore((s) => s.showMask);
  const toggleShowMask = useStore((s) => s.toggleShowMask);
  const rectSquare = useStore((s) => s.rectSquare);
  const bgColor = useStore((s) => s.project?.canvas.backgroundColor);
  const toggleCanvasTransparent = useStore((s) => s.toggleCanvasTransparent);
  const toggleRectSquare = useStore((s) => s.toggleRectSquare);
  const rotateCanvas = useStore((s) => s.rotateCanvas);
  const hasSelection = useStore(
    (s) => s.mask.rects.length > 0 || s.mask.strokes.length > 0 || s.mask.bitmaps.length > 0,
  );
  const hasProject = useStore((s) => !!s.project);
  const wandTolerance = useStore((s) => s.wandTolerance);
  const setWandTolerance = useStore((s) => s.setWandTolerance);
  const runSegments = useStore((s) => s.runSegments);
  const selectSegmentClass = useStore((s) => s.selectSegmentClass);
  const segments = useStore((s) => s.segments);
  const segBusy = useStore((s) => s.segBusy);
  const zoom = useStore((s) => s.zoom);
  const setZoom = useStore((s) => s.setZoom);
  const noteShape = useStore((s) => s.noteShape);
  const setNoteShape = useStore((s) => s.setNoteShape);
  const noteColor = useStore((s) => s.noteColor);
  const setNoteColor = useStore((s) => s.setNoteColor);
  const noteSize = useStore((s) => s.noteSize);
  const setNoteSize = useStore((s) => s.setNoteSize);
  const annotations = useStore((s) => s.project?.annotations ?? null);
  const clearAnnotations = useStore((s) => s.clearAnnotations);
  const toggleAnnotations = useStore((s) => s.toggleAnnotations);

  const toolOrder = useLayout((s) => s.toolOrder);
  const toolHidden = useLayout((s) => s.toolHidden);
  const setToolOrder = useLayout((s) => s.setToolOrder);
  const toggleToolHidden = useLayout((s) => s.toggleToolHidden);
  const resetToolbar = useLayout((s) => s.resetToolbar);
  const [customising, setCustomising] = useState(false);
  const dragId = useRef<string | null>(null);

  /** One tool button. */
  const toolBtn = (id: Tool, icon: IconName, label: string, disabled = false) => (
    <button
      className={`tool ${tool === id ? "active ink" : ""}`}
      aria-pressed={tool === id}
      title={label}
      aria-label={label}
      onClick={() => setTool(id)}
      disabled={disabled}
    >
      <Icon name={icon} />
    </button>
  );

  /** The controls that belong to a tool travel with it, wherever it now sits. */
  const extrasFor = (id: string) => {
    if (id === "tool:remove" && tool === "remove") {
      return (
        <div className="tool-field" title="קוטר מברשת המחיקה">
          <span className="tool-mini">⌀ {brushSize}px</span>
          <input type="range" min={2} max={400} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
        </div>
      );
    }
    if (id === "tool:brush" && tool === "brush") {
      return (
        <div className="tool-field" title="קוטר מברשת הסימון">
          <span className="tool-mini">⌀ {brushSize}px</span>
          <input type="range" min={2} max={400} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
        </div>
      );
    }
    if (id === "tool:wand" && tool === "wand") {
      return (
        <>
          <div className="tool-field" title="סובלנות צבע — גרירה מעדכנת את הבחירה האחרונה בלייב">
            <span className="tool-mini">סובלנות {wandTolerance}</span>
            <input type="range" min={1} max={100} value={wandTolerance} onChange={(e) => setWandTolerance(Number(e.target.value))} />
          </div>
          <button
            className="tool tool-aux seg-run"
            title="זיהוי סגמנטים ב-AI: רקע, שיער, גוף, פנים, בגדים (מקומי, מהיר)"
            aria-label="זיהוי סגמנטים ב-AI: רקע, שיער, גוף, פנים, בגדים (מקומי, מהיר)"
            onClick={runSegments}
            disabled={!hasProject || segBusy}
          >
            {segBusy ? "…" : <Icon name="scan" />}
          </button>
          {segments && (
            <div className="seg-chips">
              {SEGMENT_CLASSES.map((c) => (
                <button key={c.id} className="seg-chip" title={`בחר ${c.he}`} aria-label={`בחר ${c.he}`} onClick={() => selectSegmentClass(c.id)}>
                  {c.he}
                </button>
              ))}
            </div>
          )}
        </>
      );
    }
    if (id === "tool:erase-layer" && tool === "erase-layer") {
      const d = Math.round(8 + (brushSize / 400) * 40);
      return (
        <>
          <div className="tool-field" title="רוחב מחק">
            <span className="tool-mini">⌀ {brushSize}px</span>
            <input type="range" min={2} max={400} value={brushSize} onChange={(e) => setBrushSize(Number(e.target.value))} />
          </div>
          <div className="tool-field" title="קשיחות שוליים (100% = קצה חד, נמוך = נוצה רכה)">
            <span className="tool-mini">קשיות {brushHardness}%</span>
            <input type="range" min={0} max={100} value={brushHardness} onChange={(e) => setBrushHardness(Number(e.target.value))} />
          </div>
          <div className="brush-preview-wrap" title="תצוגת גודל ונוצת המברשת">
            <div
              className="brush-preview"
              style={{
                width: d,
                height: d,
                background: `radial-gradient(circle, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.95) ${brushHardness}%, rgba(255,255,255,0) 100%)`,
              }}
            />
          </div>
        </>
      );
    }
    // The note colours and thickness go under the note shape that is actually selected,
    // so hiding one shape cannot take the palette away with it.
    if (id === `note:${noteShape}` && tool === "note") {
      return (
        <>
          <div className="note-colors">
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                className={`note-color ${noteColor === c ? "on" : ""}`}
                style={{ background: c }}
                title="צבע הסימון"
                aria-label="צבע הסימון"
                onClick={() => setNoteColor(c)}
              />
            ))}
          </div>
          <div className="tool-field" title="עובי הקו / גודל הטקסט">
            <span className="tool-mini">עובי {noteSize}</span>
            <input type="range" min={1} max={40} value={noteSize} onChange={(e) => setNoteSize(Number(e.target.value))} />
          </div>
        </>
      );
    }
    return null;
  };

  /** What each item actually renders as. */
  const renderItem = (item: ToolbarItem) => {
    const { id } = item;
    if (item.kind === "divider") {
      // A rule, not a heading: a labelled row above a cluster reads like something you
      // have to click first, and it costs a line of height for no action.
      return <div className="toolbar-sep" title={item.label} />;
    }
    if (item.kind === "note") {
      const shape = id.slice("note:".length) as NoteShape;
      return (
        <button
          className={`tool ${tool === "note" && noteShape === shape ? "active ink" : ""}`}
          title={
            shape === "pin"
              ? `${item.label} — מניחים סיכה וכותבים מה לשנות בה. העוזר רואה את הסיכות, ובמצב יצירה מחדש אפשר לתייג אותן בפרומפט (📍) והן נשלחות כקואורדינטות`
              : `${item.label} — סימוני הסבר מיועדים לעוזר הפרומפטים בלבד ולעולם לא נכנסים לתמונה שנשלחת למנוע היצירה`
          }
          aria-label={
            shape === "pin"
              ? `${item.label} — מניחים סיכה וכותבים מה לשנות בה. העוזר רואה את הסיכות, ובמצב יצירה מחדש אפשר לתייג אותן בפרומפט (📍) והן נשלחות כקואורדינטות`
              : `${item.label} — סימוני הסבר מיועדים לעוזר הפרומפטים בלבד ולעולם לא נכנסים לתמונה שנשלחת למנוע היצירה`
          }
          onClick={() => setNoteShape(shape)}
          disabled={!hasProject}
        >
          <Icon name={item.icon!} />
        </button>
      );
    }
    if (item.kind === "tool") return toolBtn(id.slice("tool:".length) as Tool, item.icon!, item.label);

    switch (id) {
      case "aux:rotateCCW":
        return <button className="tool tool-aux" title={item.label} aria-label={item.label} onClick={() => rotateCanvas(false)} disabled={!hasProject}><Icon name="rotate-ccw" /></button>;
      case "aux:rotateCW":
        return <button className="tool tool-aux" title={item.label} aria-label={item.label} onClick={() => rotateCanvas(true)} disabled={!hasProject}><Icon name="rotate-cw" /></button>;
      case "aux:rectSquare":
        return (
          <button className={`tool tool-aux ${rectSquare ? "on" : ""}`} title="נעל את הסימון לריבוע 1:1" aria-label="נעל את הסימון לריבוע 1:1" onClick={toggleRectSquare}><Icon name="square" /></button>
        );
      case "aux:clearMask":
        return (
          <button className="tool tool-aux" title="נקה את האזור המסומן (Esc)" aria-label="נקה את האזור המסומן (Esc)" onClick={clearMask} disabled={!hasSelection}><Icon name="clear-rect" /></button>
        );
      case "aux:annVisible":
        return annotations?.items.length ? (
          <button
            className={`tool tool-aux ${annotations.visible ? "on" : ""}`}
            title={annotations.visible ? "הסתר את שכבת הסימונים" : "הצג את שכבת הסימונים"}
            aria-label={annotations.visible ? "הסתר את שכבת הסימונים" : "הצג את שכבת הסימונים"}
            onClick={toggleAnnotations}
          >
            <Icon name={annotations.visible ? "eye" : "eye-off"} />
          </button>
        ) : null;
      case "aux:annClear":
        return annotations?.items.length ? (
          <button className="tool tool-aux" title="מחק את כל הסימונים" aria-label="מחק את כל הסימונים" onClick={clearAnnotations}><Icon name="clear-notes" /></button>
        ) : null;
      case "aux:showMask":
        return (
          <button
            className={`tool tool-aux ${showMask ? "on" : ""}`}
            title="הצג/הסתר את הסימון — שימושי כדי לראות את התוצאה בזמן כיוונון"
            aria-label="הצג/הסתר את הסימון — שימושי כדי לראות את התוצאה בזמן כיוונון"
            onClick={toggleShowMask}
            disabled={!hasSelection}
          >
            <Icon name="mask-view" />
          </button>
        );
      case "aux:bgTransparent": {
        const clear = bgColor === "transparent";
        return (
          <button
            className={`tool tool-aux ${clear ? "on" : ""}`}
            title={
              clear
                ? "רקע הקנבס שקוף — ייצוא PNG ישמור את השקיפות. לחץ להחזרת רקע לבן."
                : "רקע הקנבס לבן. לחץ כדי להפוך אותו לשקוף — נדרש כדי לראות ולייצא שכבות שקופות."
            }
            aria-label={
              clear
                ? "רקע הקנבס שקוף — ייצוא PNG ישמור את השקיפות. לחץ להחזרת רקע לבן."
                : "רקע הקנבס לבן. לחץ כדי להפוך אותו לשקוף — נדרש כדי לראות ולייצא שכבות שקופות."
            }
            onClick={toggleCanvasTransparent}
            disabled={!hasProject}
          >
            <Icon name="checker" />
          </button>
        );
      }
      case "aux:compare":
        return <button className={`tool tool-aux ${compare ? "on" : ""}`} title="לפני / אחרי" aria-label="לפני / אחרי" onClick={toggleCompare}><Icon name="compare" /></button>;
      case "aux:zoom":
        return (
          <div className="zoom-controls">
            <button className="tool tool-aux" title="הקטן תצוגה" aria-label="הקטן תצוגה" onClick={() => setZoom(zoom / 1.2)}>−</button>
            <span className="tool-mini">{Math.round(zoom * 100)}%</span>
            <button className="tool tool-aux" title="הגדל תצוגה" aria-label="הגדל תצוגה" onClick={() => setZoom(zoom * 1.2)}>+</button>
            <button className="tool tool-aux" onClick={() => setZoom(1)} title="100%" aria-label="100%">1:1</button>
          </div>
        );
      default:
        return null;
    }
  };

  const hidden = new Set(toolHidden);
  const shown = customising ? toolOrder : toolOrder.filter((id) => !hidden.has(id));

  return (
    <div className={`toolbar ${customising ? "customising" : ""}`}>
      {shown.map((id) => {
        const item = itemById(id);
        if (!item) return null;
        const isHidden = hidden.has(id);
        const content = renderItem(item);
        if (!content) return null;
        // The controls that belong to this tool, shown right under it while it is active.
        const extras = extrasFor(id);
        return (
          <div
            key={id}
            className={`tb-slot ${isHidden ? "is-hidden" : ""}`}
            draggable={customising}
            onDragStart={() => (dragId.current = id)}
            onDragOver={(e) => {
              if (customising && dragId.current) e.preventDefault();
            }}
            onDrop={(e) => {
              if (!customising || !dragId.current) return;
              e.preventDefault();
              setToolOrder(moveItem(toolOrder, dragId.current, id));
              dragId.current = null;
            }}
          >
            {content}
            {!customising && extras}
            {customising && (
              <button
                className="tb-eye"
                title={isHidden ? `הצג: ${item.label}` : `הסתר: ${item.label}`}
                aria-label={isHidden ? `הצג: ${item.label}` : `הסתר: ${item.label}`}
                onClick={() => toggleToolHidden(id)}
              >
                <Icon name={isHidden ? "eye-off" : "eye"} size={14} />
              </button>
            )}
          </div>
        );
      })}

      <div className="toolbar-sep" />
      <button
        className={`tool tool-aux ${customising ? "on" : ""}`}
        title={customising ? "סיים סידור" : "סדר את הסרגל — גרור כלים, והסתר את מה שלא בשימוש"}
        aria-label={customising ? "סיים סידור" : "סדר את הסרגל — גרור כלים, והסתר את מה שלא בשימוש"}
        onClick={() => setCustomising((v) => !v)}
      >
        <Icon name="pencil" />
      </button>
      {customising && (
        <button className="tool tool-aux" title="החזר לסדר המקורי" aria-label="החזר לסדר המקורי" onClick={resetToolbar}>אפס</button>
      )}
    </div>
  );
}
