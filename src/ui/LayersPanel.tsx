import { Icon } from "./Icon";
import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { LayerParamsDialog } from "./LayerParamsDialog";
import { FillColorInline } from "./FillColorDialog";
import { getMosaicLayers } from "../mosaic";
import { useDismiss } from "./useDismiss";
import type { BlendMode } from "../../shared/types";

// Cache decoded pixel dimensions per image src so we don't re-decode on every render.
// The alpha check rides along with that same decode — it is the only reason the image
// is in memory, and a layer with transparency needs to say so.
const dimsCache = new Map<string, { w: number; h: number; alpha: boolean }>();

/** Sampled alpha check on an already-decoded image. Cheap enough to run beside the
 *  dimension read; see hasTransparency() in compositing for the same trade-off. */
function sampleAlpha(img: HTMLImageElement): boolean {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return false;
  try {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 4096)));
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      if (ctx.getImageData(x, y, 1, 1).data[3] < 255) return true;
    }
    for (let y = 0; y < h; y += step) {
      const row = ctx.getImageData(0, y, w, 1).data;
      for (let x = 0; x < w; x += step) if (row[x * 4 + 3] < 255) return true;
    }
    return false;
  } catch {
    return false; // a tainted canvas is not worth an error here
  }
}

/** Reads the TRUE pixel dimensions of a layer's image data (not its canvas placement size). */
function LayerDims({ src, onDownscale }: { src: string; onDownscale?: () => void }) {
  const [dims, setDims] = useState<{ w: number; h: number; alpha: boolean } | null>(
    () => dimsCache.get(src) ?? null,
  );
  useEffect(() => {
    const cached = dimsCache.get(src);
    if (cached) { setDims(cached); return; }
    let alive = true;
    const img = new Image();
    img.onload = () => {
      const d = { w: img.naturalWidth, h: img.naturalHeight, alpha: sampleAlpha(img) };
      dimsCache.set(src, d);
      if (alive) setDims(d);
    };
    img.src = src;
    return () => { alive = false; };
  }, [src]);
  if (!dims) return null;
  const oversized = Math.max(dims.w, dims.h) > 4096;
  return (
    <span className="layer-dims" title="מימדי התמונה בפיקסלים">
      {dims.alpha && (
        <span
          className="alpha-chip"
          title="השכבה כוללת רקע שקוף. אם הקנבס אטום הוא מסתיר את זה — החלף את רקע הקנבס לשקוף כדי לראות ולייצא את השקיפות."
        >
          שקוף
        </span>
      )}
      {oversized && onDownscale && (
        <button
          className="dims-shrink"
          title="הקטן ל-4K — התמונה גדולה מ-4096px ועלולה להאט/להידחות במנועים"
          aria-label="הקטן ל-4K — התמונה גדולה מ-4096px ועלולה להאט/להידחות במנועים"
          onClick={(e) => { e.stopPropagation(); onDownscale(); }}
        >
          הקטן ל-4K
        </button>
      )}
      {dims.w.toLocaleString()} × {dims.h.toLocaleString()} px
    </span>
  );
}

const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: "normal", label: "רגיל" },
  { id: "multiply", label: "הכפלה" },
  { id: "screen", label: "מסך" },
  { id: "overlay", label: "כיסוי" },
  { id: "soft-light", label: "אור רך" },
  { id: "difference", label: "הפרש" },
  { id: "color", label: "צבע" },
  { id: "luminosity", label: "בהירות" },
];

export function LayersPanel() {
  const project = useStore((s) => s.project);
  const activeId = useStore((s) => s.activeLayerId);
  const thumbnails = useStore((s) => s.thumbnails);
  const setLayerAlign = useStore((s) => s.setLayerAlign);
  const downscaleLayer = useStore((s) => s.downscaleLayer);
  const fitLayerToCanvas = useStore((s) => s.fitLayerToCanvas);
  const flattenAll = useStore((s) => s.flattenAll);
  const [flattenOpen, setFlattenOpen] = useState(false);
  // Close the flatten menu on a click anywhere outside it (the wrapper holds the
  // trigger too, so the button keeps toggling).
  const flattenRef = useRef<HTMLDivElement>(null);
  useDismiss(flattenRef, () => setFlattenOpen(false), flattenOpen);
  const setActive = useStore((s) => s.setActiveLayer);
  const toggleVisible = useStore((s) => s.toggleVisible);
  const toggleLock = useStore((s) => s.toggleLock);
  const setOpacity = useStore((s) => s.setOpacity);
  const setBlend = useStore((s) => s.setBlend);
  const renameLayer = useStore((s) => s.renameLayer);
  const duplicateLayer = useStore((s) => s.duplicateLayer);
  const deleteLayer = useStore((s) => s.deleteLayer);
  const moveLayer = useStore((s) => s.moveLayer);
  const mergeDown = useStore((s) => s.mergeDown);
  const exportLayer = useStore((s) => s.exportLayer);
  const addImageLayer = useStore((s) => s.addImageLayer);
  const selectedLayerIds = useStore((s) => s.selectedLayerIds);
  const toggleLayerSelected = useStore((s) => s.toggleLayerSelected);
  const hoveredLayerId = useStore((s) => s.hoveredLayerId);
  const mosaic = useStore((s) => s.mosaic);
  const clearAnnotations = useStore((s) => s.clearAnnotations);
  const toggleAnnotations = useStore((s) => s.toggleAnnotations);
  const toggleMosaic = useStore((s) => s.toggleMosaic);
  const restackLayers = useStore((s) => s.restackLayers);
  const [paramsId, setParamsId] = useState<string | null>(null);
  const [colorId, setColorId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPickLayer = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => addImageLayer(String(reader.result), f.name, { path: window.mbrush.pathForFile(f) || undefined });
    reader.readAsDataURL(f);
  };

  if (!project) return <div className="layers-panel"><div className="layers-empty">אין פרויקט פתוח</div></div>;

  // Display top layer first.
  const ordered = [...project.layers].reverse();
  const canMosaic = getMosaicLayers(project.layers, selectedLayerIds).length >= 2;

  return (
    <div className="layers-panel">
      <div className="layers-head-row">
        <button className="layer-add" onClick={() => fileRef.current?.click()} title="הוסף שכבה מתמונה" aria-label="הוסף שכבה מתמונה">
          הוסף שכבה
        </button>
        {(project?.layers.length ?? 0) > 1 && (
          <div className="flatten-wrap" ref={flattenRef}>
            <button className="layer-add flatten-btn" onClick={() => setFlattenOpen((v) => !v)} title="השטחת כל השכבות" aria-label="השטחת כל השכבות">
              השטח
            </button>
            {flattenOpen && (
              <div className="flatten-menu" onClick={() => setFlattenOpen(false)}>
                <button onClick={() => flattenAll("new")}>שטח לשכבה חדשה <small>(שומר מקור)</small></button>
                <button onClick={() => flattenAll("replace")}>שטח והחלף הכל <small>(שכבה אחת)</small></button>
              </div>
            )}
          </div>
        )}
      </div>
      {(project?.layers.length ?? 0) > 1 && (
        <div className="layers-head-row layers-layout-row">
          <button
            className={`layer-add ${mosaic ? "mosaic-on" : ""}`}
            onClick={toggleMosaic}
            disabled={!mosaic && !canMosaic}
            title={canMosaic || mosaic ? "פריסת השכבות המסומנות זו לצד זו להשוואה (תצוגה זמנית)" : "סמן ≥2 שכבות בעלות צורה זהה"}
            aria-label={canMosaic || mosaic ? "פריסת השכבות המסומנות זו לצד זו להשוואה (תצוגה זמנית)" : "סמן ≥2 שכבות בעלות צורה זהה"}
          >
            מוזאיק
          </button>
          <button className="layer-add" onClick={restackLayers} title="סדר את כל השכבות במרכז הקנבס, זו על זו" aria-label="סדר את כל השכבות במרכז הקנבס, זו על זו">
            ריערום
          </button>
        </div>
      )}
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => onPickLayer(e.target.files)} />
      {/* The markup layer. Pinned above the real layers and styled apart, because it
          is not part of the image: it explains the image to the assistant. */}
      {!!project.annotations?.items.length && (
        <div className={`layer-row note-row ${project.annotations.visible ? "" : "off"}`}>
          <span className="note-row-name" title="סימונים שנועדו להסביר לעוזר הפרומפטים — לא נכנסים לתמונה שנשלחת למנוע היצירה">
            סימוני הסבר ({project.annotations.items.length})
          </span>
          <button
            className="icon-btn"
            title={project.annotations.visible ? "הסתר" : "הצג"}
            aria-label={project.annotations.visible ? "הסתר" : "הצג"}
            onClick={toggleAnnotations}
          >
            <Icon name={project.annotations.visible ? "eye" : "eye-off"} size={15} />
          </button>
          <button className="icon-btn" title="מחק את כל הסימונים" aria-label="מחק את כל הסימונים" onClick={clearAnnotations}><Icon name="trash" size={15} /></button>
        </div>
      )}
      <div className="layers-list">
        {ordered.map((l) => (
          <div
            key={l.id}
            className={`layer-row ${activeId === l.id ? "active ink ink--dry" : ""} ${
              selectedLayerIds.includes(l.id) ? "selected" : ""
            } ${hoveredLayerId === l.id ? "hovered" : ""}`}
            onClick={() => setActive(l.id)}
          >
            <div className="layer-head">
              <input
                type="checkbox"
                className="lr-check"
                checked={selectedLayerIds.includes(l.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleLayerSelected(l.id)}
                title="סמן לפריסת מוזאיק"
              />
              <button className="icon-btn" title="נראות" aria-label="נראות" onClick={(e) => { e.stopPropagation(); toggleVisible(l.id); }}>
                <Icon name={l.visible ? "eye" : "eye-off"} size={15} />
              </button>
              <div className="layer-thumb">
                {thumbnails[l.id] ? <img src={thumbnails[l.id]} alt="" /> : <div className="thumb-fallback" />}
              </div>
              <input
                className="layer-name"
                value={l.name}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => renameLayer(l.id, e.target.value)}
              />
              {l.type === "generated" && <span className="badge" title="נוצר ע״י AI">AI</span>}
              <button className="icon-btn" title="נעילה" aria-label="נעילה" onClick={(e) => { e.stopPropagation(); toggleLock(l.id); }}>
                <Icon name={l.locked ? "lock" : "unlock"} size={15} />
              </button>
            </div>

            <div className="layer-dims-row">
              <LayerDims src={l.src} onDownscale={() => downscaleLayer(l.id)} />
            </div>

            <div className="layer-controls" onClick={(e) => e.stopPropagation()}>
              <select value={l.blendMode} onChange={(e) => setBlend(l.id, e.target.value as BlendMode)}>
                {BLEND_MODES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
              <div className="opacity">
                <input
                  type="range" min={0} max={100} value={Math.round(l.opacity * 100)}
                  onChange={(e) => setOpacity(l.id, Number(e.target.value) / 100)}
                />
                <span>{Math.round(l.opacity * 100)}%</span>
              </div>
            </div>

            <div className="layer-actions" onClick={(e) => e.stopPropagation()}>
              <button title="העלה" aria-label="העלה" onClick={() => moveLayer(l.id, 1)}><Icon name="up" size={15} /></button>
              <button title="הורד" aria-label="הורד" onClick={() => moveLayer(l.id, -1)}><Icon name="down" size={15} /></button>
              {project && (l.x !== 0 || l.y !== 0 || l.width !== project.canvas.width || l.height !== project.canvas.height) && (
                <>
                  <button title="מילוי הקנבס (כיסוי — בלי רווחים)" aria-label="מילוי הקנבס (כיסוי — בלי רווחים)" onClick={() => fitLayerToCanvas(l.id, "fill")}><Icon name="expand" size={15} /></button>
                  <button title="התאמה לקנבס (הצגת כל השכבה)" aria-label="התאמה לקנבס (הצגת כל השכבה)" onClick={() => fitLayerToCanvas(l.id, "fit")}><Icon name="contain" size={15} /></button>
                </>
              )}
              {l.metadata?.providerId && (
                <button title="פרמטרי הג'נרוט (פרומפט, מודל, הגדרות)" aria-label="פרמטרי הג'נרוט (פרומפט, מודל, הגדרות)" onClick={() => setParamsId(l.id)}><Icon name="sliders" size={15} /></button>
              )}
              {(l.metadata?.fillRef || l.metadata?.expandRaw) && (
                <button
                  className={colorId === l.id ? "fc-toggle-on" : ""}
                  title={l.metadata?.expandRaw ? "כוונון נוצת ההרחבה (לא הרסני)" : "התאמת צבע ונוצה למילוי (לא הרסני)"}
                  aria-label={l.metadata?.expandRaw ? "כוונון נוצת ההרחבה (לא הרסני)" : "התאמת צבע ונוצה למילוי (לא הרסני)"}
                  onClick={() => setColorId(colorId === l.id ? null : l.id)}
                >
                  <Icon name="droplet" size={15} />
                </button>
              )}
              <button title="שכפל" aria-label="שכפל" onClick={() => duplicateLayer(l.id)}><Icon name="duplicate" size={15} /></button>
              <button title="מזג למטה" aria-label="מזג למטה" onClick={() => mergeDown(l.id)}><Icon name="merge-down" size={15} /></button>
              <button title="ייצא שכבה" aria-label="ייצא שכבה" onClick={() => exportLayer(l.id)}><Icon name="export" size={15} /></button>
              <button title="מחק" aria-label="מחק" className="danger" onClick={() => deleteLayer(l.id)}><Icon name="trash" size={15} /></button>
            </div>

            {/* Smart-alignment status — non-destructive, reversible */}
            {l.metadata?.alignMatrix && (
              <div className="align-chip" onClick={(e) => e.stopPropagation()}>
                <span title="הפאץ' יושר אוטומטית לפי הסביבה (לא הרסני)">
                  יושר {l.metadata.alignScore != null ? `(${Math.round(l.metadata.alignScore * 100)}%)` : ""}
                </span>
                <button title="בטל את היישור — החזר למיקום המקורי" aria-label="בטל את היישור — החזר למיקום המקורי" onClick={() => setLayerAlign(l.id, undefined)}>
                  בטל יישור
                </button>
              </div>
            )}

            {/* Inline fill color/feather tuning — expands inside the row */}
            {colorId === l.id && <FillColorInline layerId={l.id} onClose={() => setColorId(null)} />}
          </div>
        ))}
      </div>
      {paramsId && <LayerParamsDialog layerId={paramsId} onClose={() => setParamsId(null)} />}
    </div>
  );
}
