import { useState } from "react";
import { useStore } from "../state/store";
import { maskHasContent } from "../compositing";
import { eraseModelFor } from "../../shared/erasePrompts";

/** The erase brush's confirm step, floating over the canvas.
 *
 *  Painting is free; erasing costs a generation per area, so nothing runs until this is
 *  pressed. With more than one separate area the user chooses the trade-off: a patch per
 *  area (precise, keeps the rest of the picture untouched, N runs) or one pass over the
 *  whole frame (one run, but the engine re-renders everything and may change more). */
export function EraseBar() {
  const project = useStore((s) => s.project);
  const removeMask = useStore((s) => s.removeMask);
  const busy = useStore((s) => s.busy);
  const tool = useStore((s) => s.tool);
  const provider = useStore((s) => s.providers.find((p) => p.id === s.providerId));
  const modelId = useStore((s) => s.modelId);
  const planErase = useStore((s) => s.planErase);
  const runErase = useStore((s) => s.runErase);
  const clearRemoveMask = useStore((s) => s.clearRemoveMask);
  const [counting, setCounting] = useState(false);
  const [choice, setChoice] = useState<number | null>(null);

  if (!project) return null;
  const painted = maskHasContent(removeMask);
  if (!painted) {
    return tool === "remove" ? (
      <div className="erase-bar hint">צייר על מה שצריך להיעלם — המחיקה רצה רק אחרי אישור</div>
    ) : null;
  }

  // Erasing runs on whatever engine and model are selected in the top bar. The only engine
  // that cannot is one that does no editing at all — the upscaler.
  const canInpaint = !!provider?.capabilities?.supportsInpainting;
  const canWhole = !!provider?.capabilities?.supportsRecreate;
  const engineName = provider?.name ?? "המנוע";
  // An erase on umage2 runs on Sunburst whatever the picker says — say so rather than
  // showing a model that will not be the one doing the work.
  const eraseModel = provider ? eraseModelFor(provider.id, modelId, provider.models) : modelId;
  const modelName = provider?.models.find((m) => m.id === eraseModel)?.label ?? eraseModel;
  const via = `${engineName} · ${modelName}`;

  const start = async () => {
    setCounting(true);
    try {
      const n = await planErase();
      if (n <= 1) await runErase("areas");
      else setChoice(n);
    } finally {
      setCounting(false);
    }
  };
  const pick = (scope: "areas" | "whole") => {
    setChoice(null);
    void runErase(scope);
  };

  return (
    <>
      <div className="erase-bar">
        <span className="erase-swatch" />
        <button
          className="primary"
          disabled={busy || counting || !canInpaint}
          title={canInpaint ? `מחיקה במילוי גנרטיבי דרך ${via}` : `${engineName} לא עורך תמונות — בחר מנוע אחר בסרגל העליון`}
          onClick={() => void start()}
        >
          {counting ? "סופר אזורים…" : "מחק את המסומן"}
        </button>
        <button disabled={busy} onClick={clearRemoveMask} title="נקה את צבע המחיקה בלי להריץ">
          נקה
        </button>
        <span className="erase-via" title="המחיקה רצה במנוע ובמודל שבחורים בסרגל העליון">
          {canInpaint ? via : `${engineName} לא עורך — בחר מנוע אחר`}
        </span>
      </div>

      {choice != null && (
        <div className="modal-backdrop" onClick={() => setChoice(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">סומנו {choice} אזורים נפרדים למחיקה</div>
            <div className="settings-section">
              <p className="onboard-lead">
                דרך <b>{via}</b> — המנוע והמודל שבחורים בסרגל העליון.
              </p>
              <div className="dlg-choices">
                <button onClick={() => pick("areas")}>
                  <b>פאץ' לכל אזור — {choice} הרצות</b>
                  <small>מדויק יותר ושומר על פרטי התמונה המקורית. כל אזור מחויב בנפרד.</small>
                </button>
                <button onClick={() => pick("whole")} disabled={!canWhole}>
                  <b>הרצה אחת על כל התמונה</b>
                  <small>
                    {!canWhole
                      ? `${engineName} לא עורך תמונה שלמה.`
                      : "זולה יותר — הרצה אחת. המנוע מצייר את כל הפריים מחדש, אז סביר שישתנו גם דברים מחוץ לאזורים."}
                  </small>
                </button>
              </div>
              <div className="modal-actions">
                <button onClick={() => setChoice(null)}>ביטול</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
