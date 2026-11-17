import { useRef } from "react";
import { useStore } from "../state/store";
import { useLayout } from "../state/layout";
import { useView } from "../state/view";
import { visibleFraction, panToCenter, type Box } from "../navigatorMath";
import { Icon } from "./Icon";

/**
 * The layer you are working on, large, at the top of the layers dock. When the canvas is
 * zoomed in, a frame marks the part that is on screen; clicking or dragging on the
 * preview moves the view there. Folds away from its header like any other panel.
 */
export function Navigator() {
  const open = useLayout((s) => s.navigatorOpen);
  const toggle = useLayout((s) => s.toggleNavigator);
  const project = useStore((s) => s.project);
  const activeId = useStore((s) => s.activeLayerId);
  const zoom = useStore((s) => s.zoom);
  const panX = useStore((s) => s.panX);
  const panY = useStore((s) => s.panY);
  const setPan = useStore((s) => s.setPan);
  const viewW = useView((s) => s.w);
  const viewH = useView((s) => s.h);
  const dragging = useRef(false);

  if (!project) return null;
  // The active layer; with none chosen, the top visible one.
  const layer =
    project.layers.find((l) => l.id === activeId) ??
    [...project.layers].reverse().find((l) => l.visible) ??
    project.layers[0];
  if (!layer) return null;

  const box: Box = { x: layer.x, y: layer.y, w: layer.width, h: layer.height };
  const view = { zoom, panX, panY, viewW, viewH };
  const frame = visibleFraction(box, view);

  const moveTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const p = panToCenter(box, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, view);
    setPan(p.panX, p.panY);
  };

  return (
    <section className="navigator">
      <button className="panel-head" onClick={toggle} aria-expanded={open}>
        <span className={`panel-caret ${open ? "open" : ""}`} aria-hidden="true"><Icon name="chevron" size={12} /></span>
        <span className="panel-title">תצוגה</span>
        <span className="panel-meta" dir="ltr">{Math.round(zoom * 100)}%</span>
      </button>
      {open && (
        <div className="nav-body">
          <div className="nav-stage">
            <div
              className="nav-pic"
              style={{ aspectRatio: `${Math.max(1, box.w)} / ${Math.max(1, box.h)}` }}
              onPointerDown={(e) => {
                dragging.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                moveTo(e);
              }}
              onPointerMove={(e) => dragging.current && moveTo(e)}
              onPointerUp={() => (dragging.current = false)}
              onPointerCancel={() => (dragging.current = false)}
              title="לחץ או גרור כדי להזיז את התצוגה"
            >
              <img src={layer.src} alt="" draggable={false} />
              {frame && (
                <div
                  className="nav-frame"
                  style={{
                    left: `${frame.x * 100}%`,
                    top: `${frame.y * 100}%`,
                    width: `${frame.w * 100}%`,
                    height: `${frame.h * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
          <div className="nav-caption">
            <span className="nav-name">{layer.name}</span>
            <span className="nav-dims" dir="ltr">
              {Math.round(layer.width)} × {Math.round(layer.height)}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
