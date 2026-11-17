import { useEffect, useState } from "react";

export function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [notes, setNotes] = useState("");
  const [replyEmail, setReplyEmail] = useState("");
  const [info, setInfo] = useState<{ version: string; platform: string } | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    window.mbrush.appInfo().then((r) => r.ok && r.data && setInfo(r.data));
  }, []);

  const send = async () => {
    if (!notes.trim()) {
      setErr("נא לכתוב הערה לפני השליחה");
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await window.mbrush.submitFeedback({
      message: notes.trim(),
      email: replyEmail.trim() || undefined,
      version: info?.version,
      platform: info?.platform,
    });
    setBusy(false);
    if (r.ok) setSent(true);
    else setErr(r.error ?? "השליחה נכשלה");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">שליחת משוב</div>

        {sent ? (
          <div className="settings-section">
            <div className="secure-note ok">המשוב נשלח ישירות למפתח. תודה רבה!</div>
            <div className="modal-actions">
              <button className="primary" onClick={onClose}>סגור</button>
            </div>
          </div>
        ) : (
          <div className="settings-section">
            <p className="onboard-lead fb-lead">
              יש הערה, באג או רעיון? כתוב כאן וההודעה תישלח ישירות אליי, מתוך האפליקציה —
              בלי לפתוח דוא״ל. (נשלחים גם פרטי הגרסה והמערכת לאבחון.)
            </p>

            <label className="field-label">ההערה שלך</label>
            <textarea
              className="fb-text"
              placeholder="מה עבד, מה לא, מה היית רוצה שיתווסף..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />

            <label className="field-label">האימייל שלך (לא חובה — למענה)</label>
            <input
              type="email"
              placeholder="you@example.com"
              value={replyEmail}
              onChange={(e) => setReplyEmail(e.target.value)}
              autoComplete="off"
            />

            <div className="caps-note fb-ver">גרסה {info?.version ?? "…"} · {info?.platform ?? ""}</div>
            {err && <div className="msg bad">{err}</div>}

            <div className="modal-actions">
              <button className="primary" onClick={send} disabled={busy}>
                {busy ? "שולח…" : "שלח משוב"}
              </button>
              <button onClick={onClose}>ביטול</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
