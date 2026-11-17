# המכחול המכני · The Mechanical Brush

כלי עריכת תמונות **מקומי**, מבוסס **שכבות** ו-**AI** — אפסקייל, יצירה מחדש, מילוי גנרטיבי
(inpainting), שינוי פורמט והסרת רקע, עם מסכות, תמונות ייחוס, ותוצאות שמתקבלות כשכבות
מיושרות מעל המקור.

הליבה: הופך מודלים מתקדמים ליצירת תמונות ל"מכחול" מקומי, מדויק ומבוסס שכבות — בלי לקבע את האפליקציה למנוע אחד.

---

## מה יש בפנים

**מצבי עבודה** — אפסקייל · יצירה מחדש · הסרת רקע · מילוי גנרטיבי · שינוי פורמט · יצירה
מטקסט. לכל מצב בורר רזולוציה משלו (כולל "כמו המקור"), וחיווי של גודל הפלט הצפוי לפני
ההרצה.

**מנועים** — umage2 (GPT Image 2.5 Flare / Sunburst / 2 / 1) · Nano Banana 2 (fal) · Reve · Grok Imagine (xAI) ·
Crystal Upscaler (Replicate) · Ideogram 4.5 · mock לבדיקות. כל אחד מצהיר על היכולות שלו, וה-UI מציג רק
מה שנתמך.

**עוזר פרומפטים וסקילים** — שיחה מול GPT / Gemini / Grok / Claude בלשוניות מקבילות,
ו**סקילים**: תהליכי עבודה מרובי שלבים (שאלות, בחירות, תמונות ושלבי AI) שמצטרפים לפרומפט
אחד. כולל דף דמות מובנה, מתכנן שבונה סקיל מתיאור חופשי, חזרה שלב אחורה, וייצוא JSON.

**עבודה במקביל** — פרויקטים כלשוניות, פתיחת עד 10 קבצים בבת אחת (כלשוניות או כשכבות),
הרצה ושמירה של כל הלשוניות בפעולה אחת. תוצאה נוחתת בלשונית שהתחילה אותה.

**מעקב עלויות** — עלות מוערכת לכל יצירה, סיכום חודשי, ותקרת תקציב להפעלה.

ראה [CHANGELOG.md](CHANGELOG.md) לפירוט מלא לפי גרסה.

---

## הרצה מהירה

```bash
cd "the-mechanical-brush"
npm install
npm run dev      # מריץ Vite + Electron יחד
```

בהרצה הראשונה ייפתח מסך onboarding לבחירת מנוע והזנת מפתח API.
המפתח נשמר מקומית ומוצפן דרך ה-Keychain של מערכת ההפעלה (Electron safeStorage).

### בנייה והפצה

```bash
npm run build    # type-check + build (renderer + electron)
npm run dist      # אריזה ל-app מותקן (electron-builder)
```

לשחרור מלא — גרסה, אתר, קודי הפעלה ומיילים — ראה [RELEASING.md](RELEASING.md).

### בדיקות

```bash
npm test          # Vitest — providers, project IO, size mapper
```

---

## ארכיטקטורה

```
electron/                 תהליך ה-main (Node) — בטוח, מחזיק מפתחות וקורא ל-APIs
  main.ts                 חלון, טעינה
  preload.ts              גשר IPC מוקשח (contextBridge) — המשטח היחיד ל-renderer
  ipc/handlers.ts         מימוש ערוצי ה-IPC
  security/KeyManager.ts  אחסון מפתחות מוצפן (safeStorage + OS keychain)
  project/                ProjectSerializer — פורמט ‎.mbrush
  providers/              שכבת ההפשטה של המנועים
    ImageProvider.ts      הממשק הגנרי שכל האפליקציה מדברת מולו
    registry.ts           רישום ושיגור לפי מצב
    umage2/               מנוע ברירת המחדל (GPT image) — כל הלוגיקה הספציפית כאן
    mock/                 מנוע offline דטרמיניסטי לבדיקות
  agent/EngineScout.ts    ארכיטקטורת הסוכן החכם (גילוי/השוואה/תכנון מעבר)
shared/                   קוד טהור המשותף לשני התהליכים (ללא תלות ב-Node/DOM)
  types.ts, ipc.ts        טיפוסים וערוצי IPC
  gptImageSize.ts         מגבלות הגודל של GPT Image 2.5 / 2 — מקור אחד למנוע ולממשק
  capabilities.ts         מי יכול להסיר רקע, לפי המנוע והמודל שנבחר
  errors.ts               פירוק שרשרת ה-cause לשגיאה שאפשר לפעול לפיה
  pathGuard.ts            מה ה-renderer רשאי לבקש מהדיסק
src/                      ה-renderer (React + TypeScript)
  state/store.ts          ניהול מצב (zustand): פרויקט, שכבות, מסכה, יצירה
  state/docs.ts           לשונית = פרוסה של הסטור; מה מותר להריץ בכל אחת
  compositing.ts          שיטוח שכבות, רסטריזציית מסכה, תמונות ממוזערות
  batchRun.ts             הרצת פעולה על הרבה קבצים, בלי לגעת בפרויקט הפתוח
  help/legend.json        המקרא הדו-לשוני — משמש גם את האפליקציה וגם את האתר
  canvas/CanvasStage.tsx  קנבס Konva: זום/הזזה, רינדור שכבות, מברשת מסכה
  ui/                     Toolbar, LayersPanel, PromptBar, ChatDock, ProjectTabs
website/                  אתר השיווק (index.html) + עמוד המקרא הנוצר אוטומטית
scripts/gen-legend.mjs    מייצר website/legend.html מתוך src/help/legend.json
tests/                    Vitest
```

### עקרונות יסוד שנאכפים בקוד
- **מקומי תחילה**, **מבוסס שכבות**, **לא הרסני**: כל תוצאת AI נכנסת כשכבה חדשה מיושרת ל-(0,0) בגודל הקנבס. המקור לא נדרס.
- **הפשטת ספקים**: ה-UI מדבר רק מול `ImageProvider`. לוגיקה ספציפית-למנוע חיה רק בתוך ה-adapter.
- **מסכות גנריות**: ה-renderer מייצר מסכה בקונבנציה אחת (לבן = לחולל מחדש). כל adapter מתרגם לקונבנציה שלו (למשל umage2 ממיר ל-alpha=0 באזור העריכה).
- **מפתחות מאובטחים**: לעולם לא ב-hardcode, לא בלוגים, לא בקבצי פרויקט, לא ב-export.

---

## הוספת מנוע חדש (provider)

1. צור תיקייה `electron/providers/<id>/` ובה מחלקה שמיישמת את `ImageProvider`
   (ראה `umage2/Umage2Provider.ts` ו-`mock/MockImageProvider.ts` כדוגמה).
2. מפה את המצבים: `upscaleImage`, `recreateImage` (משמש גם להסרת רקע), `editImageWithMask`,
   `expandImage` (הרחבה ושינוי פורמט), `generateImage`.
3. אם המנוע משתמש בקונבנציית מסכה אחרת — המר בתוך ה-adapter (כמו `convertMaskToOpenAI`).
4. הצהר יכולות אמיתיות ב-`getCapabilities()` — אל תניח שכל מנוע תומך בהכול.
5. רשום ב-`electron/providers/registry.ts`: `this.register(new MyProvider())`.

זהו. הקנבס, השכבות, פורמט הפרויקט וה-UI לא משתנים.

---

## הסוכן החכם (Engine Scout)

מוגדר ב-`electron/agent/EngineScout.ts`. תפקידו: לגלות מנועים חדשים, להשוות יכולות,
לתת ציון תאימות, ולהפיק תוכנית מעבר + שלד adapter. **לעולם אינו מחליף מנוע או משנה קוד
ייצור ללא אישור אנושי מפורש.** המימוש ב-MVP סטטי/offline; גילוי מקוון מתחבר מאחורי
אותם הממשקים בגרסאות הבאות.

---

## פורמט ‎.mbrush
מסמך JSON יחיד (MVP) עם נכסים מוטמעים כ-data URLs: קנבס, שכבות, מסכות, ייחוסים,
היסטוריית פרומפטים, ומטא-דאטה של יצירה. גרסאות עתידיות יעברו לחבילת zip עם תיקיות נכסים.

## מצב נוכחי
גרסת אלפא 0.3.0 — ראה [CHANGELOG.md](CHANGELOG.md). האפליקציה בשימוש יומיומי; הממשק
בעברית, הערות הקוד באנגלית, וכל שינוי מלווה בבדיקות (`npm test`).
