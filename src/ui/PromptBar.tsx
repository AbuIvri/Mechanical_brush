import { Icon } from "./Icon";
import { useLayoutEffect, useRef, useState } from "react";
import { useStore, modeLabel, canRemoveBackground, REVE_UPSCALE_MAX_EDGE, estimateGenMs, formatDuration } from "../state/store";
import { useFileDrop } from "./useFileDrop";
import type { GenerationMode, ReferenceRole } from "../../shared/types";
import { DOCK_MODES } from "../../shared/modes";
import { boxToAspect, fitFlexibleSize } from "../../shared/gptImageSize";
import { fillBoxFor, fillLongEdgeFor, scaleBox, workingSize } from "../fillRegion";
import { maskBoundsQuick } from "../compositing";
import { markDensity, useLayerNaturalWidths } from "../canvas/layerDensity";
import { fitIdeogramSize, upscaleFactor } from "../../shared/ideogramSize";
import { MEDIUMS, mediumLabel } from "./mediums";
import { pinsOf, PIN_TAG, type Pin } from "../pins";
import { REF_ROLES, normalizeRole, roleSpec } from "../../shared/referenceGuide";
import { docTitle } from "../state/docs";
import { useDismiss } from "./useDismiss";
import { Notices } from "./Notices";

// "expand" (הרחבה) is hidden from the UI for now — too fiddly to be useful. The code
// (runExpand, buildExpandSide, provider expandImage) is kept for a future return.
// One list, shared with the assistant's "write a prompt for…" menu.
const MODES = DOCK_MODES;

const PRESETS = [
  "הסר אובייקט ושחזר את הרקע",
  "שפר טקסטורת מוצר",
  "שפר ריאליזם של מזון",
  "תקן עור בצורה טבעית",
  "החלף רקע",
  "צור מחדש בריאליזם גבוה יותר",
  "שמור על גאומטריה, שפר פרטים",
  "תקן ארטיפקטים מקומיים",
  "הרחב אזור חסר",
  "ריטוש מסחרי נקי",
];


export function PromptBar() {
  const mode = useStore((s) => s.mode);
  const genTimings = useStore((s) => s.genTimings);
  const setMode = useStore((s) => s.setMode);
  const prompt = useStore((s) => s.prompt);
  const setPrompt = useStore((s) => s.setPrompt);
  const references = useStore((s) => s.references);
  const addReference = useStore((s) => s.addReference);
  const removeReference = useStore((s) => s.removeReference);
  const setReferenceRole = useStore((s) => s.setReferenceRole);
  const setReferenceNote = useStore((s) => s.setReferenceNote);
  const addReferenceFromDoc = useStore((s) => s.addReferenceFromDoc);
  const refreshReference = useStore((s) => s.refreshReference);
  const docs = useStore((s) => s.docs);
  const activeDocId = useStore((s) => s.activeDocId);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const generate = useStore((s) => s.generate);
  const busy = useStore((s) => s.busy);
  const project = useStore((s) => s.project);
  const mask = useStore((s) => s.mask);
  const layerWidths = useLayerNaturalWidths(project?.layers);
  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.providerId);
  const promptHistory = useStore((s) => s.promptHistory);
  const promptLibrary = useStore((s) => s.promptLibrary);
  const togglePromptInLibrary = useStore((s) => s.togglePromptInLibrary);
  const recentMediums = useStore((s) => s.recentMediums);
  const savedStyles = useStore((s) => s.savedStyles);
  const applyMedium = useStore((s) => s.applyMedium);
  const applyStyle = useStore((s) => s.applyStyle);
  const addSavedStyle = useStore((s) => s.addSavedStyle);
  const [styleModal, setStyleModal] = useState<null | { title: string; text: string }>(null);

  // ---- Pin tags (recreate only) ------------------------------------------------
  // Pins are offered in the one mode that sends them as coordinates; anywhere else a tag
  // would be refused at run time, so the picker simply isn't there.
  const pins = pinsOf(project?.annotations?.items);
  const pinsHere = mode === "recreate" && pins.length > 0;
  const promptRef = useRef<HTMLTextAreaElement>(null);
  /** Open picker: where it floats (fixed, so the prompt box's overflow can't clip it) and,
   *  when opened by typing "@", the index of that "@" so picking replaces it. */
  const [pinPick, setPinPick] = useState<null | { left: number; bottom: number; at: number | null }>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  useDismiss(pickerRef, () => setPinPick(null), !!pinPick);
  const openPinPicker = (at: number | null) => {
    const r = promptRef.current?.getBoundingClientRect();
    if (!r) return;
    setPinPick({ left: r.left, bottom: window.innerHeight - r.top + 4, at });
  };
  /** Where the caret goes once the inserted tag is on screen. Applied in a layout effect —
   *  synchronously after the new value reaches the DOM — because an rAF left a window in
   *  which the next keystrokes landed at the old caret: typing right after picking a pin
   *  scattered the text around the tag. */
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = promptRef.current;
    const c = pendingCaret.current;
    if (!el || c == null) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(c, c);
  }, [prompt]);
  const insertPin = (pin: Pin) => {
    const el = promptRef.current;
    // The "@" that opened the list is replaced only if it is still there: after more
    // typing, that index belongs to some other character.
    const at = pinPick?.at != null && prompt[pinPick.at] === "@" ? pinPick.at : null;
    setPinPick(null);
    const tag = `${PIN_TAG}${pin.n} ${pin.note.trim() ? `${pin.note.trim()} ` : ""}`;
    const start = at ?? el?.selectionStart ?? prompt.length;
    const end = at != null ? at + 1 : el?.selectionEnd ?? start;
    // Its own line when there is text before it: one pin, one instruction reads cleanly
    // to the engine and to the user.
    const before = prompt.slice(0, start);
    const lead = before && !/\s$/.test(before) ? "\n" : "";
    const next = before + lead + tag + prompt.slice(end);
    pendingCaret.current = (before + lead + tag).length;
    setPrompt(next);
  };
  const modelId = useStore((s) => s.modelId);
  const savedActions = useStore((s) => s.savedActions);
  const saveAction = useStore((s) => s.saveAction);
  const applyAction = useStore((s) => s.applyAction);
  const removeSavedAction = useStore((s) => s.removeSavedAction);
  const [actionModal, setActionModal] = useState<null | { name: string }>(null);

  const activeLayer = useStore((s) => s.project?.layers.find((l) => l.id === s.activeLayerId) || null);
  const saveProject = useStore((s) => s.saveProject);
  const dirty = useStore((s) => s.dirty);
  const configuredKeys = useStore((s) => s.configuredKeys);
  const [regenStep, setRegenStep] = useState<null | "choose" | "newproj" | "reveUpscale">(null);
  const setProvider = useStore((s) => s.setProvider);
  const [switchNotice, setSwitchNotice] = useState<null | "upscale" | "mask" | "genonly">(null);

  const fileRef = useRef<HTMLInputElement>(null);
  const provider = providers.find((p) => p.id === providerId);

  // An "upscale-only" engine (e.g. Crystal) can't recreate/fill/generate. If the
  // user picks such a mode, auto-redirect to Nano Banana 2 and notify (dismissible).
  const upscaleOnly =
    !!provider?.capabilities.supportsUpscale &&
    !provider?.capabilities.supportsRecreate &&
    !provider?.capabilities.supportsInpainting;
  // A "generate-only" engine (e.g. Grok) can't touch existing images at all.
  const generateOnly =
    !!provider &&
    !provider.capabilities.supportsUpscale &&
    !provider.capabilities.supportsRecreate &&
    !provider.capabilities.supportsInpainting;
  const pickMode = (m: GenerationMode) => {
    // Expand works on ANY image model now (it fills a white area + uses a reference),
    // so no engine switch is needed here.
    if (m !== "upscale" && upscaleOnly) {
      setProvider("nano-banana");
      setMode(m);
      if (localStorage.getItem("mbrush.hideUpscaleOnlySwitch") !== "1") setSwitchNotice("upscale");
      return;
    }
    if (m !== "generate" && generateOnly) {
      setProvider("nano-banana");
      setMode(m);
      if (localStorage.getItem("mbrush.hideGenOnlySwitch") !== "1") setSwitchNotice("genonly");
      return;
    }
    setMode(m);
  };

  // Reve can't truly upscale a large image (it downsamples to ~1MP first). Since
  // people pick Reve for budget reasons, ASK before silently switching engines.
  const longEdge = project ? Math.max(project.canvas.width, project.canvas.height) : 0;
  const bigReveUpscale = mode === "upscale" && providerId === "reve" && longEdge > REVE_UPSCALE_MAX_EDGE;
  const umageConfigured = configuredKeys.includes("umage2");

  // What will actually come out, before any money is spent. Every engine and every mode
  // whose output size is computable — a resolution control the user can't check is just
  // decoration, and gpt-image-2 really does clamp a 1:1 "4K" down to 2880×2880.
  // Fill: the size the marked area will be generated at — the same steps the run takes
  // (crop box → density of the layers under it → long edge → engine limits), so the
  // number here is the number that gets sent.
  const fillOut = (() => {
    if (!project || mode !== "fill") return null;
    const W = project.canvas.width;
    const H = project.canvas.height;
    const tight = maskBoundsQuick(mask, W, H);
    if (!tight) return null;
    const rectOnly = mask.rects.length > 0 && !mask.strokes.length && !mask.bitmaps.length;
    const box = fillBoxFor(tight, W, H, rectOnly);
    const region = scaleBox(box, markDensity(project.layers, layerWidths, box));
    const ws = workingSize(region.w, region.h, fillLongEdgeFor(region.w, region.h, settings.fillLongEdge));
    return { ow: ws.w, oh: ws.h, rw: region.w, rh: region.h, auto: !(Number(settings.fillLongEdge) > 0) };
  })();

  const outRes = (() => {
    // Ratio has its own predicted-frame row below, driven by the target aspect.
    if (!project || mode === "fill" || mode === "generate" || mode === "ratio") return null;
    const w = project.canvas.width;
    const h = project.canvas.height;
    const aspect = w / h;
    const srcLong = Math.max(w, h);
    const factorOf = (ow: number, oh: number) => (Math.max(ow, oh) / srcLong).toFixed(1);

    const longEdge =
      mode === "upscale"
        ? Number(settings.upscaleLongEdge) || 3840
        : Number(settings.recreateLongEdge) || srcLong;

    if (providerId === "umage2") {
      const ar = String(settings.aspectRatio ?? "auto");
      let a = aspect;
      if (ar !== "auto") {
        const [w0, h0] = ar.split(":").map(Number);
        if (w0 > 0 && h0 > 0) a = w0 / h0;
      }
      const box = boxToAspect(a, longEdge);
      const fit = fitFlexibleSize(box.w, box.h);
      return { ow: fit.w, oh: fit.h, factor: factorOf(fit.w, fit.h) };
    }
    if (providerId === "ideogram") {
      if (mode === "removebg") return { ow: w, oh: h, factor: "1.0" }; // a cut-out, same size
      if (mode === "upscale") {
        try {
          const f = upscaleFactor(srcLong, Number(settings.ideogramUpscale ?? 2));
          return { ow: w * f, oh: h * f, factor: String(f) };
        } catch {
          return null;
        }
      }
      const ar = String(settings.aspectRatio ?? "auto");
      let a = aspect;
      if (ar !== "auto") {
        const [w0, h0] = ar.split(":").map(Number);
        if (w0 > 0 && h0 > 0) a = w0 / h0;
      }
      const box = boxToAspect(a, longEdge);
      const fit = fitIdeogramSize(box.w, box.h);
      return { ow: fit.w, oh: fit.h, factor: factorOf(fit.w, fit.h) };
    }
    if (providerId === "crystal" && mode === "upscale") {
      const f = Number(settings.crystalScale ?? 2);
      return { ow: w * f, oh: h * f, factor: String(f) };
    }
    if (providerId === "magnific" && mode === "upscale") {
      const f = Number(String(settings.magnificScale ?? "2x").replace("x", "")) || 2;
      return { ow: w * f, oh: h * f, factor: String(f) };
    }
    if (providerId === "reve") {
      const f = Number(settings.reveUpscale ?? 1) || 1;
      // Reve works from a ~1MP base internally, then upscales by the factor.
      const base = Math.sqrt(1_000_000 * aspect);
      const ow = Math.round(base * f);
      const oh = Math.round((base / aspect) * f);
      return { ow, oh, factor: factorOf(ow, oh) };
    }
    if (providerId === "nano-banana" || providerId === "grok") {
      const tier =
        providerId === "grok"
          ? String(settings.grokResolution ?? "2k")
          : String(
              mode === "upscale"
                ? settings.nanoUpscaleResolution ?? "4K"
                : settings.nanoRecreateResolution ?? "2K",
            );
      const long = { "0.5k": 640, "1k": 1280, "2k": 2560, "4k": 3840 }[tier.toLowerCase()] ?? 2560;
      const box = boxToAspect(aspect, long);
      const ow = Math.round(box.w);
      const oh = Math.round(box.h);
      return { ow, oh, factor: factorOf(ow, oh) };
    }
    return null;
  })();

  // A "regenerate" is when the active layer was itself made by AI — ask where the result should go.
  const isRegen =
    !!project && mode !== "fill" && mode !== "expand" && mode !== "ratio" && !!activeLayer?.metadata?.providerId;
  const onGenerate = () => {
    if (bigReveUpscale) setRegenStep("reveUpscale");
    else if (isRegen) setRegenStep("choose");
    else generate();
  };
  const newLayerHere = () => { setRegenStep(null); generate(); };
  const newProject = () => { setRegenStep(null); generate({ asNewProject: true }); };
  const saveThenNewProject = async () => { setRegenStep(null); await saveProject(false); generate({ asNewProject: true }); };
  const onNewProjectChoice = () => (dirty ? setRegenStep("newproj") : newProject());
  const switchToUmage = () => { setRegenStep(null); generate({ overrideProviderId: "umage2" }); };
  const continueReve = () => { setRegenStep(null); generate(); };
  const caps = provider?.capabilities;
  // Background removal needs alpha from the engine AND from the model chosen right now.
  const canRemoveBg = canRemoveBackground(provider, modelId);
  const engineOptions = (provider?.options ?? []).filter((o) => !o.modes || o.modes.includes(mode));

  const onPickReferences = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((f) => {
      const reader = new FileReader();
      reader.onload = () => void addReference(String(reader.result));
      reader.readAsDataURL(f);
    });
  };

  // The dock has always said "גרור או הוסף". Now it means it.
  const refsDrop = useFileDrop({
    onFiles: (files) => files.forEach((f) => void addReference(f.dataUrl)),
    disabled: !caps?.supportsReferenceImages,
  });

  // The ＋ on the references dock: a file, or the canvas of another open tab. The other
  // tabs are read from their parked slices; the visible tab is left out, since a picture
  // is not a reference for itself.
  const otherTabs = docs
    .map((d, i) => ({ id: d.id, title: docTitle(d.slice, i), has: !!d.slice.project }))
    .filter((d) => d.id !== activeDocId && d.has);
  const addRefBtn = useRef<HTMLButtonElement>(null);
  const addRefMenu = useRef<HTMLDivElement>(null);
  // Fixed-positioned, like the pin list: the prompt box clips anything that overflows it.
  const [refMenu, setRefMenu] = useState<null | { right: number; bottom: number }>(null);
  useDismiss(addRefMenu, () => setRefMenu(null), !!refMenu);
  const onAddRef = () => {
    // With nothing else open there is only one place a reference can come from.
    if (!otherTabs.length) return fileRef.current?.click();
    const r = addRefBtn.current?.getBoundingClientRect();
    if (r) setRefMenu({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 4 });
  };

  return (
    <div className="promptbar">
      <div className="prompt-modes">
        {MODES.map((m) => (
          <button
            key={m}
            className={`mode ${mode === m ? "active ink ink--dry ink--under" : ""} ${m === "removebg" && !canRemoveBg ? "unsupported" : ""}`}
            onClick={() => pickMode(m)}
            title={
              m === "removebg"
                ? canRemoveBg
                  ? "מסיר את הרקע ומשאיר שכבה שקופה. שים לב: המנוע מצייר את הנושא מחדש ולא גוזר אותו — פרטים דקים עשויים להשתנות."
                  : `${provider?.name ?? "המנוע"} לא מחזיר רקע שקוף במודל הנבחר — בחר umage2 עם GPT Image 2.5 או 2`
                : undefined
            }
          >
            {modeLabel(m)}
          </button>
        ))}
      </div>

      {/* Fill edge controls — a dedicated, always-visible strip (never clipped by
          the crowded controls row below) so the patch feather/blend is reachable. */}
      {mode === "fill" && (
        <div className="fill-edge-row">
          <label title="נוצת הקצוות של המילוי — כמה רך הפאץ' מתמזג עם הסביבה (% מהצלע הקצרה)">
            <span>נוצת שוליים</span>
            <input
              type="range"
              min={0}
              max={25}
              value={settings.fillFeatherPct ?? 3}
              onChange={(e) => updateSettings({ fillFeatherPct: Number(e.target.value) })}
            />
            <b>{settings.fillFeatherPct ?? 3}%</b>
          </label>
          <label title="רמת שילוב — שקיפות שכבת המילוי מעל השכבה התחתונה">
            <span>שילוב</span>
            <input
              type="range"
              min={0}
              max={100}
              value={settings.fillBlend ?? 100}
              onChange={(e) => updateSettings({ fillBlend: Number(e.target.value) })}
            />
            <b>{settings.fillBlend ?? 100}%</b>
          </label>
          <span className="fill-edge-hint">אפשר לכוונן גם אחרי ההרצה, בהתאמת הצבע של השכבה</span>
        </div>
      )}

      {/* Directional expand: ONE direction at a time (← → ↑ ↓). The original layer
          stays as the axis; the chosen side becomes its own tunable patch layer. */}
      {mode === "expand" && (() => {
        const dir = (settings.expandDir as string) ?? "right";
        const amount = Number(settings.expandAmount ?? 50);
        const DIRS: { id: string; label: string; arrow: string }[] = [
          { id: "left", label: "שמאלה", arrow: "←" },
          { id: "right", label: "ימינה", arrow: "→" },
          { id: "up", label: "למעלה", arrow: "↑" },
          { id: "down", label: "למטה", arrow: "↓" },
        ];
        const grows = (s: string) => dir === s;
        const W = project?.canvas.width ?? 0;
        const H = project?.canvas.height ?? 0;
        // Predicted output dims from the current single-side dir+amount.
        const mX = Math.round(W * (amount / 100));
        const mY = Math.round(H * (amount / 100));
        const ow = W + (grows("left") || grows("right") ? mX : 0);
        const oh = H + (grows("up") || grows("down") ? mY : 0);
        return (
          <div className="expand-row">
            <div className="expand-mini" title="תצוגת כיוון ההרחבה">
              <span className={`em em-l ${grows("left") ? "on" : ""}`} />
              <span className={`em em-r ${grows("right") ? "on" : ""}`} />
              <span className={`em em-t ${grows("up") ? "on" : ""}`} />
              <span className={`em em-b ${grows("down") ? "on" : ""}`} />
              <span className="em-core" />
            </div>
            <div className="expand-dirs">
              {DIRS.map((d) => (
                <button
                  key={d.id}
                  className={`exp-dir ${dir === d.id ? "on" : ""}`}
                  title={d.label}
                  onClick={() => updateSettings({ expandDir: d.id as never })}
                >
                  {d.arrow}
                </button>
              ))}
            </div>
            <label title="כמות ההרחבה — % מהמקור לכיוון הנבחר">
              <span>כמות</span>
              <input
                type="range"
                min={10}
                max={100}
                value={amount}
                onChange={(e) => updateSettings({ expandAmount: Number(e.target.value) })}
              />
              <b>{amount}%</b>
            </label>
            <label title="נוצת התפר — חפיפה רכה בין הטלאי למקור">
              <span>נוצה</span>
              <input
                type="range"
                min={0}
                max={25}
                value={settings.fillFeatherPct ?? 6}
                onChange={(e) => updateSettings({ fillFeatherPct: Number(e.target.value) })}
              />
              <b>{settings.fillFeatherPct ?? 6}%</b>
            </label>
            {ow > 0 && (ow !== W || oh !== H) && (
              <span className="res-legend" title="גודל הפריים אחרי ההרחבה">פריים ≈ {ow.toLocaleString()}×{oh.toLocaleString()}px</span>
            )}
            <span className="fill-edge-hint">שכבת טלאי נפרדת (נגררת) לכיוון אחד</span>
          </div>
        );
      })()}

      {/* Format / aspect change: pick a target ratio → grow the frame to it
          (always generative, never crop) → ONE whole layer on top. */}
      {mode === "ratio" && (() => {
        const W = project?.canvas.width ?? 0;
        const H = project?.canvas.height ?? 0;
        const target = String(settings.ratioTarget ?? "16:9");
        const RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
        // Predicted new frame: grow only the deficient axis to reach the ratio.
        let ow = W, oh = H;
        if (W && H) {
          const [aw, ah] = target.split(":").map(Number);
          const t = aw / ah;
          const c = W / H;
          if (t > c) ow = Math.round(H * t);
          else if (t < c) oh = Math.round(W / t);
          const cap = Number(settings.ratioLongEdge) || 4096;
          if (Math.max(ow, oh) > cap) {
            const k = cap / Math.max(ow, oh);
            ow = Math.round(ow * k);
            oh = Math.round(oh * k);
          }
        }
        return (
          <div className="expand-row">
            <div className="ratio-chips" title="יחס יעד — מגדיל את הפריים גנרטיבית כדי להגיע אליו (בלי חיתוך)">
              <span className="ratio-lbl">יחס יעד</span>
              {RATIOS.map((r) => (
                <button
                  key={r}
                  className={`ratio-chip ${target === r ? "on" : ""}`}
                  onClick={() => updateSettings({ ratioTarget: r })}
                  dir="ltr"
                >
                  {r}
                </button>
              ))}
            </div>
            {ow > 0 && (ow !== W || oh !== H) && (
              <span className="res-legend" title="גודל הפריים אחרי שינוי הפורמט">פריים ≈ {ow.toLocaleString()}×{oh.toLocaleString()}px</span>
            )}
            <span className="fill-edge-hint">שכבה שלמה אחת מעל — המרכז המקורי נשמר · פרומפט אופציונלי</span>
          </div>
        );
      })()}

      {/* Medium + style pickers (generate / recreate): medium prepended to the prompt,
          style appended as "in the style of …". Recently used pinned to the top. */}
      {(mode === "generate" || mode === "recreate") && (
        <div className="ms-row">
          <label className="ms-field" title="מדיום — נוסף לתחילת הפרומפט">
            <span>מדיום</span>
            <select value={settings.medium ?? ""} onChange={(e) => applyMedium(e.target.value)}>
              <option value="">ללא</option>
              {recentMediums.length > 0 && (
                <optgroup label="אחרונים">
                  {recentMediums.map((en) => (
                    <option key={"r-" + en} value={en}>{mediumLabel(en)}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label="מדיומים">
                {MEDIUMS.map((m) => (
                  <option key={m.en} value={m.en}>{m.he}</option>
                ))}
              </optgroup>
            </select>
          </label>

          <label className="ms-field" title="סגנון — נוסף לסוף הפרומפט עם ‎in the style of">
            <span>סגנון</span>
            <select value={settings.styleText ?? ""} onChange={(e) => applyStyle(e.target.value)}>
              <option value="">ללא</option>
              {savedStyles.length > 0 && (
                <>
                  <optgroup label="אחרונים">
                    {[...savedStyles].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 10).map((st) => (
                      <option key={"sr-" + st.title} value={st.text}>{st.title}</option>
                    ))}
                  </optgroup>
                  <optgroup label="הסגנונות שלי">
                    {[...savedStyles].sort((a, b) => a.title.localeCompare(b.title, "he")).map((st) => (
                      <option key={"sa-" + st.title} value={st.text}>{st.title}</option>
                    ))}
                  </optgroup>
                </>
              )}
            </select>
          </label>
          <button className="ms-add" onClick={() => setStyleModal({ title: "", text: "" })} title="שמור סגנון חדש">
            הוסף סגנון
          </button>
        </div>
      )}

      {/* Text box with the references strip docked on the left */}
      <div className="prompt-box">
        <textarea
          className="prompt-input"
          // Prompts are usually English. In a right-to-left box an English sentence ends up
          // with its full stop at the start of the line; "auto" takes the direction from the
          // first letter typed, so English reads left-to-right and Hebrew right-to-left.
          // Empty, "auto" would fall back to left-to-right (the placeholder does not count),
          // and the Hebrew placeholder would sit on the left; so an empty box is RTL.
          dir={prompt.trim() ? "auto" : "rtl"}
          placeholder={
            mode === "fill"
              ? "תאר מה ליצור באזור המסומן..."
              : mode === "expand" || mode === "ratio"
              ? "תאר מה להמשיך בשוליים החדשים (אופציונלי) — שמיים, נוף, רקע..."
              : mode === "generate"
              ? "תאר את התמונה ליצירה..."
              : "הנחיות נוספות (אופציונלי) — שמירה על זהות, צבעים, פרטים..."
          }
          ref={promptRef}
          value={prompt}
          style={pinsHere ? { paddingBottom: 30 } : undefined}
          onChange={(e) => {
            const v = e.target.value;
            const caret = e.target.selectionStart ?? v.length;
            // Typing "@" is the keyboard way to the same list as the 📍 button.
            if (pinsHere && v.length === prompt.length + 1 && v[caret - 1] === "@") openPinPicker(caret - 1);
            // Typing on past an "@" means the user wanted the character, not the list.
            else if (pinPick?.at != null) setPinPick(null);
            setPrompt(v);
          }}
        />
        {pinsHere && (
          <button
            className="pin-picker-btn"
            title="תייג סיכה מהקנבס — נשלחת כקואורדינטות (או הקלד @)"
            onClick={() => openPinPicker(null)}
          >
            <Icon name="pin" size={14} />
            סיכות ({pins.length})
          </button>
        )}
        {pinPick && (
          <div className="pin-picker" ref={pickerRef} style={{ position: "fixed", left: pinPick.left, bottom: pinPick.bottom, top: "auto" }}>
            {pins.map((p) => (
              // mousedown kept from the textarea: it must not lose its caret to the click.
              <button key={p.n} onMouseDown={(e) => e.preventDefault()} onClick={() => insertPin(p)}>
                <span className="pin-num ink">{p.n}</span>
                <span>{p.note.trim() || <small>ללא הערה</small>}</span>
              </button>
            ))}
          </div>
        )}
        <div className="refs-dock">
          <div className="refs-dock-head">
            <span>ייחוס</span>
            <button
              ref={addRefBtn}
              onClick={onAddRef}
              disabled={!caps?.supportsReferenceImages}
              title={
                !caps?.supportsReferenceImages
                  ? "המנוע הנוכחי לא תומך בייחוסים"
                  : otherTabs.length
                    ? "הוסף תמונת ייחוס — מקובץ, או הקנבס של לשונית אחרת"
                    : "הוסף תמונת ייחוס"
              }
              aria-label="הוסף תמונת ייחוס"
            ><Icon name="plus" size={15} /></button>
            {refMenu && (
              <div
                className="ref-add-menu"
                ref={addRefMenu}
                style={{ position: "fixed", right: refMenu.right, bottom: refMenu.bottom }}
                onClick={() => setRefMenu(null)}
              >
                <button onClick={() => fileRef.current?.click()}>מקובץ…</button>
                <div className="ref-add-head">הקנבס של לשונית אחרת</div>
                {otherTabs.map((t) => (
                  <button key={t.id} title="צילום של הקנבס כפי שהוא עכשיו" onClick={() => void addReferenceFromDoc(t.id)}>
                    {t.title}
                  </button>
                ))}
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onPickReferences(e.target.files)} />
          </div>
          <div className={`refs-dock-list ${refsDrop.dragging ? "drop-armed" : ""}`} {...refsDrop.handlers}>
            {references.length === 0 && (
              <div className="refs-empty">{refsDrop.dragging ? "שחרר כאן" : "גרור או הוסף"}</div>
            )}
            {references.map((r) => {
              // What the choice MEANS is on screen, not behind the menu: the role used to
              // be a label with no consequence, and nothing showed that either.
              const spec = roleSpec(r.role);
              return (
                <div key={r.id} className="ref-row">
                  <div className="ref-thumb">
                    <img src={r.src} alt="" />
                    <button className="ref-chip-x" title="הסר" aria-label="הסר את תמונת הייחוס" onClick={() => removeReference(r.id)}>✕</button>
                    {r.fromDocId && (
                      <button
                        className="ref-refresh"
                        title={`צולם מהלשונית "${r.fromName ?? ""}" — לחץ לצילום מחדש כפי שהיא עכשיו`}
                        aria-label="צלם מחדש מהלשונית"
                        onClick={() => void refreshReference(r.id)}
                      >
                        <Icon name="rotate-cw" size={12} />
                      </button>
                    )}
                  </div>
                  <div className="ref-fields">
                    <select
                      value={normalizeRole(r.role)}
                      title="מה לקחת מהתמונה הזאת"
                      onChange={(e) => setReferenceRole(r.id, e.target.value as ReferenceRole)}
                    >
                      {REF_ROLES.map((role) => (
                        <option key={role.id} value={role.id} title={role.hint}>{role.label}</option>
                      ))}
                    </select>
                    <input
                      className="ref-note"
                      dir="auto"
                      placeholder="מה לקחת מכאן? (לא חובה)"
                      title="הערה חופשית שנשלחת למנוע יחד עם התפקיד — למשל: רק הפונט של הכותרת"
                      value={r.note ?? ""}
                      onChange={(e) => setReferenceNote(r.id, e.target.value)}
                    />
                  </div>
                  <div className="ref-hint">
                    {r.fromName ? `מהלשונית ${r.fromName} · ` : ""}
                    {spec.hint}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Controls under the text box */}
      <div className="prompt-controls">
        <button
          className={`ctl star-btn ${promptLibrary.includes(prompt.trim()) ? "on" : ""}`}
          title={promptLibrary.includes(prompt.trim()) ? "הסר את הפרומפט מהספרייה" : "שמור את הפרומפט לספרייה האישית"}
          disabled={!prompt.trim()}
          onClick={() => togglePromptInLibrary(prompt)}
        >
          {promptLibrary.includes(prompt.trim()) ? "בספרייה" : "לספרייה"}
        </button>
        {promptLibrary.length > 0 && (
          <select className="ctl" value="" onChange={(e) => e.target.value && setPrompt(e.target.value)}>
            <option value="">הפרומפטים שלי…</option>
            {promptLibrary.map((p) => <option key={p} value={p}>{p.slice(0, 60)}</option>)}
          </select>
        )}
        <select className="ctl" value="" onChange={(e) => e.target.value && setPrompt(e.target.value)}>
          <option value="">תבניות מוכנות…</option>
          {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>

        {/* Actions library: a saved action restores mode+prompt+settings+engine+model. */}
        {savedActions.length > 0 && (
          <select
            className="ctl"
            value=""
            title="ספריית פעולות — החלת הגדרה שמורה (מצב, פרומפט, מנוע ומודל)"
            onChange={(e) => e.target.value && applyAction(e.target.value)}
          >
            <option value="">פעולות…</option>
            {[...savedActions].sort((a, b) => b.lastUsed - a.lastUsed).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
        <button
          className="ctl star-btn"
          title="שמור את ההגדרה הנוכחית כפעולה בספרייה (מצב, פרומפט, מנוע ומודל)"
          onClick={() => setActionModal({ name: "" })}
        >
          שמור כפעולה
        </button>

        {promptHistory.length > 0 && (
          <select className="ctl" value="" onChange={(e) => e.target.value && setPrompt(e.target.value)}>
            <option value="">היסטוריה…</option>
            {promptHistory.map((p, i) => <option key={i} value={p}>{p.slice(0, 50)}</option>)}
          </select>
        )}

        {/* Engine-specific options — rendered from the provider's capabilities */}
        {engineOptions.map((opt) => {
          if (opt.type === "toggle") {
            return (
              <label className="chk" key={opt.key} title={opt.note}>
                <input
                  type="checkbox"
                  checked={!!settings[opt.key]}
                  onChange={(e) => updateSettings({ [opt.key]: e.target.checked })}
                />{" "}
                {opt.label}
              </label>
            );
          }
          const numeric = typeof opt.choices?.[0]?.value === "number";
          // A choice can belong to specific models only — GPT Image 2.5 adds two quality
          // steps the older models answer with a 400.
          const choices = opt.choices?.filter((c) => !c.models || c.models.includes(modelId));
          const raw = settings[opt.key] ?? opt.default ?? choices?.[0]?.value ?? "";
          // Switching to a model without the chosen value must not leave it showing: the
          // select would render blank while the stale value is what actually gets sent.
          const cur = choices?.some((c) => String(c.value) === String(raw))
            ? raw
            : (opt.default ?? choices?.[0]?.value ?? "");
          return (
            <label className="ctl-field" key={opt.key} title={opt.note}>
              {opt.label}
              <select
                value={String(cur)}
                onChange={(e) =>
                  updateSettings({ [opt.key]: numeric ? Number(e.target.value) : e.target.value })
                }
              >
                {choices?.map((c) => (
                  <option key={String(c.value)} value={String(c.value)}>{c.label}</option>
                ))}
              </select>
            </label>
          );
        })}

        <label className="ctl-field" title="מספר מועמדות במכה אחת — כולן נפתחות כשכבות נפרדות (כל אחת מחויבת)">
          וריאציות
          <select
            value={String(settings.variations ?? 1)}
            onChange={(e) => updateSettings({ variations: Number(e.target.value) })}
          >
            <option value="1">1</option>
            <option value="2">2 (×2 עלות)</option>
            <option value="3">3 (×3 עלות)</option>
          </select>
        </label>

        {fillOut && (
          <span
            className="res-legend"
            title={
              fillOut.auto
                ? "מותאם לאזור: הג'נרוט נעשה בגודל האמיתי של השטח המסומן, אחרי מגבלות המנוע (מינימום ~0.7MP, צלע עד 3840)"
                : "גודל קבוע שנבחר ברזולוציית אזור — גובר על ההתאמה לאזור"
            }
          >
            אזור {fillOut.rw.toLocaleString()}×{fillOut.rh.toLocaleString()} → פלט ≈ {fillOut.ow.toLocaleString()}×
            {fillOut.oh.toLocaleString()}px{fillOut.auto ? " · מותאם" : ""}
          </span>
        )}

        {outRes && (
          <span className="res-legend" title="רזולוציית הפלט הצפויה — אחרי מגבלות המנוע">
            פלט ≈ {outRes.ow.toLocaleString()}×{outRes.oh.toLocaleString()}px · ×{outRes.factor}
          </span>
        )}

      </div>

      {/* Run, on a row of its own that stays at the bottom of the dock however far the
          controls above it scroll. It used to be the last item of the scrolling row, below
          the edge of the window at the dock's default height. */}
      <div className="prompt-run">
        <Notices />
        {(() => {
          const est = estimateGenMs(genTimings, providerId, mode);
          const t = genTimings[`${providerId}:${mode}`];
          if (!est) return null;
          return (
            <span className="time-legend" title={`ממוצע מתוך ${t?.count ?? 0} הרצות אחרונות במנוע ובמצב הזה`}>
              ≈ {formatDuration(est)}
            </span>
          );
        })()}
        <button
          className={`generate-btn ink ${busy ? "ink--running" : ""}`}
          onClick={onGenerate}
          disabled={busy || (mode === "generate" ? !prompt.trim() : !project)}
          aria-busy={busy || undefined}
        >
          {busy ? "מעבד…" : `הרץ ${modeLabel(mode)}`}
        </button>
      </div>

      {regenStep === "reveUpscale" && (
        <div className="modal-backdrop" onClick={() => setRegenStep(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">אפסקייל ב-Reve לתמונה גדולה</div>
            <div className="settings-section">
              <p className="onboard-lead">
                התמונה גדולה ({longEdge}px). <b>Reve מקטין אותה ל-~1MP לפני ההגדלה</b>, כך
                שתאבד פרטים — הוא לא אפסקיילר אמיתי. <b>umage2</b> כן עושה אפסקייל איכותי
                אמיתי, אבל <b>יקר משמעותית</b> — תלוי ברזולוציה ובאיכות, ויכול להגיע ל-
                <b>$0.50–$1 ויותר</b> (לעומת ~$0.05 ב-Reve).
              </p>
              <div className="modal-actions">
                {umageConfigured && (
                  <button className="primary" onClick={switchToUmage}>עבור ל-umage2 (איכותי · יקר יותר)</button>
                )}
                <button onClick={continueReve}>המשך עם Reve בכל זאת</button>
                <button onClick={() => setRegenStep(null)}>ביטול</button>
              </div>
              {!umageConfigured && (
                <p className="onboard-lead quiet">
                  כדי לעבור ל-umage2 צריך להגדיר לו מפתח API בהגדרות.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {switchNotice && (
        <div className="modal-backdrop" onClick={() => setSwitchNotice(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
            <div className="modal-title">הוחלף מנוע</div>
            {switchNotice === "mask" ? (
              <p className="onboard-lead">
                <b>הרחבה</b> משלימה רק את השוליים החדשים ושומרת את החלק הקיים פיקסל-בפיקסל, ולכן דורשת
                מנוע עם <b>מסכה אמיתית</b>. המנוע הנוכחי לא תומך בכך, אז עברנו אוטומטית ל-<b>{provider?.name ?? "umage2"}</b>.
              </p>
            ) : switchNotice === "genonly" ? (
              <p className="onboard-lead">
                <b>Grok Image</b> יודע לבצע <b>יצירה מטקסט בלבד</b> — הוא לא עורך תמונות קיימות.
                עברת למצב שדורש עריכה, אז המנוע הוחלף אוטומטית ל-<b>Nano Banana 2</b> כדי שתוכל להמשיך.
              </p>
            ) : (
              <p className="onboard-lead">
                <b>Crystal Upscaler</b> יודע לבצע <b>אפסקייל בלבד</b>. עברת למצב יצירה אחר, אז
                המנוע הוחלף אוטומטית ל-<b>Nano Banana 2</b> כדי שתוכל להמשיך.
              </p>
            )}
            <label className="chk">
              <input
                type="checkbox"
                onChange={(e) =>
                  localStorage.setItem(
                    switchNotice === "mask"
                      ? "mbrush.hideMaskSwitch"
                      : switchNotice === "genonly"
                      ? "mbrush.hideGenOnlySwitch"
                      : "mbrush.hideUpscaleOnlySwitch",
                    e.target.checked ? "1" : "0",
                  )
                }
              />
              אל תציג את ההודעה הזו שוב
            </label>
            <div className="modal-actions">
              <button className="primary" onClick={() => setSwitchNotice(null)}>הבנתי</button>
            </div>
          </div>
        </div>
      )}

      {actionModal && (
        <div className="modal-backdrop" onClick={() => setActionModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 460 }}>
            <div className="modal-title">שמירת פעולה</div>
            <label className="field-label">שם הפעולה</label>
            <input
              autoFocus
              placeholder="למשל: רסטורציה / איור → צילום / אפסקייל חד"
              value={actionModal.name}
              onChange={(e) => setActionModal({ name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && actionModal.name.trim()) {
                  saveAction(actionModal.name);
                  setActionModal(null);
                }
              }}
            />
            <table className="params-table">
              <tbody>
                <tr><td className="params-k">פעולה</td><td className="params-v">{modeLabel(mode)}</td></tr>
                <tr><td className="params-k">מנוע</td><td className="params-v">{provider?.name ?? providerId}</td></tr>
                <tr><td className="params-k">מודל</td><td className="params-v" dir="ltr">{modelId}</td></tr>
                {settings.medium && (
                  <tr><td className="params-k">מדיום</td><td className="params-v" dir="ltr">{settings.medium}</td></tr>
                )}
                {settings.styleText && (
                  <tr><td className="params-k">סגנון</td><td className="params-v" dir="ltr">{String(settings.styleText).slice(0, 40)}</td></tr>
                )}
                {prompt.trim() && (
                  <tr><td className="params-k">פרומפט</td><td className="params-v">{prompt.slice(0, 90)}{prompt.length > 90 ? "…" : ""}</td></tr>
                )}
              </tbody>
            </table>
            {savedActions.length > 0 && (
              <>
                <label className="field-label">פעולות שמורות</label>
                <div className="saved-list">
                  {[...savedActions].sort((a, b) => b.lastUsed - a.lastUsed).map((a) => (
                    <div key={a.id} className="saved-row">
                      <button className="fc-x" title="מחק פעולה" aria-label="מחק פעולה" onClick={() => removeSavedAction(a.id)}><Icon name="trash" size={14} /></button>
                      <span className="saved-name">{a.name}</span>
                      <span className="saved-meta">{modeLabel(a.mode)} · {a.providerId}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="modal-actions">
              <button
                className="primary"
                disabled={!actionModal.name.trim()}
                onClick={() => {
                  saveAction(actionModal.name);
                  setActionModal(null);
                }}
              >
                שמור פעולה
              </button>
              <button onClick={() => setActionModal(null)}>סגור</button>
            </div>
          </div>
        </div>
      )}

      {styleModal && (
        <div className="modal-backdrop" onClick={() => setStyleModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 420 }}>
            <div className="modal-title">שמירת סגנון</div>
            <label className="field-label">כותרת</label>
            <input
              autoFocus
              placeholder="למשל: פילם נואר"
              value={styleModal.title}
              onChange={(e) => setStyleModal({ ...styleModal, title: e.target.value })}
            />
            <label className="field-label">טקסט הסגנון (נוסף אחרי ‎"in the style of")</label>
            <textarea
              className="style-text"
              placeholder="high-contrast 1950s film noir, deep shadows, moody lighting"
              value={styleModal.text}
              onChange={(e) => setStyleModal({ ...styleModal, text: e.target.value })}
            />
            <div className="modal-actions">
              <button
                className="primary"
                disabled={!styleModal.title.trim() || !styleModal.text.trim()}
                onClick={() => {
                  addSavedStyle(styleModal.title, styleModal.text);
                  applyStyle(styleModal.text.trim());
                  setStyleModal(null);
                }}
              >
                שמור והחל
              </button>
              <button onClick={() => setStyleModal(null)}>ביטול</button>
            </div>
          </div>
        </div>
      )}

      {regenStep === "choose" && (
        <div className="modal-backdrop" onClick={() => setRegenStep(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">לאן תיכנס התוצאה?</div>
            <div className="settings-section">
              <p className="onboard-lead">
                להוסיף את התוצאה כ<b>שכבה חדשה</b> בפרוייקט הנוכחי, או לפתוח <b>פרוייקט חדש</b>?
              </p>
              <div className="modal-actions">
                <button className="primary" onClick={newLayerHere}>שכבה חדשה בפרוייקט</button>
                <button onClick={onNewProjectChoice}>פרוייקט חדש</button>
                <button onClick={() => setRegenStep(null)}>ביטול</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {regenStep === "newproj" && (
        <div className="modal-backdrop" onClick={() => setRegenStep(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">פרוייקט חדש</div>
            <div className="settings-section">
              <p className="onboard-lead">
                פתיחת פרוייקט חדש תסגור את הפרוייקט הנוכחי, ויש בו <b>שינויים שלא נשמרו</b>.
              </p>
              <div className="modal-actions">
                <button className="primary" onClick={saveThenNewProject}>שמור וסגור</button>
                <button className="danger" onClick={newProject}>סגור בלי לשמור</button>
                <button onClick={() => setRegenStep("choose")}>חזרה</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
