// Screenshots of the main screens, for before/after review of visual work.
//
//   node tests/e2e/shots.mjs <out-dir> [width height] [only]
//
// [only] is an optional pattern: only shots whose names match it are written (the setup
// still runs in full), so a task can photograph just its own screens.
//
// Same throwaway profile and stubbed engine as the golden scenarios: nothing is sent,
// nothing is billed, nothing is written outside the run's temp folder and <out-dir>.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ROOT, startRenderer, freshProfile, launch } from "./harness.mjs";

const OUT = path.resolve(process.argv[2] ?? "shots");
const W = Number(process.argv[3] || 1440);
const H = Number(process.argv[4] || 900);
const ONLY = process.argv[5] ? new RegExp(process.argv[5]) : null;
mkdirSync(OUT, { recursive: true });

const { server, url } = await startRenderer();
const profile = freshProfile();
const { app, page } = await launch(url, profile);
const win = await app.browserWindow(page);
await win.evaluate((w, [W, H]) => w.setSize(W, H), [W, H]);
const shot = async (name) => {
  if (ONLY && !ONLY.test(name)) return;
  await page.waitForTimeout(500);
  const b64 = await win.evaluate(async (w) => (await w.webContents.capturePage()).toJPEG(88).toString("base64"));
  writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(b64, "base64"));
};
const dataUrl = (f) => "data:image/jpeg;base64," + readFileSync(path.join(ROOT, f)).toString("base64");
const click = (text) => page.evaluate((t) => { const b = [...document.querySelectorAll("button")].find((e) => e.textContent.trim().includes(t)); b?.click(); return !!b; }, text);
const closeModal = async () => { await page.keyboard.press("Escape"); await page.evaluate(() => { [...document.querySelectorAll(".modal button, .modal-footer button")].reverse().find((e) => /סגור|ביטול/.test(e.textContent))?.click(); }); await page.waitForTimeout(150); };

await shot("01-gallery");
// The gallery with saved work in it, then the licence gate and the first-key dialog —
// all state only, put back before the workspace is built.
await page.evaluate(([thumbs]) => {
  const S = window.__S, keep = { recents: S.getState().recents, spendMonths: S.getState().spendMonths, totalSpend: S.getState().totalSpend };
  window.__keep = keep;
  const now = Date.now(), d = new Date(), k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const names = ["דיוקן סטודיו", "רחוב בגשם", "נעל על אספלט", "חלון בוקר", "שלט במדבר", "מטבח לבן"];
  S.setState({
    recents: names.map((n, i) => ({ path: `/tmp/shots/${n}.mbrush`, name: n, updatedAt: new Date(now - i * 26e5 * 3).toISOString(), thumbnail: thumbs[i % thumbs.length] })),
    spendMonths: { [k]: { total: 0.42, count: 3 } }, totalSpend: 0.632,
  });
}, [[dataUrl("website/assets/work-3.jpg"), dataUrl("website/assets/work-7.jpg")]]);
await shot("01b-gallery-recents");
await page.evaluate(() => window.__S.setState({ licensed: false }));
await shot("14-license");
await page.evaluate(() => window.__S.setState({ licensed: true, onboarding: true }));
await shot("15-first-key");
await page.evaluate(() => window.__S.setState({ onboarding: false, ...window.__keep }));
await page.evaluate(async ([a, b]) => {
  const S = window.__S;
  await S.getState().newProjectFromImage("דיוקן סטודיו.jpg", a);
  const p = S.getState().project;
  S.getState().setMode("fill");
  S.getState().setPrompt("חלון עגול עם אור בוקר רך, אבק באוויר");
  S.getState().addRect({ x: Math.round(p.canvas.width * 0.3), y: Math.round(p.canvas.height * 0.25), w: Math.round(p.canvas.width * 0.3), h: Math.round(p.canvas.height * 0.3) });
  await S.getState().generate();
  S.getState().addRect({ x: Math.round(p.canvas.width * 0.55), y: Math.round(p.canvas.height * 0.5), w: Math.round(p.canvas.width * 0.25), h: Math.round(p.canvas.height * 0.25) });
  await S.getState().addReference(b);
  S.getState().addAnnotation({ kind: "pin", x: p.canvas.width * 0.2, y: p.canvas.height * 0.7, n: 1, note: "להחליף לאספלט רטוב", color: "#ff3b30" });
  S.setState({ status: "", warning: null });
}, [dataUrl("website/assets/work-3.jpg"), dataUrl("website/assets/work-7.jpg")]);
await shot("02-workspace");
// Every kind of canvas mark at once: a fill rectangle, a fill brush stroke, an erase
// stroke and a pin with its note. Removed again before the next shot.
await page.evaluate(() => {
  const S = window.__S; const p = S.getState().project; const W = p.canvas.width, H = p.canvas.height;
  window.__keepMarks = { mask: S.getState().mask, removeMask: S.getState().removeMask };
  S.getState().addStroke({ tool: "brush", size: Math.round(W * 0.05), hardness: 100, points: [W * 0.08, H * 0.2, W * 0.16, H * 0.32, W * 0.22, H * 0.46] });
  S.getState().addRemoveStroke({ tool: "brush", size: Math.round(W * 0.04), hardness: 100, points: [W * 0.84, H * 0.12, W * 0.9, H * 0.3] });
});
await shot("18-marks");
await page.evaluate(() => { window.__S.setState(window.__keepMarks); });
// A status message written by the store: saving a prompt to the library (undone after).
await page.evaluate(() => window.__S.getState().togglePromptInLibrary("חלון עגול עם אור בוקר רך"));
await shot("26-status-saved");
await page.evaluate(() => { window.__S.getState().togglePromptInLibrary("חלון עגול עם אור בוקר רך"); window.__S.setState({ status: "" }); });
// The pin picker in the prompt: each pin's number, as it is on the canvas.
// (It is offered only in "recreate", where pins are sent as coordinates.)
await page.evaluate(() => window.__S.getState().setMode("recreate"));
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector(".pin-picker-btn")?.click());
await shot("24-pin-picker");
await page.keyboard.press("Escape");
await page.evaluate(() => window.__S.getState().setMode("fill"));
// The smaller dialogs. Each is opened, shot and closed again.
const clickLabel = (label) => page.evaluate((l) => { const b = [...document.querySelectorAll("button")].find((e) => e.getAttribute("aria-label") === l); b?.click(); return !!b; }, label);
await clickLabel("פרמטרי הג'נרוט (פרומפט, מודל, הגדרות)");
await shot("19-layer-params");
await closeModal();
await clickLabel("התאמת צבע ונוצה למילוי (לא הרסני)");
await shot("20-fill-color");
await clickLabel("התאמת צבע ונוצה למילוי (לא הרסני)");
await page.evaluate(() => window.__S.getState().setMode("generate"));
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector(".ms-add")?.click());
await shot("21-save-style");
await closeModal();
await page.evaluate(() => window.__S.getState().setMode("fill"));
// The piece picker for a photo that is not on disk: the frame, the presets and the
// "could not open" line. Nothing is read or written.
await page.evaluate(() => window.__S.setState({ piecePicker: { name: "חזית-בניין.tif", original: { path: "/nonexistent/חזית-בניין.tif", width: 8256, height: 5504 } } }));
await shot("22-piece-picker");
await page.evaluate(() => window.__S.setState({ piecePicker: null }));
// Write-back, for a project marked as a piece of a photo that is not on disk.
await page.evaluate(() => { const S = window.__S; window.__keepProject = S.getState().project; S.setState({ project: { ...S.getState().project, pieceSource: { original: { path: "/nonexistent/חזית-בניין.tif", width: 8256, height: 5504 }, rect: { x: 2400, y: 1200, w: 1200, h: 1438 } } } }); });
await page.waitForTimeout(150);
await page.selectOption('select[aria-label="ייצוא"]', "original").catch(() => {});
await shot("23-write-back");
await closeModal();
await page.evaluate(() => window.__S.setState({ project: window.__keepProject }));
// The dock's lower rows (options, references) sit below the fold at its default height.
await page.evaluate(() => { const b = document.querySelector(".prompt-dock-body"); if (b) b.scrollTop = b.scrollHeight; });
await shot("02b-dock-options");
await page.evaluate(() => { const b = document.querySelector(".prompt-dock-body"); if (b) b.scrollTop = 0; });
await page.evaluate(() => window.__S.getState().setMode("generate"));
await shot("03-mode-generate");
await page.evaluate(() => { window.__S.getState().setMode("expand"); window.__S.getState().updateSettings({ expandDir: "right" }); });
await shot("03b-mode-expand");
await page.evaluate(() => window.__S.getState().setMode("ratio"));
await shot("03c-mode-ratio");
await page.evaluate(() => { window.__S.getState().setMode("fill"); document.querySelector(".chat-rail")?.click(); });
await shot("04-assistant");
await page.evaluate(() => [...document.querySelectorAll(".composer-chip")].find((b) => b.title === "סקילים (/)")?.click());
await shot("04b-assistant-skills");
await page.evaluate(() => [...document.querySelectorAll(".composer-chip")].find((b) => b.title === "סקילים (/)")?.click());
// A conversation: the user's turn, an answer with a proposed prompt, and a notice.
// Written straight into the chat store — nothing is sent to a model.
await page.evaluate(async () => {
  const C = (await import("/src/state/chat.ts")).useChat;
  const sid = C.getState().activeId ?? C.getState().sessions[0].id;
  window.__keepChat = C.getState().sessions.find((x) => x.id === sid).msgs;
  C.getState().patchSession(sid, { msgs: [
    { role: "user", content: "החלון באזור המסומן נראה שטוח. איך לתת לו עומק?", ctxLabels: ["קנבס", "אזור מסומן"] },
    { role: "assistant", content: "האור הוא מה שנותן עומק כאן. כדאי לתאר מאיפה הוא נכנס ומה הוא פוגש בדרך:\n\n```prompt\nחלון עגול בקיר עבה, אור בוקר רך נכנס באלכסון מימין, אבק מרחף בקרן האור, שולי החלון בצל עמוק\n```\n\nאם האבק מוגזם, אפשר להוריד אותו בסיבוב הבא.", promptMode: "fill" },
  ] });
});
await shot("04c-assistant-chat");
await page.evaluate(async () => {
  const C = (await import("/src/state/chat.ts")).useChat;
  C.getState().patchSession(C.getState().activeId ?? C.getState().sessions[0].id, { msgs: window.__keepChat });
});
await page.evaluate(() => [...document.querySelectorAll(".chat-head button")].pop()?.click());
for (const [name, label] of [["05-settings", "הגדרות"], ["06-batch", "באטץ"], ["07-help", "מקרא"]]) {
  await click(label);
  await shot(name);
  if (name === "06-batch") { await click("פרומפטים —"); await shot("06b-batch-prompts"); await click("קבצים —"); }
  // The legend's tool and layer rows, where the drawn icons are.
  if (name === "07-help") { await page.evaluate(() => { const m = document.querySelector(".help-modal"); const t = document.querySelectorAll(".help-section")[1]; if (m && t) m.scrollTop = t.offsetTop - 16; }); await shot("07b-help-tools"); }
  await closeModal();
}
// Spend: a few months of made-up entries, so the dialog shows its rows (state only — no
// file is written).
await page.evaluate(() => {
  const now = Date.now(), day = 86400000;
  const e = [
    { ts: new Date(now - 40 * day).toISOString(), cost: 0.17, providerId: "umage2", modelId: "gpt-image-1", mode: "fill" },
    { ts: new Date(now - 33 * day).toISOString(), cost: 0.042, providerId: "nano-banana", modelId: "gemini-2.5-flash-image", mode: "generate" },
    { ts: new Date(now - 2 * day).toISOString(), cost: 0.25, providerId: "umage2", modelId: "gpt-image-1", mode: "expand" },
    { ts: new Date(now - 3600000).toISOString(), cost: 0.17, providerId: "umage2", modelId: "gpt-image-1", mode: "fill" },
  ];
  const months = {};
  for (const x of e) { const d = new Date(x.ts); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; months[k] = { total: (months[k]?.total ?? 0) + x.cost, count: (months[k]?.count ?? 0) + 1 }; }
  window.__S.setState({ spendEntries: e, spendMonths: months, totalSpend: 0.632, sessionSpend: 0.17, genCount: 1, budgetCap: 5 });
  document.querySelector(".tb-meter")?.click();
});
await shot("10-spend");
await closeModal();
await click("היסטוריה");
await shot("11-history");
await closeModal();
await page.evaluate(() => { [...document.querySelectorAll(".tb button")].find((b) => b.title === "עוד")?.click(); });
await click("משוב למפתח");
await shot("12-feedback");
await closeModal();
await page.evaluate(() => window.__S.setState({ largeImageAsk: { name: "חזית-בניין.tif", width: 8256, height: 5504 } }));
await shot("13-large-image");
await closeModal();
await page.evaluate(() => window.__S.setState({ busy: true, status: "מריץ מילוי גנרטיבי…", genStartedAt: Date.now() - 14000 }));
await shot("08-busy");
await page.evaluate(() => window.__S.setState({ busy: false, genStartedAt: null, status: "נוצרה שכבה חדשה · 1024×768px · עלות מוערכת $0.170", error: "נגמרו הקרדיטים בחשבון OpenAI — טען קרדיט ונסה שוב.", warning: "יישור לא ודאי — הפאץ' הונח ללא יישור" }));
await shot("09-messages");
await page.evaluate(() => { window.__S.setState({ status: "", error: null, warning: null }); window.__S.getState().setTool("remove"); });
await shot("16-erase");
await page.evaluate(() => { window.__S.getState().setTool("move"); window.__S.setState({ recovery: { name: "דיוקן סטודיו", savedAt: Date.now() - 600000, slots: [{ id: "a", name: "דיוקן סטודיו" }] } }); });
await shot("17-recovery");
// Project tabs that report on themselves: one whose result arrived while you were
// elsewhere, one whose run failed. Two empty tabs, marked by hand, closed again after.
await page.evaluate(() => {
  const S = window.__S; S.setState({ recovery: null }); const first = S.getState().activeDocId;
  S.getState().newDocTab(); S.getState().newDocTab();
  S.getState().switchDoc(first);
  const others = S.getState().docs.filter((d) => d.id !== first);
  window.__extraDocs = others.map((d) => d.id);
  S.setState({ docs: S.getState().docs.map((d) => d.id === others[0].id ? { ...d, slice: { ...d.slice, unseen: true } } : d.id === others[1].id ? { ...d, slice: { ...d.slice, error: "נגמרו הקרדיטים בחשבון OpenAI" } } : d) });
});
await shot("27-tab-marks");
await page.evaluate(() => { for (const id of window.__extraDocs) window.__S.getState().closeDoc(id); });
await app.close();
await server.close();
rmSync(profile.root, { recursive: true, force: true });
console.log(`shots in ${OUT}`);
