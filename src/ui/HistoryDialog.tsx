import { useStore, modeLabel } from "../state/store";

/** Generation timeline: every job the project ran — prompt, engine, cost — with
 *  one-click "restore params" / "re-run". Turns each project into its own recipe book. */
export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const thumbnails = useStore((s) => s.thumbnails);
  const applyJobParams = useStore((s) => s.applyJobParams);
  const generate = useStore((s) => s.generate);
  const busy = useStore((s) => s.busy);

  const jobs = [...(project?.jobs ?? [])].reverse();

  const rerun = (jobId: string) => {
    applyJobParams(jobId);
    onClose();
    // Let the params land in state before launching.
    setTimeout(() => useStore.getState().generate(), 50);
  };
  void generate;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal spend-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">היסטוריית ג'נרוטים</div>

        {jobs.length === 0 ? (
          <div className="refs-empty">עדיין לא בוצעו ג'נרוטים בפרויקט הזה.</div>
        ) : (
          <div className="hist-list">
            {jobs.map((j) => (
              <div key={j.id} className="hist-row">
                <div className="hist-thumb">
                  {j.outputLayerId && thumbnails[j.outputLayerId] ? (
                    <img src={thumbnails[j.outputLayerId]} alt="" />
                  ) : (
                    <div className="thumb-fallback" />
                  )}
                </div>
                <div className="hist-main">
                  <div className="hist-top">
                    <span className="hist-mode">{modeLabel(j.mode)}</span>
                    <span className="hist-engine">{j.providerId} · {j.modelId}</span>
                    {typeof j.costEstimate === "number" && (
                      <span className="hist-cost">${j.costEstimate.toFixed(3)}</span>
                    )}
                  </div>
                  <div className="hist-prompt" title={j.prompt || ""}>
                    {j.prompt?.trim() || <span className="hist-noprompt">(ללא פרומפט)</span>}
                  </div>
                  <div className="hist-time">{new Date(j.timestamp).toLocaleString("he-IL")}</div>
                </div>
                <div className="hist-actions">
                  <button title="שחזר את הפרמטרים לפקדים (בלי להריץ)" onClick={() => { applyJobParams(j.id); onClose(); }}>
                    שחזר פרמטרים
                  </button>
                  <button className="primary" title="שחזר והרץ שוב (עלות חדשה)" disabled={busy} onClick={() => rerun(j.id)}>
                    הרץ שוב
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="modal-footer">
          <button onClick={onClose}>סגור</button>
        </div>
      </div>
    </div>
  );
}
