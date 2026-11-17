import { useState } from "react";
import { useStore } from "../state/store";

export function LicenseGate() {
  const activateLicense = useStore((s) => s.activateLicense);
  const error = useStore((s) => s.error);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    await activateLicense(code.trim());
    setBusy(false);
  };

  return (
    <div className="modal-backdrop license-backdrop">
      <div className="modal onboarding">
        <div className="brand center">
          <span className="brand-he big">המכחול המכני <span className="stage-chip">BETA</span></span>
          <span className="brand-en">The Mechanical Brush</span>
        </div>

        <p className="onboard-lead">
          להפעלת התוכנה נדרש <b>קוד רישוי</b> שמתקבל מהמפתח.
          הזן את הקוד שקיבלת כדי להתחיל.
        </p>

        <label className="field-label">קוד רישוי</label>
        <input
          type="text"
          className="code-input"
          placeholder="הדבק כאן את הקוד..."
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
          spellCheck={false}
        />

        {error && <div className="msg bad">{error}</div>}

        <div className="modal-actions">
          <button className="primary" onClick={submit} disabled={busy || !code.trim()}>
            {busy ? "מאמת…" : "הפעל"}
          </button>
        </div>

        <div className="copyright-note">
          אין לך קוד? פנה ל־
          <a dir="ltr" className="mail-link" href="mailto:saundersnp@gmail.com">
            saundersnp@gmail.com
          </a>{" "}
          לקבלת גישה.
          <br />
          כל הזכויות שמורות לנמרוד סונדרס — המכחול המכני <span dir="ltr">· © 2026</span>
        </div>
      </div>
    </div>
  );
}
