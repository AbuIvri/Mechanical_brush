import { useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useBatch } from "../state/batch";
import { parsePromptList } from "../promptList";

/** Many prompts → an image each, every one in its own tab.
 *
 *  The text is the whole interface: paste it, type it, or import a .txt. What the app
 *  understood is shown underneath before anything runs, and what the prompt bar says now
 *  (engine, model, resolution, the reference shelf) is what every prompt runs with. */
export function PromptListTab({ onClose }: { onClose: () => void }) {
  const text = useBatch((s) => s.promptText);
  const dir = useBatch((s) => s.promptDir);
  const source = useBatch((s) => s.promptSource);
  const setText = useBatch((s) => s.setPromptText);
  const openPrompts = useBatch((s) => s.openPrompts);

  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.providerId);
  const modelId = useStore((s) => s.modelId);
  const settings = useStore((s) => s.settings);
  const shelf = useStore((s) => s.references.length);
  const configuredKeys = useStore((s) => s.configuredKeys);
  const budgetCap = useStore((s) => s.budgetCap);
  const sessionSpend = useStore((s) => s.sessionSpend);
  const listRun = useStore((s) => s.listRun);
  const runPromptList = useStore((s) => s.runPromptList);

  const fileRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const { items, warnings, headings } = useMemo(() => parsePromptList(text), [text]);

  const provider = providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId)?.label ?? modelId;
  const aspect = String(settings.aspectRatio ?? "auto");

  const importFile = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setErr(null);
    const path = window.mbrush.pathForFile(f);
    if (path) {
      // Through the main process, so the file's folder is granted for its "@file" images.
      void window.mbrush.promptFileOpen(path).then((r) => {
        if (r.ok && r.data) openPrompts(r.data.text, r.data.dir, r.data.path);
        else setErr(r.error ?? "קריאת הקובץ נכשלה");
      });
      return;
    }
    // A Word document is read in the main process, from its path.
    if (/\.docx$/i.test(f.name)) return setErr(`לא הצלחתי לקרוא את ${f.name} — פתח אותו דרך „פתח”.`);
    void f.text().then((t) => openPrompts(t, null, f.name));
  };

  const start = () => {
    setErr(null);
    if (!items.length) return setErr("אין עדיין פרומפטים — הדבק רשימה או ייבא קובץ טקסט");
    if (provider?.requiresApiKey && !configuredKeys.includes(providerId)) {
      return setErr(`למנוע ${provider.name} חסר מפתח API — הגדר אותו בהגדרות`);
    }
    if (budgetCap > 0 && sessionSpend >= budgetCap) return setErr(`הגעת לתקרת התקציב להפעלה ($${budgetCap.toFixed(2)})`);
    onClose();
    void runPromptList(items, dir);
  };

  return (
    <>
      <div className="settings-section">
        <div className="layers-head-row">
          <button className="layer-add" onClick={() => fileRef.current?.click()} disabled={!!listRun}>
            ייבא קובץ (טקסט או Word)…
          </button>
          {source && (
            <span className="plist-source" dir="auto" title={source}>
              {source.split(/[\\/]/).pop()}
            </span>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.docx,text/plain"
          hidden
          onChange={(e) => {
            importFile(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          className="plist-text"
          dir="auto"
          value={text}
          // Typed text has no folder: "@file" can only be resolved for a list from a file.
          onChange={(e) => setText(e.target.value)}
          placeholder={"פרומפט אחד בכל פסקה (שורה ריקה ביניהם), או פרומפט בכל שורה.\n\nA red sneaker on wet asphalt, night city lights\n\n[16:9] The same sneaker on a white studio sweep\n\n@logo.png A billboard with this logo above a desert highway"}
        />
        <div className="caps-note">
          אופציונלי בתחילת פרומפט: <code>[16:9]</code> ליחס משלו · <code>@קובץ.png</code> לתמונת ייחוס משלו (מהתיקייה של קובץ
          הטקסט) · שורה שמתחילה ב-<code>//</code> היא הערה.
        </div>
      </div>

      {items.length > 0 && (
        <div className="settings-section">
          <div className="hist-list plist-preview">
            {items.map((it, i) => (
              <div key={i} className="plist-row" title={it.prompt}>
                <span className="plist-n">{i + 1}</span>
                {it.title && <span className="plist-title" dir="auto">{it.title}</span>}
                <span className="plist-prompt" dir="auto">{it.prompt}</span>
                {it.aspect && (
                  <span className="plist-tag" title={it.aspectFromText ? "היחס נלקח מתוך הטקסט של הפרומפט" : undefined}>
                    {it.aspect}
                    {it.aspectFromText ? " · מהטקסט" : ""}
                  </span>
                )}
                {it.refs.map((r) => (
                  <span key={r} className="plist-tag" dir="ltr">@{r}</span>
                ))}
              </div>
            ))}
          </div>
          {headings.length > 0 && (
            <div className="caps-note" title={headings.join("\n")}>
              {headings.length} שורות הובנו ככותרות או הערות ולא כפרומפטים — לא ירוצו. כותרת שמעל פרומפט נותנת שם ללשונית שלו.
            </div>
          )}
          {warnings.map((w, i) => (
            <div key={i} className="caps-note warn">{w}</div>
          ))}
        </div>
      )}

      {err && <div className="msg bad">{err}</div>}

      <div className="modal-footer with-status">
        <span className="modal-status">
          {provider?.name ?? providerId} · {model}
          {aspect !== "auto" ? ` · ${aspect}` : ""}
          {shelf ? ` · ${shelf} ייחוסים מהמדף לכל פרומפט` : ""}
          {items.length > 20 ? ` · ${items.length} לשוניות ייפתחו` : ""}
          {" · "}כל תמונה מחויבת בנפרד
        </span>
        <button className="primary" onClick={start} disabled={!items.length || !!listRun}>
          {listRun ? "רשימה כבר רצה…" : `צור ${items.length || ""} תמונות`}
        </button>
        <button onClick={onClose}>סגור</button>
      </div>
    </>
  );
}
