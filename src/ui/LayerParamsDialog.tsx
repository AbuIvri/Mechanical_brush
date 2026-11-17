import { useState } from "react";
import { useStore, modeLabel } from "../state/store";
import type { GenerationMode } from "../../shared/types";

const QUALITY: Record<string, string> = {
  low: "נמוכה", medium: "בינונית", high: "גבוהה",
  // GPT Image 2.5 only. A layer generated on one of them records the tier it used,
  // and this dialog is where that is read back.
  xhigh: "גבוהה מאוד", max: "מקסימלית", auto: "אוטו׳",
};

const isData = (k: string, v: string) => k === "מודל" || k === "מזהה בקשה" || /^[$\d][\d$.,:×\s-]*(px)?$/.test(v);

export function LayerParamsDialog({ layerId, onClose }: { layerId: string; onClose: () => void }) {
  const layer = useStore((s) => s.project?.layers.find((l) => l.id === layerId));
  const jobs = useStore((s) => s.project?.jobs ?? []);
  const providers = useStore((s) => s.providers);
  const applyLayerParams = useStore((s) => s.applyLayerParams);
  const saveActionFromLayer = useStore((s) => s.saveActionFromLayer);
  const [saveName, setSaveName] = useState<string | null>(null);

  const m = layer?.metadata;
  if (!layer || !m) return null;

  const job = jobs.find((j) => j.id === m.generationJobId);
  const providerName = providers.find((p) => p.id === m.providerId)?.name ?? m.providerId ?? "—";
  const s = m.settings ?? {};

  const rows: [string, string][] = [
    ["פעולה", m.mode ? modeLabel(m.mode as GenerationMode) : "—"],
    ["מנוע", providerName],
    ["מודל", m.modelId ?? "—"],
    ["איכות", s.quality ? QUALITY[s.quality] ?? s.quality : "—"],
  ];
  if (m.mode === "fill") {
    // What was actually generated, and whether it followed the area or a picked size.
    // Layers from before "match the area" existed have no 0 to tell them apart: unset
    // there meant 1K.
    const sent = s.outputWidth && s.outputHeight ? `${s.outputWidth}×${s.outputHeight}px` : null;
    const how = s.fillLongEdge ? `${s.fillLongEdge}px` : s.fillLongEdge === 0 ? "מותאם לאזור" : "1024px";
    rows.push(["רזולוציית אזור", sent ? `${sent} · ${how}` : how]);
  }
  else rows.push(["יחס צלעות", s.aspectRatio && s.aspectRatio !== "auto" ? s.aspectRatio : "כמו המקור"]);
  rows.push([
    "שמירה",
    [s.preserveColor && "צבעים", s.preserveGeometry && "גאומטריה", s.preserveIdentity && "זהות"]
      .filter(Boolean)
      .join(", ") || "—",
  ]);
  if (m.referenceIds?.length) rows.push(["תמונות ייחוס", String(m.referenceIds.length)]);
  rows.push(["נוצר", new Date(m.createdAt).toLocaleString("he-IL")]);
  if (typeof job?.costEstimate === "number") rows.push([job.costReported ? "עלות (כפי שדווחה)" : "עלות מוערכת", `$${job.costEstimate.toFixed(3)}`]);
  if (job?.requestId) rows.push(["מזהה בקשה", job.requestId]);

  const copyPrompt = () => {
    if (m.prompt) navigator.clipboard.writeText(m.prompt).catch(() => {});
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">פרמטרי הג'נרוט · {layer.name}</div>

        <div className="settings-section">
          <table className="params-table">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k}>
                  <td className="params-k">{k}</td>
                  {/* A value that is all numbers, a model name or an id is machine data: mono, left to right. */}
                  <td className={`params-v ${isData(k, v) ? "is-data" : ""}`} dir={isData(k, v) ? "ltr" : undefined}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {m.prompt ? (
            <>
              <label className="field-label">פרומפט</label>
              <div className="params-prompt">{m.prompt}</div>
            </>
          ) : (
            <div className="caps-note">לא הוזן פרומפט מותאם לג'נרוט הזה.</div>
          )}
        </div>

        {/* Save this layer's recipe as a named, reusable action. */}
        {saveName !== null && (
          <div className="chat-keyinput params-save">
            <input
              autoFocus
              placeholder="שם הפעולה — למשל: רסטורציה"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && saveName.trim()) {
                  saveActionFromLayer(layerId, saveName);
                  setSaveName(null);
                  onClose();
                }
              }}
            />
            <button
              disabled={!saveName.trim()}
              onClick={() => {
                saveActionFromLayer(layerId, saveName);
                setSaveName(null);
                onClose();
              }}
            >
              שמור
            </button>
          </div>
        )}

        <div className="modal-actions">
          <button
            className="primary"
            onClick={() => {
              applyLayerParams(layerId);
              onClose();
            }}
          >
            החל פרמטרים על הפקדים
          </button>
          <button title="שמור את ההגדרה של השכבה הזו כפעולה בספרייה" onClick={() => setSaveName("")}>
            שמור כפעולה
          </button>
          {m.prompt && <button onClick={copyPrompt}>העתק פרומפט</button>}
          <button onClick={onClose}>סגור</button>
        </div>
      </div>
    </div>
  );
}
