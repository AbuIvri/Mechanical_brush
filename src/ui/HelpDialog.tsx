import legend from "../help/legend.json";
import { Icon } from "./Icon";
import type { IconName } from "./iconNames";

// Bilingual content lives in legend.json (shared with the website legend page).
// The app UI is Hebrew, so we render the "he" strings here.
type L = { he: string; en: string };
// `icon` names one of the drawn icons; `glyph` is a plain mark the interface itself shows
// (a dot, "4K", "%"). Most rows have neither: the control they describe is a word.
type Item = { glyph: string; icon?: IconName; label: L; desc: L };
type Section = { area: L; items: Item[] };

const data = legend as unknown as {
  sections: Section[];
  modes: { label: L; desc: L }[];
  engineOptions: { label: L; desc: L }[];
  blendModes: { label: L }[];
  refRoles: { label: L; desc?: L }[];
  shortcuts: { keys: string; action: L }[];
};

export function HelpDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">מקרא וקיצורי מקלדת</div>

        <div className="help-shot">
          <img
            src="help-screenshot.png"
            alt="המכחול המכני — מסך ראשי"
            onError={(e) => ((e.currentTarget.style.display = "none"))}
          />
        </div>

        <p className="caps-note">
          מקרא מהיר של הכלים, הכפתורים והאפשרויות. ריחוף מעל כפתור באפליקציה מציג גם
          תיאור קצר. גרסת בטא — נשמח למשוב דרך „משוב למפתח” בתפריט „עוד”.
        </p>

        {data.sections.map((sec) => (
          <div className="help-section" key={sec.area.he}>
            <div className="help-area">{sec.area.he}</div>
            <div className="help-grid">
              {sec.items.map((it, i) => (
                <div className="help-row" key={i}>
                  <span className="help-glyph">{it.icon ? <Icon name={it.icon} size={16} /> : it.glyph}</span>
                  <span className="help-name">{it.label.he}</span>
                  <span className="help-desc">{it.desc.he}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="help-section">
          <div className="help-area">מצבי יצירה</div>
          <div className="help-grid">
            {data.modes.map((m, i) => (
              <div className="help-row" key={i}>
                <span className="help-name">{m.label.he}</span>
                <span className="help-desc">{m.desc.he}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="help-section">
          <div className="help-area">אפשרויות מנוע</div>
          <div className="help-grid">
            {data.engineOptions.map((o, i) => (
              <div className="help-row" key={i}>
                <span className="help-name">{o.label.he}</span>
                <span className="help-desc">{o.desc.he}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="help-section">
          <div className="help-area">מצבי מיזוג ותפקידי ייחוס</div>
          <div className="help-chips">
            {data.blendModes.map((b, i) => (
              <span className="help-chip" key={"b" + i}>{b.label.he}</span>
            ))}
          </div>
          <div className="help-chips">
            {data.refRoles.map((r, i) => (
              <span className="help-chip alt" key={"r" + i} title={r.desc?.he}>{r.label.he}</span>
            ))}
          </div>
        </div>

        <div className="help-section">
          <div className="help-area">קיצורי מקלדת</div>
          <table className="help-keys">
            <tbody>
              {data.shortcuts.map((s, i) => (
                <tr key={i}>
                  <td className="help-kbd"><kbd>{s.keys}</kbd></td>
                  <td>{s.action.he}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>סגור</button>
        </div>
      </div>
    </div>
  );
}
