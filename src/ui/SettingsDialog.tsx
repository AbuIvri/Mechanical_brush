import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { version as APP_VERSION } from "../../package.json";
import { useLayout, THEMES, WELLS, PROMPT_FONT, type Theme, type Well } from "../state/layout";

const THEME_LABEL: Record<Theme, string> = { grey: "אפור", black: "שחור", white: "לבן" };
const WELL_LABEL: Record<Well, string> = { black: "שחור", dark: "כהה", grey: "אפור בינוני" };

/** Cross-tool key reuse offers (image engine ← chat key of the SAME vendor).
 *  Reuse always requires explicit user consent — never silent. Extend per vendor
 *  only when the keys are genuinely interchangeable (NOT Gemini: nano-banana uses
 *  a fal.ai key while the chat uses a Google AI Studio key). */
const KEY_LINKS: { imageProviderId: string; chatKeyId: string; vendorLabel: string }[] = [
  { imageProviderId: "grok", chatKeyId: "chat-xai", vendorLabel: "xAI (Grok)" },
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const secure = useStore((s) => s.secureStorage);
  const configuredKeys = useStore((s) => s.configuredKeys);
  const refreshKeys = useStore((s) => s.refreshKeys);

  const [selected, setSelected] = useState(providers.find((p) => p.requiresApiKey)?.id ?? providers[0]?.id ?? "");
  const [keyInput, setKeyInput] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [validating, setValidating] = useState(false);

  const provider = providers.find((p) => p.id === selected);
  const theme = useLayout((s) => s.theme);
  const setTheme = useLayout((s) => s.setTheme);
  const promptFont = useLayout((s) => s.promptFont);
  const setPromptFont = useLayout((s) => s.setPromptFont);
  const well = useLayout((s) => s.well);
  const setWell = useLayout((s) => s.setWell);

  // Cross-tool key reuse: if the selected image engine has a same-vendor chat key
  // already configured (and no key of its own yet), offer — with explicit consent —
  // to reuse it. "linkOffer" holds the offer; "linkDeclined" hides it for this open.
  const link = KEY_LINKS.find((l) => l.imageProviderId === selected);
  const [linkAvailable, setLinkAvailable] = useState(false);
  const [linkDeclined, setLinkDeclined] = useState(false);

  useEffect(() => {
    setKeyInput("");
    setMsg(null);
    setLinkAvailable(false);
    setLinkDeclined(false);
    if (!selected) return;
    window.mbrush.keyGet(selected).then((r) => {
      if (r.ok && r.data) setHint(r.data.hint);
      else setHint(null);
    });
    if (link) {
      window.mbrush.keyGet(link.chatKeyId).then((r) => {
        setLinkAvailable(!!(r.ok && r.data?.configured));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const acceptLink = async () => {
    if (!link) return;
    const r = await window.mbrush.keyLink(link.chatKeyId, selected);
    if (r.ok) {
      setMsg({ ok: true, text: "המפתח שויך גם ליצירת תמונות." });
      setLinkAvailable(false);
      await refreshKeys();
      window.mbrush.keyGet(selected).then((x) => x.ok && x.data && setHint(x.data.hint));
    } else {
      setMsg({ ok: false, text: r.error || "שיוך המפתח נכשל" });
    }
  };

  const save = async () => {
    if (!keyInput.trim()) return;
    setValidating(true);
    setMsg(null);
    const v = await window.mbrush.keyValidate(selected, keyInput.trim());
    if (!v.ok || !v.data?.valid) {
      setValidating(false);
      setMsg({ ok: false, text: v.data?.message || v.error || "מפתח לא תקין" });
      return;
    }
    const set = await window.mbrush.keySet(selected, keyInput.trim());
    setValidating(false);
    if (set.ok) {
      setMsg({ ok: true, text: "המפתח נשמר ואומת בהצלחה" });
      setKeyInput("");
      await refreshKeys();
      window.mbrush.keyGet(selected).then((r) => r.ok && r.data && setHint(r.data.hint));
    } else {
      setMsg({ ok: false, text: set.error || "שמירה נכשלה" });
    }
  };

  const remove = async () => {
    await window.mbrush.keyRemove(selected);
    setHint(null);
    setMsg({ ok: true, text: "המפתח הוסר" });
    await refreshKeys();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">הגדרות</div>

        <div className="settings-section">
          <h4>ניהול מפתחות API</h4>
          <div className={`secure-note ${secure ? "ok" : "warn"}`}>
            {secure
              ? "אחסון מאובטח פעיל — המפתחות מוצפנים ב-Keychain של המערכת."
              : "אזהרה: אחסון מאובטח אינו זמין. המפתחות יישמרו מקומית בהצפנה בסיסית בלבד."}
          </div>

          <label className="field-label">ספק</label>
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.requiresApiKey ? "" : "(ללא מפתח)"} {configuredKeys.includes(p.id) ? "· מוגדר" : ""}
              </option>
            ))}
          </select>

          {provider?.requiresApiKey ? (
            <>
              {link && linkAvailable && !linkDeclined && !hint && (
                <div className="secure-note offer">
                  <span>
                    זוהה מפתח {link.vendorLabel} שכבר הוגדר לצ'אט. להשתמש באותו מפתח גם ליצירת
                    תמונות? (הרחבת שימוש בין מודל שפה למודל תמונות — באישורך בלבד)
                  </span>
                  <div className="modal-actions tight">
                    <button className="primary" onClick={acceptLink}>כן, השתמש באותו מפתח</button>
                    <button onClick={() => setLinkDeclined(true)}>לא, אזין מפתח נפרד</button>
                  </div>
                </div>
              )}
              <label className="field-label">מפתח API {hint && <span className="hint">מוגדר: <span className="key-hint" dir="ltr">{hint}</span></span>}</label>
              <input
                type="password"
                className="key-input"
                placeholder="sk-..."
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                autoComplete="off"
              />
              {msg && <div className={`msg ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}
              <div className="modal-actions">
                <button className="primary" onClick={save} disabled={validating || !keyInput.trim()}>
                  {validating ? "מאמת…" : "אמת ושמור"}
                </button>
                {hint && <button className="danger" onClick={remove}>הסר מפתח</button>}
              </div>
            </>
          ) : (
            <div className="secure-note ok">ספק זה אינו דורש מפתח API.</div>
          )}
        </div>

        {provider && (
          <div className="settings-section">
            <h4>יכולות המנוע</h4>
            <ul className="caps">
              <li><span>אפסקייל</span> {yn(provider.capabilities.supportsUpscale)}</li>
              <li><span>יצירה מחדש</span> {yn(provider.capabilities.supportsRecreate)}</li>
              <li><span>מילוי גנרטיבי / מסכות</span> {yn(provider.capabilities.supportsInpainting)}</li>
              <li><span>תמונות ייחוס</span> {yn(provider.capabilities.supportsReferenceImages)}</li>
              <li><span>גודל פלט מותאם</span> {yn(provider.capabilities.supportsCustomOutputSize)}</li>
              <li><span>שקיפות</span> {yn(provider.capabilities.supportsTransparency)}</li>
            </ul>
            {provider.capabilities.notes && <p className="caps-note">{provider.capabilities.notes}</p>}
          </div>
        )}

        <div className="settings-section">
          <h4>ממשק</h4>
          <label className="field-label">צבע הממשק</label>
          <div className="seg-row" role="radiogroup" aria-label="צבע הממשק">
            {THEMES.map((t) => (
              <button
                key={t}
                role="radio"
                aria-checked={theme === t}
                className={`seg-btn ${theme === t ? "on" : ""}`}
                onClick={() => setTheme(t)}
              >
                <span className={`theme-swatch theme-swatch--${t}`} aria-hidden="true" />
                {THEME_LABEL[t]}
              </button>
            ))}
          </div>
          <label className="field-label">רקע סביב התמונה</label>
          <div className="seg-row" role="radiogroup" aria-label="רקע סביב התמונה">
            {WELLS.map((w) => (
              <button
                key={w}
                role="radio"
                aria-checked={well === w}
                className={`seg-btn ${well === w ? "on" : ""}`}
                onClick={() => setWell(w)}
                title={w === "grey" ? "אפור ניטרלי — הכי נכון לשיפוט צבע" : undefined}
              >
                <span className={`theme-swatch well-swatch--${w}`} aria-hidden="true" />
                {WELL_LABEL[w]}
              </button>
            ))}
          </div>
          <label className="field-label">
            גודל הטקסט בתיבת הפרומפט <span className="hint" dir="ltr">{promptFont}px</span>
          </label>
          <div className="font-row">
            <input
              type="range"
              min={PROMPT_FONT.min}
              max={PROMPT_FONT.max}
              value={promptFont}
              onChange={(e) => setPromptFont(Number(e.target.value))}
              aria-label="גודל הטקסט בתיבת הפרומפט"
            />
            <button onClick={() => setPromptFont(PROMPT_FONT.default)} disabled={promptFont === PROMPT_FONT.default}>
              ברירת מחדל
            </button>
          </div>
          <div className="font-preview" style={{ fontSize: promptFont }}>הוסף ארבע ציציות לבנות לשולי החולצה</div>
        </div>

        <div className="settings-section">
          <h4>אודות</h4>
          <div className="about-box">
            <div>המכחול המכני · The Mechanical Brush</div>
            <div className="about-ver">גרסה <span dir="ltr">{APP_VERSION}</span> · <span className="stage-chip">BETA</span></div>
            <div className="about-copy">
              © 2026 נמרוד פסח סונדרס. כל הזכויות לפיתוח ולהפצה שמורות.<br />
              התוכנה מסופקת כמות שהיא (AS-IS), ללא אחריות. השימוש במפתחות ה-API ובעלויות באחריות המשתמש.
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>סגור</button>
        </div>
      </div>
    </div>
  );
}

function yn(b: boolean) {
  return <b className={b ? "yes" : "no"}>{b ? "כן" : "לא"}</b>;
}
