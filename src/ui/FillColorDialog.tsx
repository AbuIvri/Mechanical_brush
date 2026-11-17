import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { DEFAULT_FILL_COLOR, type FillColorOptions } from "../compositing";

/**
 * Inline color/feather tuning for a fill layer — expands inside the layer row
 * in the layers panel (the canvas stays fully visible). Every slider change
 * applies LIVE (debounced), recomputed from the raw result, so tuning is
 * non-destructive; the whole session records a single undo snapshot.
 */
export function FillColorInline({ layerId, onClose }: { layerId: string; onClose: () => void }) {
  const layer = useStore((s) => s.project?.layers.find((l) => l.id === layerId));
  const adjustFillLayer = useStore((s) => s.adjustFillLayer);
  const m = layer?.metadata;

  // Directional-expand patches only have a seam feather to tune (no color recompute).
  if (m?.expandRaw) return <ExpandFeatherInline layerId={layerId} onClose={onClose} />;

  const [corr, setCorr] = useState<FillColorOptions>(m?.fillColor ?? { ...DEFAULT_FILL_COLOR });
  const [feather, setFeather] = useState<number>(
    m?.fillFeather ?? (m?.fillBox ? Math.max(2, Math.round(Math.min(m.fillBox.w, m.fillBox.h) * 0.02)) : 4),
  );

  // Live apply: debounce; serialize runs (latest wins); one undo snapshot total.
  const first = useRef(true);
  const inflight = useRef(false);
  const pending = useRef<{ corr: FillColorOptions; feather: number } | null>(null);
  const pushedHistory = useRef(false);
  const run = async (c: FillColorOptions, f: number) => {
    if (inflight.current) {
      pending.current = { corr: c, feather: f };
      return;
    }
    inflight.current = true;
    await adjustFillLayer(layerId, c, f, { quiet: true, recordHistory: !pushedHistory.current });
    pushedHistory.current = true;
    inflight.current = false;
    if (pending.current) {
      const p = pending.current;
      pending.current = null;
      run(p.corr, p.feather);
    }
  };
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => run(corr, feather), 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corr, feather]);

  if (!layer || !m?.fillSrc) return null;
  const maxFeather = m.fillBox ? Math.round(Math.min(m.fillBox.w, m.fillBox.h) * 0.15) : 40;
  const upd = (p: Partial<FillColorOptions>) => setCorr((c) => ({ ...c, ...p }));
  const reset = () => {
    setCorr({ ...DEFAULT_FILL_COLOR });
    setFeather(m.fillBox ? Math.max(2, Math.round(Math.min(m.fillBox.w, m.fillBox.h) * 0.02)) : 4);
  };

  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (n: number) => void,
    fmt?: (n: number) => string,
    track?: "bri" | "temp" | "sat",
  ) => (
    <div className="fc-row">
      <span className="fc-label">{label}</span>
      <input
        type="range"
        className={track ? `track track--${track}` : undefined}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="fc-val">{fmt ? fmt(value) : value}</span>
    </div>
  );

  return (
    <div className="fc-inline" onClick={(e) => e.stopPropagation()}>
      <div className="fc-inline-head">
        <span>התאמת צבע — חי</span>
        <button className="fc-x" onClick={onClose} title="סגור">✕</button>
      </div>

      <div className="fc-row">
        <span className="fc-label">תיקון</span>
        <select
          value={corr.mode}
          onChange={(e) => upd({ mode: e.target.value as FillColorOptions["mode"] })}
          style={{ flex: 1 }}
        >
          <option value="off">כבוי — ידני</option>
          <option value="local">אוטו׳ מקומי</option>
          <option value="global">אוטו׳ גלובלי</option>
        </select>
      </div>
      {corr.mode !== "off" &&
        slider("עוצמה", Math.round(corr.strength * 100), 0, 100, (n) => upd({ strength: n / 100 }), (n) => n + "%")}
      {slider("בהירות", corr.brightness, -50, 50, (n) => upd({ brightness: n }), undefined, "bri")}
      {slider("טמפ׳", corr.temperature, -50, 50, (n) => upd({ temperature: n }), (n) => (n > 0 ? "+" + n : String(n)), "temp")}
      {slider("רוויה", corr.saturation, -50, 50, (n) => upd({ saturation: n }), undefined, "sat")}
      {slider("נוצה", feather, 0, Math.max(10, maxFeather), setFeather, (n) => n + "px")}

      <div className="fc-actions">
        <button onClick={reset}>איפוס</button>
        <button className="primary" onClick={onClose}>סיום</button>
      </div>
    </div>
  );
}

/**
 * Feather-only tuning for a directional-expand patch — live re-feathers the seam
 * (the edge touching the original) from the stored unfeathered crop, so it stays
 * non-destructive. One undo snapshot for the whole tuning session.
 */
function ExpandFeatherInline({ layerId, onClose }: { layerId: string; onClose: () => void }) {
  const layer = useStore((s) => s.project?.layers.find((l) => l.id === layerId));
  const adjustExpandLayer = useStore((s) => s.adjustExpandLayer);
  const m = layer?.metadata;
  const margin = m?.expandMargin ?? 200;
  const [feather, setFeather] = useState<number>(m?.expandFeather ?? Math.max(2, Math.round(margin * 0.04)));

  const first = useRef(true);
  const inflight = useRef(false);
  const pending = useRef<number | null>(null);
  const pushedHistory = useRef(false);
  const run = async (f: number) => {
    if (inflight.current) {
      pending.current = f;
      return;
    }
    inflight.current = true;
    await adjustExpandLayer(layerId, f, { quiet: true, recordHistory: !pushedHistory.current });
    pushedHistory.current = true;
    inflight.current = false;
    if (pending.current != null) {
      const p = pending.current;
      pending.current = null;
      run(p);
    }
  };
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => run(feather), 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feather]);

  if (!layer || !m?.expandRaw) return null;
  const maxFeather = Math.max(20, Math.round(margin * 0.9));

  return (
    <div className="fc-inline" onClick={(e) => e.stopPropagation()}>
      <div className="fc-inline-head">
        <span>כוונון נוצת ההרחבה — חי</span>
        <button className="fc-x" onClick={onClose} title="סגור">✕</button>
      </div>
      <div className="fc-row">
        <span className="fc-label">נוצה</span>
        <input
          type="range"
          min={0}
          max={maxFeather}
          value={feather}
          onChange={(e) => setFeather(Number(e.target.value))}
        />
        <span className="fc-val">{feather}px</span>
      </div>
      <div className="fc-actions">
        <button onClick={() => setFeather(Math.max(2, Math.round(margin * 0.04)))}>איפוס</button>
        <button className="primary" onClick={onClose}>סיום</button>
      </div>
    </div>
  );
}
