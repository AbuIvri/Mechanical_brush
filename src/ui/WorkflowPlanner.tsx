import { useState } from "react";
import { useChat } from "../state/chat";
import { useStore } from "../state/store";
import {
  PROVIDERS,
  type ChatProvider,
  providerDef,
} from "./chatModels";
import { buildSkillExport, saveJson } from "./exportJson";
import {
  SKILL_RATIOS,
  STEP_KINDS,
  blankSkill,
  blankStep,
  parseSkill,
  type PromptSkill,
  type SkillStep,
  type StepKind,
} from "./skills";
import { Icon } from "./Icon";

const KIND_LABEL: Record<StepKind, string> = {
  text: "שאלה חופשית",
  choice: "בחירה מרשימה",
  images: "צירוף תמונות",
  mode: "בחירת מצב יצירה",
  ai: "שלב AI",
};

interface Props {
  sessionId: string;
  busy: boolean;
  /** Ask the tab's model for a first draft from a free-text description. */
  onGenerate: (desc: string) => void;
  /** Ask the tab's model to revise the current draft. */
  onRefine: (instruction: string) => void;
  onRun: (skill: PromptSkill) => void;
  onClose: () => void;
}

/** The workflow planner, rendered inline in the message flow (never a modal). The
 *  model drafts, the user edits — and the editor works with no model at all. */
export function WorkflowPlanner({ sessionId, busy, onGenerate, onRefine, onRun, onClose }: Props) {
  const planner = useChat((s) => s.sessions.find((x) => x.id === sessionId)?.planner ?? null);
  const patchSession = useChat((s) => s.patchSession);
  const addSavedSkill = useStore((s) => s.addSavedSkill);
  const configuredKeys = useStore((s) => s.configuredKeys);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");

  if (!planner) return null;

  const patchPlanner = (p: Partial<NonNullable<typeof planner>>) =>
    patchSession(sessionId, (s) => ({ planner: s.planner ? { ...s.planner, ...p } : s.planner }));

  // ---- phase 1: describe the workflow -------------------------------------
  // No draft means no editor: showing a blank one would replace the model's answer
  // (and the reason it failed) with the errors of an empty skeleton.
  if (planner.phase === "ask" || !planner.draft) {
    return (
      <div className="skill-card planner">
        <div className="skill-card-head">
          <span className="skill-card-title">בניית workflow חדש</span>
          <button className="fc-x" title="בטל" onClick={onClose}>✕</button>
        </div>
        <div className="skill-card-hint">
          תאר במילים שלך מה הוורקפלו צריך לעשות — מה לשאול אותך, מה לנתח, ומה הפרומפט הסופי צריך להכיל.
          המודל של הלשונית הזו ינסח טיוטה, ואתה תערוך אותה לפני שמירה.
        </div>
        <textarea
          className="prompt-input"
          style={{ minHeight: 90 }}
          value={planner.desc}
          placeholder="למשל: קח תמונת מוצר, שאל אותי מי קהל היעד ומה מצב הרוח, ותנסח פרומפט לתמונת פרסומת נקייה בסטודיו"
          onChange={(e) => patchPlanner({ desc: e.target.value })}
        />
        <div className="modal-actions">
          <button className="primary" disabled={busy || !planner.desc.trim()} onClick={() => onGenerate(planner.desc)}>
            נסח טיוטה
          </button>
          <button disabled={busy} onClick={() => patchPlanner({ phase: "edit", draft: blankSkill(), errors: [], warnings: [] })}>
            התחל ריק
          </button>
          <button disabled={busy} onClick={() => setPasting((v) => !v)}>הדבק JSON</button>
        </div>
        {pasting && (
          <>
            <textarea
              className="prompt-input"
              dir="ltr"
              style={{ minHeight: 110 }}
              value={pasted}
              placeholder='{"name": "...", "steps": [...]}'
              onChange={(e) => setPasted(e.target.value)}
            />
            <div className="modal-actions">
              <button
                className="primary"
                disabled={!pasted.trim()}
                onClick={() => {
                  const r = parseSkill(pasted);
                  if (!r.skill) {
                    patchPlanner({ errors: r.errors });
                    return;
                  }
                  patchPlanner({ phase: "edit", draft: r.skill, errors: r.errors, warnings: r.warnings });
                  setPasting(false);
                  setPasted("");
                }}
              >
                טען
              </button>
            </div>
          </>
        )}
        {planner.errors.length > 0 && (
          <>
            <div className="planner-errors">{planner.errors.map((e, i) => <div key={i}>שגיאה: {e}</div>)}</div>
            <div className="skill-card-hint">
              התשובה של המודל נשארה בשיחה למעלה. אפשר לנסות שוב, לנסח את התיאור אחרת,
              להעתיק ממנה את ה-JSON ולהדביק כאן, או להתחיל ריק ולבנות ידנית.
            </div>
          </>
        )}
      </div>
    );
  }

  // ---- phase 2: edit the draft --------------------------------------------
  const draft = planner.draft;
  const check = parseSkill(draft);
  const blocked = check.errors.length > 0;

  const setDraft = (d: PromptSkill) => patchPlanner({ draft: d });
  const setStep = (i: number, patch: Partial<SkillStep>) =>
    setDraft({ ...draft, steps: draft.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    setDraft({ ...draft, steps });
  };
  const removeStep = (i: number) => setDraft({ ...draft, steps: draft.steps.filter((_, j) => j !== i) });

  /** Changing a step's kind must drop the fields that no longer apply. */
  const changeKind = (i: number, kind: StepKind) => {
    const { id, title, hint } = draft.steps[i];
    setDraft({
      ...draft,
      steps: draft.steps.map((s, j) => (j === i ? { ...blankStep(kind, i + 1), id, title, hint } : s)),
    });
  };

  const save = () => {
    if (!check.skill) return;
    // Keep the id we opened with, so editing a saved workflow updates it in place.
    addSavedSkill({ ...check.skill, id: planner.sourceId ?? check.skill.id });
    onClose();
  };

  return (
    <div className="skill-card planner">
      <div className="skill-card-head">
        <span className="skill-card-title">עורך הוורקפלו</span>
        <button className="fc-x" title="סגור בלי לשמור" onClick={onClose}>✕</button>
      </div>

      <div className="planner-meta">
        <input
          className="prompt-input"
          value={draft.name}
          placeholder="שם הוורקפלו"
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          className="prompt-input"
          value={draft.description}
          placeholder="תיאור קצר — מה הוא מייצר"
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <label className="planner-inline">
          יחס צלעות שהוורקפלו קובע:
          <select
            value={draft.applySettings?.aspectRatio ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              const rest = { ...draft.applySettings };
              delete rest.aspectRatio;
              setDraft({ ...draft, applySettings: v ? { ...rest, aspectRatio: v } : (Object.keys(rest).length ? rest : undefined) });
            }}
          >
            <option value="">לא קובע</option>
            {SKILL_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
      </div>

      {draft.steps.map((s, i) => (
        <div className="planner-step" key={i}>
          <div className="planner-step-head">
            <span className="skill-step-num">{i + 1}</span>
            <select value={s.kind} onChange={(e) => changeKind(i, e.target.value as StepKind)}>
              {STEP_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <input
              className="planner-id"
              dir="ltr"
              value={s.id}
              title="מזהה השלב — כך מפנים אליו בשלבי AI: {{id}}"
              onChange={(e) => setStep(i, { id: e.target.value.trim() })}
            />
            <span className="composer-spacer" />
            <button className="fc-x" title="למעלה" aria-label="למעלה" disabled={i === 0} onClick={() => moveStep(i, -1)}><Icon name="up" size={14} /></button>
            <button className="fc-x" title="למטה" aria-label="למטה" disabled={i === draft.steps.length - 1} onClick={() => moveStep(i, 1)}><Icon name="down" size={14} /></button>
            <button className="fc-x" title="מחק שלב" aria-label="מחק שלב" onClick={() => removeStep(i)}><Icon name="trash" size={14} /></button>
          </div>

          <input className="prompt-input" value={s.title} placeholder="מה השלב אומר למשתמש" onChange={(e) => setStep(i, { title: e.target.value })} />
          <input className="prompt-input" value={s.hint ?? ""} placeholder="שורת עזרה (רשות)" onChange={(e) => setStep(i, { hint: e.target.value })} />

          {s.kind === "choice" && (
            <textarea
              className="prompt-input"
              style={{ minHeight: 60 }}
              value={(s.options ?? []).join("\n")}
              placeholder="אפשרות בכל שורה (לפחות שתיים)"
              onChange={(e) => setStep(i, { options: e.target.value.split("\n") })}
            />
          )}

          {s.kind === "images" && (
            <label className="planner-inline">
              <input type="checkbox" checked={s.refDefault !== false} onChange={(e) => setStep(i, { refDefault: e.target.checked })} />
              התמונות שיצורפו כאן ייכנסו כתמונות ייחוס לתיבת היצירה
            </label>
          )}

          {s.kind === "ai" && (
            <>
              <textarea
                className="prompt-input"
                dir="ltr"
                style={{ minHeight: 110 }}
                value={s.instruction ?? ""}
                placeholder="The instruction sent to the model. Use {{stepId}} to inject an earlier answer."
                onChange={(e) => setStep(i, { instruction: e.target.value })}
              />
              <div className="planner-flags">
                <label className="planner-inline">
                  <input type="checkbox" checked={!!s.editable} onChange={(e) => setStep(i, { editable: e.target.checked })} />
                  עצור לעריכה
                </label>
                <label className="planner-inline">
                  <input type="checkbox" checked={!!s.final} onChange={(e) => setStep(i, { final: e.target.checked })} />
                  זה הפרומפט הסופי
                </label>
                <label className="planner-inline">
                  מודל:
                  <select
                    value={s.provider ?? ""}
                    onChange={(e) => {
                      const p = e.target.value as ChatProvider | "";
                      setStep(i, p ? { provider: p, model: providerDef(p).models[0] } : { provider: undefined, model: undefined });
                    }}
                  >
                    <option value="">כמו הלשונית</option>
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                        {configuredKeys.includes(p.keyId) ? "" : " (אין מפתח)"}
                      </option>
                    ))}
                  </select>
                </label>
                {s.provider && (
                  <input
                    className="planner-id"
                    dir="ltr"
                    value={s.model ?? ""}
                    placeholder="model id"
                    onChange={(e) => setStep(i, { model: e.target.value })}
                  />
                )}
              </div>
            </>
          )}
        </div>
      ))}

      <div className="modal-actions">
        <button onClick={() => setDraft({ ...draft, steps: [...draft.steps, blankStep("text", draft.steps.length + 1)] })}>
          הוסף שלב
        </button>
      </div>

      {check.errors.length > 0 && (
        <div className="planner-errors">{check.errors.map((e, i) => <div key={i}>שגיאה: {e}</div>)}</div>
      )}
      {check.warnings.length > 0 && (
        <div className="skill-card-hint">{check.warnings.map((w, i) => <div key={i}>· {w}</div>)}</div>
      )}

      <div className="planner-refine">
        <input
          className="prompt-input"
          value={planner.refine}
          placeholder="שנה משהו בעזרת המודל — למשל: הוסף שלב שבוחר סגנון תאורה"
          onChange={(e) => patchPlanner({ refine: e.target.value })}
        />
        <button disabled={busy || !planner.refine.trim()} onClick={() => onRefine(planner.refine)}>שפר</button>
      </div>

      <div className="modal-actions">
        <button className="primary" disabled={blocked} onClick={() => check.skill && onRun(check.skill)}>הרץ עכשיו</button>
        <button disabled={blocked} onClick={save}>שמור</button>
        <button
          onClick={() => {
            navigator.clipboard.writeText(JSON.stringify(draft, null, 2)).catch(() => {});
            useStore.setState({ status: "הוורקפלו הועתק כ-JSON." });
          }}
        >
          העתק JSON
        </button>
        <button
          onClick={async () => {
            try {
              const path = await saveJson(buildSkillExport(draft), `skill-${draft.name || "workflow"}`);
              if (path) useStore.setState({ status: `הוורקפלו יוצא ל-${path}` });
            } catch (e: any) {
              useStore.setState({ error: e?.message ?? "הייצוא נכשל" });
            }
          }}
        >
          שמור כקובץ
        </button>
      </div>
    </div>
  );
}
