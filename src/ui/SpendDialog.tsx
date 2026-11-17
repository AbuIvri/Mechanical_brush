import { useStore, modeLabel } from "../state/store";
import type { GenerationMode } from "../../shared/types";
import { monthKey, monthLabel, monthRows } from "../spend";

const PROVIDER_LABELS: Record<string, string> = {
  umage2: "umage2 (GPT)",
  "nano-banana": "Nano Banana",
  mock: "Mock",
};

export function SpendDialog({ onClose }: { onClose: () => void }) {
  const total = useStore((s) => s.totalSpend);
  const session = useStore((s) => s.sessionSpend);
  const genCount = useStore((s) => s.genCount);
  const entries = useStore((s) => s.spendEntries);
  const budgetCap = useStore((s) => s.budgetCap);
  const setBudgetCap = useStore((s) => s.setBudgetCap);
  const months = useStore((s) => s.spendMonths);

  const reversed = [...entries].reverse();
  const rows = monthRows(months);
  const thisMonth = monthKey(Date.now());

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal spend-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">פירוט הוצאות</div>

        <div className="spend-summary">
          <div className="spend-card">
            <div className="spend-card-num">${total.toFixed(3)}</div>
            <div className="spend-card-label">סה״כ מצטבר ({entries.length} ג'נרוטים)</div>
          </div>
          <div className="spend-card">
            <div className="spend-card-num">${session.toFixed(3)}</div>
            <div className="spend-card-label">הפעלה נוכחית ({genCount})</div>
          </div>
        </div>

        <p className="caps-note">
          הסכומים הם <b>אומדן</b> לפי המודל, הגודל והאיכות שנבחרו — לחיוב המדויק היכנס לחשבון
          הספק (OpenAI / fal). הנתונים נשמרים מקומית בלבד.
        </p>

        <div className="budget-row">
          <span>תקרת הוצאה להפעלה (0 = ללא):</span>
          <input
            type="number"
            min={0}
            step={0.5}
            dir="ltr"
            value={budgetCap}
            onChange={(e) => setBudgetCap(Number(e.target.value))}
          />
          <span className="budget-unit">$</span>
          {budgetCap > 0 && (
            <span className={`budget-left ${session >= budgetCap ? "over" : ""}`}>
              {session >= budgetCap ? "התקרה הושגה — יצירה חסומה" : `נותרו $${(budgetCap - session).toFixed(2)}`}
            </span>
          )}
        </div>

        {rows.length > 0 && (
          <>
            <div className="spend-section-title">לפי חודש</div>
            <div className="spend-months">
              {rows.map((m) => (
                <div key={m.key} className={`spend-month ${m.key === thisMonth ? "now" : ""}`}>
                  <span className="spend-month-name">{monthLabel(m.key)}</span>
                  <span className="spend-month-count">{m.count} ג'נרוטים</span>
                  <span className="spend-month-cost">${m.total.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="spend-section-title">כל הג'נרוטים</div>
        <div className="spend-table-wrap">
          {reversed.length === 0 ? (
            <div className="refs-empty">עדיין לא בוצעו ג'נרוטים בתשלום.</div>
          ) : (
            <table className="spend-table">
              <thead>
                <tr>
                  <th>מתי</th>
                  <th>פעולה</th>
                  <th>מנוע</th>
                  <th>מודל</th>
                  <th>עלות</th>
                </tr>
              </thead>
              <tbody>
                {reversed.map((e, i) => (
                  <tr key={i}>
                    <td className="spend-when">{new Date(e.ts).toLocaleString("he-IL")}</td>
                    <td>{e.mode ? modeLabel(e.mode as GenerationMode) : "—"}</td>
                    <td>{PROVIDER_LABELS[e.providerId ?? ""] ?? e.providerId ?? "—"}</td>
                    <td className="mono">{e.modelId ?? "—"}</td>
                    <td className="spend-cost">${e.cost.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>סגור</button>
        </div>
      </div>
    </div>
  );
}
