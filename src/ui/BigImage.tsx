import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { originalUrl } from "../../shared/originalUrl";
import {
  clampRect,
  moveRect,
  resizeRect,
  snapToEdges,
  snapMoveToEdges,
  EDGE_SNAP_SCREEN,
  PIECE_PRESETS,
  ENGINE_COMFORT_EDGE,
  type Box,
} from "../piece";
import { Icon } from "./Icon";

/** Opening a picture over 4K: shrink it, or cut a piece of it at full resolution. */
export function LargeImageDialog() {
  const ask = useStore((s) => s.largeImageAsk);
  const answer = useStore((s) => s.answerLargeImage);
  if (!ask) return null;
  return (
    <div className="modal-backdrop" onClick={() => answer("cancel")}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          תמונה גדולה{" "}
          <span className="dlg-dims" dir="ltr">
            {ask.width.toLocaleString()}×{ask.height.toLocaleString()}
          </span>
        </div>
        <p className="onboard-lead">
          <b>{ask.name}</b> גדולה מ-4K. אפשר לעבוד עליה מוקטנת, או לחתוך ממנה חתיכה ולעבוד עליה ברזולוציה
          המלאה — ובסיום להחזיר אותה לתמונה המקורית, בדיוק למקום שממנו נלקחה.
        </p>
        <div className="dlg-choices">
          <button onClick={() => answer("piece")}>
            <b>חתוך חתיכה ברזולוציה מלאה</b>
            <small>בוחרים מלבן על התמונה המקורית. החתיכה נפתחת כפרויקט, והייצוא שלה יכול להחזיר אותה למקור.</small>
          </button>
          <button onClick={() => answer("shrink")}>
            <b>הקטן ל-4K</b>
            <small>כל התמונה, מוקטנת. מהיר — אבל הפרטים הדקים לא יחזרו.</small>
          </button>
        </div>
        <div className="modal-actions">
          <button onClick={() => answer("cancel")}>ביטול</button>
        </div>
      </div>
    </div>
  );
}

/** Choosing the piece, on the original itself.
 *
 *  The photo is shown whole, fitted to the window. Every drag draws a new rectangle — most
 *  pieces are drawn from somewhere in the middle out to the border, and a drag that
 *  started inside the previous rectangle used to MOVE it instead, so a second try needed
 *  a click outside first. Moving is by the size label (✥), which is a handle. An edge that
 *  comes near the border lands on it. An exact size is typed — 8000px shown in ~1400 is
 *  ~6 original pixels per screen pixel. Everything is held in ORIGINAL pixels; the screen
 *  is only a view of them. */
export function PiecePicker() {
  const picker = useStore((s) => s.piecePicker);
  const finish = useStore((s) => s.finishPiecePick);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rect, setRect] = useState<Box | null>(null);
  const drag = useRef<{ kind: "draw" | "move"; ox: number; oy: number; start: Box | null } | null>(null);

  const ow = picker?.original.width ?? 1;
  const oh = picker?.original.height ?? 1;

  useEffect(() => {
    if (!picker) return;
    setRect(null);
    setLoaded(false);
    setFailed(false);
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [picker]);

  useEffect(() => {
    if (!picker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker, finish]);

  // Where the photo sits on screen: fitted whole, centred.
  const view = useMemo(() => {
    const k = Math.min(stage.w / ow, stage.h / oh) || 1;
    return { k, x: (stage.w - ow * k) / 2, y: (stage.h - oh * k) / 2 };
  }, [stage, ow, oh]);

  if (!picker) return null;
  const token = picker.original.token!;

  /** The pointer in original pixels. Clamped to the photo for drawing — a corner dragged
   *  past the border stops at it. Not for moving: the handle sits above the frame, so the
   *  pointer reaches the border first, and clamping it there stopped the frame short of it.
   *  A move is clamped on the rectangle instead (moveRect). */
  const toOriginal = (e: React.PointerEvent, clamp = true) => {
    const b = stageRef.current!.getBoundingClientRect();
    const x = (e.clientX - b.left - view.x) / view.k;
    const y = (e.clientY - b.top - view.y) / view.k;
    return clamp ? { x: Math.max(0, Math.min(ow, x)), y: Math.max(0, Math.min(oh, y)) } : { x, y };
  };
  // The snap distance in original pixels: the same feel on screen at any photo size.
  const tol = EDGE_SNAP_SCREEN / view.k;

  const begin = (e: React.PointerEvent, kind: "draw" | "move") => {
    if (!loaded) return;
    stageRef.current!.setPointerCapture(e.pointerId);
    const p = toOriginal(e, kind === "draw");
    drag.current = { kind, ox: p.x, oy: p.y, start: rect };
  };
  const onDown = (e: React.PointerEvent) => begin(e, "draw");
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toOriginal(e, d.kind === "draw");
    if (d.kind === "move" && d.start) setRect(snapMoveToEdges(moveRect(d.start, p.x - d.ox, p.y - d.oy, ow, oh), ow, oh, tol));
    else setRect(snapToEdges(clampRect({ x: d.ox, y: d.oy, w: p.x - d.ox, h: p.y - d.oy }, ow, oh), ow, oh, tol));
  };
  const onUp = () => {
    drag.current = null;
  };

  const long = rect ? Math.max(rect.w, rect.h) : 0;
  const preset = rect && PIECE_PRESETS.includes(long) ? long : null;
  const setLong = (edge: number) => {
    const base = rect ?? { x: ow / 2 - 512, y: oh / 2 - 512, w: 1024, h: 1024 };
    const a = base.w / base.h;
    setRect(resizeRect(base, a >= 1 ? edge : edge * a, a >= 1 ? edge / a : edge, ow, oh));
  };
  const screen = rect && { left: view.x + rect.x * view.k, top: view.y + rect.y * view.k, width: rect.w * view.k, height: rect.h * view.k };

  return (
    <div className="piece-picker">
      <div className="piece-picker-head">
        <b>בחירת חתיכה · <bdi>{picker.name}</bdi></b>
        <span className="piece-picker-sub">
          <span className="dlg-dims" dir="ltr">{ow.toLocaleString()} × {oh.toLocaleString()}</span> · גרור כדי לסמן — קצה שמגיע לשולי התמונה נצמד אליהם · גרירת התווית מזיזה · או הקלד גודל מדויק
        </span>
      </div>

      <div
        className="piece-picker-stage"
        ref={stageRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        style={{ cursor: loaded ? "crosshair" : "wait" }}
      >
        <img
          src={originalUrl(token)}
          crossOrigin="anonymous"
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          style={{ left: view.x, top: view.y, width: ow * view.k, height: oh * view.k }}
        />
        {!loaded && !failed && <div className="piece-picker-msg">טוען את התמונה המקורית…</div>}
        {failed && <div className="piece-picker-msg">לא ניתן לטעון את התמונה המקורית.</div>}
        {screen && (
          <div className={`piece-picker-rect ${preset ? "on-preset" : ""}`} style={screen}>
            {/* The handle: drag here to move the rectangle. Inside the frame when the frame
                is on the photo's top border, where above it there is nowhere to grab. */}
            <span
              className={`piece-picker-size ${screen.top < 28 ? "inside" : ""}`}
              title="גרור כדי להזיז את המלבן"
              onPointerDown={(e) => {
                e.stopPropagation();
                begin(e, "move");
              }}
            >
              <Icon name="move" size={12} /> {rect!.w.toLocaleString()} × {rect!.h.toLocaleString()}
              {preset ? ` · ${preset / 1024}K` : ""}
            </span>
          </div>
        )}
      </div>

      <div className="piece-picker-foot">
        <label>
          רוחב
          <input
            type="number"
            min={16}
            max={ow}
            value={rect?.w ?? ""}
            placeholder="—"
            onChange={(e) => rect && setRect(resizeRect(rect, Number(e.target.value), rect.h, ow, oh))}
          />
        </label>
        <label>
          גובה
          <input
            type="number"
            min={16}
            max={oh}
            value={rect?.h ?? ""}
            placeholder="—"
            onChange={(e) => rect && setRect(resizeRect(rect, rect.w, Number(e.target.value), ow, oh))}
          />
        </label>
        <span className="piece-picker-presets" title="הצלע הארוכה בגודל מדויק — שומר על היחס">
          {PIECE_PRESETS.map((p) => (
            <button key={p} className={preset === p ? "on" : ""} onClick={() => setLong(p)}>
              {p >= 1024 && p % 1024 === 0 ? `${p / 1024}K` : `${(p / 1024).toFixed(1)}K`}
            </button>
          ))}
        </span>
        {long > ENGINE_COMFORT_EDGE && <span className="piece-picker-warn">גדול מ-4K — רוב המנועים יקטינו לפני העבודה</span>}
        <span style={{ flex: 1 }} />
        <button onClick={() => finish(null)}>ביטול</button>
        <button className="primary" disabled={!rect} onClick={() => rect && finish(rect)}>
          חתוך ופתח
        </button>
      </div>
    </div>
  );
}

/** "Back into the original": the piece laid into a copy of the photo it was cut from. */
export function WriteBackDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const busy = useStore((s) => s.busy);
  const exportToOriginal = useStore((s) => s.exportToOriginal);
  const relink = useStore((s) => s.relinkPieceOriginal);
  const src = project?.pieceSource;
  const W = project?.canvas.width ?? 0;
  const H = project?.canvas.height ?? 0;
  // A thin seam by default: wide enough to hide a slight shift in tone at the edge, narrow
  // enough that the piece stays the piece.
  const [band, setBand] = useState(() => Math.round(Math.min(48, Math.min(W, H) * 0.03)));
  const [matchColor, setMatchColor] = useState(false);
  if (!src) return null;
  const name = src.original.path.split(/[\\/]/).pop();
  const maxBand = Math.max(0, Math.floor(Math.min(W, H) / 4));
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">החזרה לתמונה המקורית</div>
        <p className="onboard-lead">
          החתיכה ({W.toLocaleString()}×{H.toLocaleString()}) תונח בתוך עותק של <b><bdi>{name}</bdi></b> (
          {src.original.width.toLocaleString()}×{src.original.height.toLocaleString()}), בדיוק במקום שממנו נלקחה — x{" "}
          {src.rect.x.toLocaleString()}, y {src.rect.y.toLocaleString()}. הקובץ המקורי לא נדרס: השמירה מציעה שם חדש באותה תיקייה.
        </p>
        {src.original.missing ? (
          <div className="settings-section">
            <p className="onboard-lead warn">
              הקובץ המקורי לא נמצא במקום ששמור בפרויקט ({src.original.path}).
            </p>
            <div className="modal-actions">
              <button className="primary" onClick={() => void relink()}>אתר את הקובץ…</button>
              <button onClick={onClose}>סגור</button>
            </div>
          </div>
        ) : (
          <div className="settings-section">
            <label className="writeback-field">
              <span>מעבר רך בשוליים</span>
              <input type="range" min={0} max={maxBand} value={band} onChange={(e) => setBand(Number(e.target.value))} />
              <b>{band ? `${band}px` : "ללא"}</b>
            </label>
            <p className="writeback-note">
              {band
                ? `החתיכה נמזגת בתמונה לאורך ${band} הפיקסלים שבקצה שלה. כל מה שפנימה מזה — בדיוק כפי שערכת.`
                : "הדבקה חדה: אם הטון בקצה השתנה בעריכה, הגבול עלול להיראות."}
            </p>
            <label className="chk">
              <input type="checkbox" checked={matchColor} onChange={(e) => setMatchColor(e.target.checked)} /> התאם צבע לתמונה
              המקורית
            </label>
            <p className="writeback-note">
              מודד את הסטייה בטון רק בשוליים מול התמונה המקורית ומתקן אותה. השאר כבוי אם שינית צבעים בכוונה.
            </p>
            <div className="modal-actions">
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  onClose();
                  void exportToOriginal({ band, matchColor });
                }}
              >
                שמור…
              </button>
              <button onClick={onClose}>ביטול</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
