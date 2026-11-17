import { useState } from "react";
import { useStore } from "../state/store";

export function Onboarding() {
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.providerId);
  const setProvider = useStore((s) => s.setProvider);
  const refreshKeys = useStore((s) => s.refreshKeys);
  const setOnboarding = useStore((s) => s.setOnboarding);

  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const provider = providers.find((p) => p.id === providerId);

  const finish = async () => {
    if (provider?.requiresApiKey) {
      if (!key.trim()) return setErr("יש להזין מפתח API");
      setBusy(true);
      const v = await window.mbrush.keyValidate(providerId, key.trim());
      if (!v.ok || !v.data?.valid) {
        setBusy(false);
        return setErr(v.data?.message || v.error || "מפתח לא תקין");
      }
      await window.mbrush.keySet(providerId, key.trim());
      await refreshKeys();
      setBusy(false);
    }
    setOnboarding(false);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal onboarding">
        <div className="brand center">
          <span className="brand-he big">המכחול המכני <span className="stage-chip">BETA</span></span>
          <span className="brand-en">The Mechanical Brush</span>
        </div>
        <p className="onboard-lead">
          כלי עריכת תמונות מקומי מבוסס שכבות ו-AI. כדי להתחיל, בחר מנוע והזן את מפתח ה-API שלך.
          המפתח נשמר מקומית ומוצפן — הוא לעולם לא נשמר בקבצי פרויקט.
        </p>

        <label className="field-label">מנוע AI</label>
        <select value={providerId} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        {provider?.requiresApiKey ? (
          <>
            <label className="field-label">מפתח API</label>
            <input type="password" className="key-input" placeholder="sk-..." value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
          </>
        ) : (
          <div className="secure-note ok">מנוע זה אינו דורש מפתח — אפשר להתחיל מיד.</div>
        )}

        {err && <div className="msg bad">{err}</div>}

        <div className="modal-actions">
          <button className="primary" onClick={finish} disabled={busy}>
            {busy ? "מאמת…" : "התחל"}
          </button>
          <button onClick={() => setOnboarding(false)}>דלג לעת עתה</button>
        </div>

        <div className="copyright-note">
          גרסת בטא · התוכנה מסופקת כמות שהיא (AS-IS).<br />
          © 2026 נמרוד פסח סונדרס — "המכחול המכני". כל הזכויות לפיתוח ולהפצה שמורות.
        </div>
      </div>
    </div>
  );
}
