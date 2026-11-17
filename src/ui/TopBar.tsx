import { useRef, useState } from "react";
import logoUrl from "../assets/logo.png";
import { useStore } from "../state/store";
import { monthKey, monthLabel } from "../spend";
import { useDismiss } from "./useDismiss";
import { WriteBackDialog } from "./BigImage";
import { Icon } from "./Icon";

export function TopBar({
  onOpenSettings,
  onOpenSpend,
  onOpenFeedback,
  onOpenHelp,
  onOpenHistory,
  onOpenBatch,
}: {
  onOpenSettings: () => void;
  onOpenSpend: () => void;
  onOpenFeedback: () => void;
  onOpenHelp: () => void;
  onOpenHistory: () => void;
  onOpenBatch: () => void;
}) {
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.providerId);
  const modelId = useStore((s) => s.modelId);
  const setProvider = useStore((s) => s.setProvider);
  const setModel = useStore((s) => s.setModel);
  const openImageOrProject = useStore((s) => s.openImageOrProject);
  // A piece of a bigger photo: its export can also put it back there.
  const isPiece = useStore((s) => !!s.project?.pieceSource);
  const [writeBack, setWriteBack] = useState(false);
  const newFromScratch = useStore((s) => s.newFromScratch);
  const newProjectTab = useStore((s) => s.newProjectTab);
  const hasProject = useStore((s) => !!s.project);
  const [openMenu, setOpenMenu] = useState(false);
  const openRef = useRef<HTMLDivElement>(null);
  useDismiss(openRef, () => setOpenMenu(false), openMenu);
  const [saveMenu, setSaveMenu] = useState(false);
  const saveRef = useRef<HTMLDivElement>(null);
  useDismiss(saveRef, () => setSaveMenu(false), saveMenu);
  const [moreMenu, setMoreMenu] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  useDismiss(moreRef, () => setMoreMenu(false), moreMenu);
  const saveProject = useStore((s) => s.saveProject);
  const exportFlattened = useStore((s) => s.exportFlattened);
  const closeProject = useStore((s) => s.closeProject);
  const project = useStore((s) => s.project);
  const dirty = useStore((s) => s.dirty);
  const configuredKeys = useStore((s) => s.configuredKeys);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const totalSpend = useStore((s) => s.totalSpend);
  const sessionSpend = useStore((s) => s.sessionSpend);
  // The bar shows THIS MONTH — the number a person actually watches. The cumulative
  // total is still a keystroke away, in the tooltip and the dialog.
  const spendMonths = useStore((s) => s.spendMonths);
  const thisMonth = spendMonths[monthKey(Date.now())];
  const genCount = useStore((s) => s.genCount);

  const provider = providers.find((p) => p.id === providerId);
  const keyOk = !provider?.requiresApiKey || configuredKeys.includes(providerId);

  return (
    <header className="tb">
      <div className="tb-brand">
        <img className="tb-logo" src={logoUrl} alt="" aria-hidden="true" draggable={false} />
        <span className="tb-wordmark">המכחול המכני</span>
        <span className="tb-stage">BETA</span>
      </div>

      {/* File: what you open, keep and take out. Words, not tiles. */}
      <nav className="tb-group" aria-label="קובץ">
        <button className="act" onClick={newFromScratch} title="צור תמונה חדשה מטקסט">תמונה חדשה</button>
        <div className="open-wrap" ref={openRef}>
          <button
            className="act"
            onClick={() => (hasProject ? setOpenMenu((v) => !v) : openImageOrProject())}
            title="פתח תמונה או פרויקט .mbrush"
            aria-haspopup={hasProject ? "menu" : undefined}
            aria-expanded={hasProject ? openMenu : undefined}
          >
            פתח{hasProject && <span className="caret-down"><Icon name="chevron" size={12} /></span>}
          </button>
          {openMenu && (
            <div className="open-menu" role="menu">
              <div className="open-menu-head">תמונה שנפתחת תהיה…</div>
              <button role="menuitem" onClick={() => { setOpenMenu(false); void openImageOrProject("layer"); }}>
                <b>שכבה בפרויקט הנוכחי</b>
                <small>נערמת מעל מה שפתוח עכשיו</small>
              </button>
              <button role="menuitem" onClick={() => { setOpenMenu(false); void openImageOrProject("tab"); }}>
                <b>פרויקט חדש בלשונית</b>
                <small>העבודה הנוכחית נשארת פתוחה לצידו</small>
              </button>
              <button role="menuitem" onClick={() => { setOpenMenu(false); void openImageOrProject("replace"); }}>
                <b>להחליף את הפרויקט הפתוח</b>
                <small>יישאל אם יש שינויים שלא נשמרו</small>
              </button>
              <div className="open-menu-note">קובץ .mbrush תמיד ייפתח בלשונית משלו.</div>
            </div>
          )}
        </div>
        <div className="open-wrap" ref={saveRef}>
          <button className="act" onClick={() => saveProject(false)} disabled={!project} title="שמור (⌘S)">
            שמור{dirty ? " •" : ""}
          </button>
          <button
            className="act act-caret"
            onClick={() => setSaveMenu((v) => !v)}
            disabled={!project}
            aria-label="אפשרויות שמירה"
            aria-haspopup="menu"
            aria-expanded={saveMenu}
          >
            <span className="caret-down"><Icon name="chevron" size={12} /></span>
          </button>
          {saveMenu && (
            <div className="open-menu tb-menu" role="menu">
              <button role="menuitem" onClick={() => { setSaveMenu(false); void saveProject(true); }}>
                <b>שמור בשם…</b>
                <small>עותק חדש, בשם ובמקום שתבחר</small>
              </button>
            </div>
          )}
        </div>
        <select
          className="act tb-export"
          value=""
          disabled={!project}
          title="ייצוא התמונה המשוטחת"
          aria-label="ייצוא"
          onChange={(e) => {
            const v = e.target.value as "png" | "jpeg" | "webp" | "clipboard" | "original" | "";
            if (v === "original") setWriteBack(true);
            else if (v) exportFlattened(v);
            e.target.value = "";
          }}
        >
          <option value="">ייצוא ⌄</option>
          {isPiece && <option value="original">החזר לתמונה המקורית…</option>}
          <option value="png">PNG (איכות מלאה)</option>
          <option value="jpeg">JPEG (קל לשיתוף)</option>
          <option value="webp">WebP</option>
          <option value="clipboard">העתק ללוח</option>
        </select>
        {writeBack && <WriteBackDialog onClose={() => setWriteBack(false)} />}
        <button className="act" onClick={onOpenBatch} title="עיבוד באטץ' — פעולה אחת על הרבה קבצים">באטץ'</button>
      </nav>

      <span className="tb-sep" />

      <nav className="tb-group" aria-label="עריכה">
        <button className="act quiet" onClick={undo} disabled={!canUndo} title="בטל (⌘Z)">בטל</button>
        <button className="act quiet" onClick={redo} disabled={!canRedo} title="שחזר (⇧⌘Z)">שחזר</button>
        <button className="act quiet tb-xwide" onClick={onOpenHistory} disabled={!project} title="היסטוריית הג'נרוטים של הפרויקט — שחזור והרצה מחדש">היסטוריה</button>
        <button className="act quiet tb-xwide" onClick={closeProject} disabled={!project} title="סגור עבודה וחזור לגלריה">סגור</button>
      </nav>

      <span className="tb-spacer" />

      {/* What the machine reports: money, then which engine. */}
      <button
        className="tb-meter"
        onClick={onOpenSpend}
        title={
          `לחץ לפירוט מלא\n${monthLabel(monthKey(Date.now()))}: $${(thisMonth?.total ?? 0).toFixed(3)}` +
          `${thisMonth ? ` (${thisMonth.count} ג'נרוטים)` : ""}\n` +
          `סה״כ מצטבר: $${totalSpend.toFixed(3)} · הפעלה נוכחית: $${sessionSpend.toFixed(3)} (${genCount})`
        }
      >
        <b>${(thisMonth?.total ?? 0).toFixed(2)}</b>
        <span>החודש</span>
        {sessionSpend > 0 && <span className="tb-session">+${sessionSpend.toFixed(2)}</span>}
      </button>

      <span className="tb-sep" />

      <div className="tb-engine">
        <span className={`key-dot ${keyOk ? "ok" : "bad"}`} title={keyOk ? "מפתח מוגדר" : "חסר מפתח"} role="img" aria-label={keyOk ? "מפתח מוגדר" : "חסר מפתח"} />
        <select value={providerId} onChange={(e) => setProvider(e.target.value)} aria-label="מנוע" title="מנוע">
          {providers.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select value={modelId} onChange={(e) => setModel(e.target.value)} aria-label="מודל" title="מודל">
          {provider?.models.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      <span className="tb-sep tb-wide" />
      <button className="act quiet tb-wide" onClick={onOpenHelp} title="מקרא וקיצורי מקלדת">מקרא</button>
      <button className="act quiet tb-wide" onClick={onOpenSettings}>הגדרות</button>

      {/* Everything that does not fit a narrow window lives here, so nothing is ever
          off-screen: the bar used to be 430px wider than the window it opened in. */}
      <div className="open-wrap" ref={moreRef}>
        <button className="act quiet" onClick={() => setMoreMenu((v) => !v)} aria-haspopup="menu" aria-expanded={moreMenu} title="עוד">
          עוד <span className="caret-down"><Icon name="chevron" size={12} /></span>
        </button>
        {moreMenu && (
          <div className="open-menu tb-menu tb-menu-end" role="menu" onClick={() => setMoreMenu(false)}>
            <button role="menuitem" className="tb-xnarrow" onClick={onOpenHistory} disabled={!project}><b>היסטוריה</b></button>
            <button role="menuitem" className="tb-xnarrow" onClick={closeProject} disabled={!project}><b>סגור עבודה</b></button>
            <button role="menuitem" className="tb-narrow" onClick={onOpenHelp}><b>מקרא וקיצורים</b></button>
            <button role="menuitem" className="tb-narrow" onClick={onOpenSettings}><b>הגדרות</b></button>
            <button role="menuitem" onClick={onOpenFeedback}><b>משוב למפתח</b></button>
          </div>
        )}
      </div>
    </header>
  );
}
