import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { monthKey, monthLabel } from "../spend";

export function Gallery() {
  const recents = useStore((s) => s.recents);
  const newFromScratch = useStore((s) => s.newFromScratch);
  const openImageOrProject = useStore((s) => s.openImageOrProject);
  const openRecent = useStore((s) => s.openRecent);
  const removeRecent = useStore((s) => s.removeRecent);
  const months = useStore((s) => s.spendMonths);
  const totalSpend = useStore((s) => s.totalSpend);
  const thisMonth = monthKey(Date.now());
  const mine = months[thisMonth];

  // The list is the full history now, so it is rendered a page at a time: hundreds of
  // thumbnail data URLs decoded at once is a visibly slow start screen.
  const PAGE = 24;
  const [shown, setShown] = useState(PAGE);
  const [query, setQuery] = useState("");
  const sentinel = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  }, [recents, query]);

  useEffect(() => setShown(PAGE), [query]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= filtered.length) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(n + PAGE, filtered.length));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, filtered.length]);

  const page = filtered.slice(0, shown);

  return (
    <div className="gallery">
      <div className="gallery-inner">
        <div className="gallery-head">
          <div className="gallery-title">
            <span className="brand-he big">המכחול המכני</span>
            <span className="brand-en">ברוך שובך — במה נעבוד היום?</span>
          </div>
          <div className="gallery-cta">
            <button className="primary" onClick={newFromScratch}>צור עם AI</button>
            <button onClick={() => openImageOrProject()}>פתח תמונה / פרויקט</button>
          </div>
        </div>

        {(mine || totalSpend > 0) && (
          <div className="gallery-spend" title="אומדן לפי המודלים שנבחרו — לחיוב המדויק היכנס לחשבון הספק">
            <b>{monthLabel(thisMonth)}:</b> <span className="gallery-money" dir="ltr">${(mine?.total ?? 0).toFixed(2)}</span>
            {mine ? ` · ${mine.count} ג'נרוטים` : ""}
            <span className="gallery-spend-total">סה״כ מצטבר <span className="gallery-money" dir="ltr">${totalSpend.toFixed(2)}</span></span>
          </div>
        )}

        <div className="gallery-section-row">
          <span className="gallery-section-title">
            כל העבודות
            {recents.length > 0 && <span className="gallery-count"> · {recents.length}</span>}
          </span>
          {recents.length > PAGE && (
            <input
              className="gallery-search"
              type="search"
              placeholder="חיפוש לפי שם…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
        </div>

        {recents.length === 0 ? (
          <div className="gallery-empty">
            אין עדיין עבודות. פתח תמונה והתחל ליצור — תמונות שפתחת או ייצאת ופרויקטים ששמרת יופיעו כאן.
          </div>
        ) : (
          <div className="gallery-grid">
            {page.map((r) => (
              <div key={r.path} className="gallery-card" onClick={() => openRecent(r)} title={r.path}>
                <div className="gallery-thumb">
                  {r.thumbnail ? <img src={r.thumbnail} alt="" /> : <div className="thumb-fallback" />}
                </div>
                <div className="gallery-meta">
                  <div className="gallery-name">
                    <span className="gallery-kind">{r.kind === "image" ? "תמונה" : "פרויקט"}</span>
                    {r.name}
                  </div>
                  <div className="gallery-date" dir="ltr">{new Date(r.updatedAt).toLocaleString("he-IL")}</div>
                </div>
                <button
                  className="gallery-remove"
                  title="הסר מהרשימה"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecent(r.path);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {shown < filtered.length && (
          <div ref={sentinel} className="gallery-more">
            נטענות עוד עבודות… ({shown} מתוך {filtered.length})
          </div>
        )}
        {!!query && filtered.length === 0 && (
          <div className="gallery-empty">אין עבודה בשם הזה.</div>
        )}
      </div>
    </div>
  );
}
