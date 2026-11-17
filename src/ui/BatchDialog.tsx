import { useRef, useState } from "react";
import { useStore, modeLabel } from "../state/store";
import { useBatch } from "../state/batch";
import { BATCH_MODES, type BatchAction, type BatchMode } from "../batchRun";
import { PromptListTab } from "./PromptListTab";

const STATUS_LABEL: Record<string, string> = {
  pending: "ממתין",
  running: "מעבד…",
  done: "הושלם",
  failed: "נכשל",
};

/** Batch processing — run one action on many files, outputs into a chosen folder.
 *  Uses the stateless engine IPC per file; the open project is never touched. */
export function BatchDialog({ onClose }: { onClose: () => void }) {
  const items = useBatch((s) => s.items);
  const running = useBatch((s) => s.running);
  const outDir = useBatch((s) => s.outDir);
  const totalCost = useBatch((s) => s.totalCost);
  const addFiles = useBatch((s) => s.addFiles);
  const removeItem = useBatch((s) => s.removeItem);
  const clear = useBatch((s) => s.clear);
  const chooseOutDir = useBatch((s) => s.chooseOutDir);
  const cancel = useBatch((s) => s.cancel);
  const resetFailed = useBatch((s) => s.resetFailed);
  const run = useBatch((s) => s.run);
  const tab = useBatch((s) => s.tab);
  const setTab = useBatch((s) => s.setTab);

  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.providerId);
  const modelId = useStore((s) => s.modelId);
  const mode = useStore((s) => s.mode);
  const prompt = useStore((s) => s.prompt);
  const settings = useStore((s) => s.settings);
  const savedActions = useStore((s) => s.savedActions);
  const configuredKeys = useStore((s) => s.configuredKeys);
  const budgetCap = useStore((s) => s.budgetCap);
  const sessionSpend = useStore((s) => s.sessionSpend);

  const fileRef = useRef<HTMLInputElement>(null);
  const [actionSel, setActionSel] = useState("current");
  const [err, setErr] = useState<string | null>(null);

  const isBatchable = (m: string) => (BATCH_MODES as string[]).includes(m);
  const batchableActions = savedActions.filter((a) => isBatchable(a.mode));

  const chosen: BatchAction | null = (() => {
    if (actionSel === "current") {
      return isBatchable(mode)
        ? { mode: mode as BatchMode, prompt, settings, providerId, modelId }
        : null;
    }
    const a = savedActions.find((x) => x.id === actionSel);
    return a && isBatchable(a.mode)
      ? { mode: a.mode as BatchMode, prompt: a.prompt, settings: a.settings, providerId: a.providerId, modelId: a.modelId }
      : null;
  })();
  const chosenProvider = providers.find((p) => p.id === chosen?.providerId);

  const onPickFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    Promise.all(
      list.map(
        (f) =>
          new Promise<{ name: string; dataUrl: string }>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve({ name: f.name, dataUrl: String(r.result) });
            r.onerror = reject;
            r.readAsDataURL(f);
          }),
      ),
    ).then((loaded) => addFiles(loaded));
  };

  const pendingCount = items.filter((i) => i.status === "pending").length;
  const doneCount = items.filter((i) => i.status === "done").length;
  const failedCount = items.filter((i) => i.status === "failed").length;

  const startRun = () => {
    setErr(null);
    if (!chosen) return setErr("בחר פעולה מתאימה לבאטץ' (יצירה מחדש / אפסקייל / שינוי פורמט)");
    if (!outDir) return setErr("בחר תיקיית פלט");
    if (!pendingCount) return setErr("אין קבצים ממתינים — הוסף תמונות");
    if (chosenProvider?.requiresApiKey && !configuredKeys.includes(chosen.providerId)) {
      return setErr(`למנוע ${chosenProvider.name} חסר מפתח API — הגדר אותו בהגדרות`);
    }
    if (budgetCap > 0 && sessionSpend >= budgetCap) {
      return setErr(`הגעת לתקרת התקציב להפעלה ($${budgetCap.toFixed(2)})`);
    }
    run(chosen, chosenProvider);
  };

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="modal spend-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">באטץ'</div>
        {/* Two kinds of many: one action on many files, or one image from each of many
            prompts. */}
        <div className="batch-tabs">
          <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")} disabled={running}>
            קבצים — פעולה אחת על הרבה תמונות
          </button>
          <button className={tab === "prompts" ? "on" : ""} onClick={() => setTab("prompts")} disabled={running}>
            פרומפטים — תמונה לכל פרומפט
          </button>
        </div>

        {tab === "prompts" ? (
          <PromptListTab onClose={onClose} />
        ) : (
        <>
        {/* 1 — files */}
        <div className="settings-section">
          <div className="layers-head-row">
            <button className="layer-add" onClick={() => fileRef.current?.click()} disabled={running}>
              בחר תמונות
            </button>
            {items.length > 0 && (
              <button className="layer-add" onClick={clear} disabled={running}>נקה הכל</button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              onPickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {items.length === 0 ? (
            <div className="caps-note">בחר כמה תמונות — הפעולה תרוץ על כולן ברצף, בלי לגעת בפרויקט הפתוח.</div>
          ) : (
            <div className="hist-list batch-list">
              {items.map((i) => (
                <div key={i.id} className="hist-row">
                  <div className="hist-thumb">{i.thumb && <img src={i.thumb} alt="" />}</div>
                  <div className="batch-item">
                    <div className="batch-name">{i.name}</div>
                    {i.outName && <div className="batch-out" dir="ltr">→ {i.outName}</div>}
                    {i.error && <div className="batch-err">{i.error}</div>}
                  </div>
                  <span className={`batch-chip ${i.status}`}>{STATUS_LABEL[i.status]}</span>
                  <button className="fc-x" title="הסר" disabled={running} onClick={() => removeItem(i.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 2 — action */}
        <div className="settings-section">
          <label className="field-label">פעולה</label>
          <select value={actionSel} onChange={(e) => setActionSel(e.target.value)} disabled={running}>
            <option value="current" disabled={!isBatchable(mode)}>
              ההגדרות הנוכחיות ({modeLabel(mode)}{isBatchable(mode) ? "" : " — לא נתמך בבאטץ'"})
            </option>
            {batchableActions.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({modeLabel(a.mode)})</option>
            ))}
          </select>
          {chosen && (
            <div className="caps-note batch-chosen">
              {modeLabel(chosen.mode)} · {chosenProvider?.name ?? chosen.providerId} · {chosen.modelId}
              {chosen.prompt.trim() ? ` · "${chosen.prompt.slice(0, 60)}${chosen.prompt.length > 60 ? "…" : ""}"` : ""}
            </div>
          )}
        </div>

        {/* 3 — output */}
        <div className="settings-section">
          <label className="field-label">תיקיית פלט</label>
          <div className="layers-head-row">
            <button className="layer-add" onClick={chooseOutDir} disabled={running}>בחר תיקייה</button>
            <span className={`batch-dir ${outDir ? "" : "is-empty"}`} dir={outDir ? "ltr" : undefined}>
              {outDir ?? "לא נבחרה"}
            </span>
          </div>
          <div className="caps-note">כל פלט נשמר גם בארכיון הרגיל (פלט מהמכחול, לפי מנוע ומודל).</div>
        </div>

        {err && <div className="msg bad">{err}</div>}

        <div className="modal-footer with-status">
          <span className="modal-status">
            {items.length > 0 && `${doneCount}/${items.length} הושלמו`}
            {failedCount > 0 && ` · ${failedCount} נכשלו`}
            {totalCost > 0 && ` · עלות מוערכת $${totalCost.toFixed(3)}`}
          </span>
          {failedCount > 0 && !running && (
            <button onClick={resetFailed}>נסה שוב את הכשלים</button>
          )}
          {running ? (
            <button className="danger" onClick={cancel}>עצור אחרי הפריט הנוכחי</button>
          ) : (
            <button className="primary" onClick={startRun} disabled={items.length === 0}>
              הרץ על {pendingCount || items.length} קבצים
            </button>
          )}
          <button onClick={onClose} disabled={running}>סגור</button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
