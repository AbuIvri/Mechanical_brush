// Generates website/legend.html (the tester legend page) from src/help/legend.json,
// and syncs website/assets/site.css from index.html's <style> block so the page
// matches the marketing site. Re-run after editing legend.json or the site styles:
//   node scripts/gen-legend.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legend = JSON.parse(readFileSync(path.join(root, "src/help/legend.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const indexHtml = readFileSync(path.join(root, "website/index.html"), "utf8");

// 1) Sync site.css from index.html's inline <style> so legend.html matches the site.
const styleMatch = indexHtml.match(/<style>([\s\S]*?)<\/style>/);
if (styleMatch) {
  writeFileSync(path.join(root, "website/assets/site.css"), styleMatch[1].trim() + "\n");
  console.log("✓ website/assets/site.css synced from index.html");
}

// The drawn icons, rendered from the app's own Icon component so the website legend
// shows exactly what the app shows (no emoji, no second set of drawings).
const { createServer } = await import("vite");
const vite = await createServer({ root, configFile: false, appType: "custom", logLevel: "error", server: { middlewareMode: true }, esbuild: { jsx: "automatic" } });
const { Icon } = await vite.ssrLoadModule("/src/ui/Icon.tsx");
const React = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const iconSvg = (name) => renderToStaticMarkup(React.createElement(Icon, { name, size: 18 }));
await vite.close();

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// Bilingual element: shows he by default; applyLang swaps to data-en.
const bi = (o, tag = "span", cls = "") =>
  `<${tag}${cls ? ` class="${cls}"` : ""} data-he="${esc(o.he)}" data-en="${esc(o.en)}">${esc(o.he)}</${tag}>`;

function rows(items) {
  return items
    .map((it) => {
      const glyph = it.icon
        ? `<span class="lg-glyph">${iconSvg(it.icon)}</span>`
        : `<span class="lg-glyph">${it.glyph ? esc(it.glyph) : ""}</span>`;
      return `<div class="lg-row">${glyph}<div class="lg-text">${bi(it.label, "span", "lg-name")}${bi(it.desc, "span", "lg-desc")}</div></div>`;
    })
    .join("\n");
}

const sections = legend.sections
  .map(
    (sec) =>
      `<div class="lg-block reveal"><h3 class="lg-area">${esc(sec.area.he)}<span class="lg-area-en" data-he="" data-en="${esc(
        sec.area.en,
      )}"></span></h3><div class="lg-grid">${rows(sec.items)}</div></div>`,
  )
  .join("\n");

const modesBlock = `<div class="lg-block reveal"><h3 class="lg-area">${"מצבי יצירה"}</h3><div class="lg-grid">${rows(
  legend.modes.map((m) => ({ glyph: "", label: m.label, desc: m.desc })),
)}</div></div>`;

const optsBlock = `<div class="lg-block reveal"><h3 class="lg-area">${"אפשרויות מנוע"}</h3><div class="lg-grid">${rows(
  legend.engineOptions.map((o) => ({ glyph: "", label: o.label, desc: o.desc })),
)}</div></div>`;

const chips = (arr, cls) =>
  arr.map((x) => `<span class="lg-chip ${cls}" data-he="${esc(x.label.he)}" data-en="${esc(x.label.en)}">${esc(x.label.he)}</span>`).join("");
const chipsBlock = `<div class="lg-block reveal"><h3 class="lg-area">${"מצבי מיזוג ותפקידי ייחוס"}</h3><div class="lg-chips">${chips(
  legend.blendModes,
  "",
)}</div><div class="lg-chips">${chips(legend.refRoles, "alt")}</div></div>`;

const shortcuts = `<div class="lg-block reveal"><h3 class="lg-area">${"קיצורי מקלדת"}</h3><table class="lg-keys"><tbody>${legend.shortcuts
  .map((s) => `<tr><td class="lg-kbd"><kbd>${esc(s.keys)}</kbd></td><td data-he="${esc(s.action.he)}" data-en="${esc(s.action.en)}">${esc(s.action.he)}</td></tr>`)
  .join("")}</tbody></table></div>`;

const body = [sections, modesBlock, optsBlock, chipsBlock, shortcuts].join("\n");

const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>מקרא · המכחול המכני — The Mechanical Brush</title>
<link rel="icon" href="./assets/logo.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@300;400;500;700;800;900&family=Sora:wght@600;700;800&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="./assets/site.css" />
<style>
  .lg-top { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 14px; padding: 12px 22px; background: rgba(10,11,15,.85); backdrop-filter: blur(10px); border-bottom: 1px solid var(--border); }
  .lg-top .brand-he { font-weight: 800; color: var(--accent); }
  .lg-top a.back { color: var(--text); text-decoration: none; font-size: 14px; opacity: .85; }
  .lg-top a.back:hover { opacity: 1; }
  .lg-top .lang-btn { margin-inline-start: auto; }
  .lg-hero { padding: 40px 22px 8px; }
  .lg-shot { border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: #000; margin: 18px 0 8px; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  .lg-shot img { display: block; width: 100%; height: auto; }
  .lg-block { margin-top: 26px; }
  .lg-area { font-family: Sora, sans-serif; font-size: 16px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 7px; margin: 0 0 12px; }
  .lg-area-en { color: var(--muted); font-size: 12px; font-weight: 400; margin-inline-start: 8px; }
  .lg-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 26px; }
  @media (max-width: 720px){ .lg-grid { grid-template-columns: 1fr; } }
  .lg-row { display: grid; grid-template-columns: 34px 1fr; align-items: baseline; gap: 8px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
  .lg-glyph { grid-row: span 2; font-size: 17px; text-align: center; }
  .lg-glyph svg { display: inline-block; vertical-align: middle; }
  .lg-text { display: flex; flex-direction: column; gap: 2px; }
  .lg-name { font-weight: 700; font-size: 13.5px; }
  .lg-desc { color: var(--muted); font-size: 12.5px; line-height: 1.5; }
  .lg-chips { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 8px; }
  .lg-chip { font-size: 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: 7px; padding: 4px 10px; }
  .lg-chip.alt { border-color: var(--accent); color: var(--accent); }
  .lg-keys { width: 100%; border-collapse: collapse; font-size: 13px; }
  .lg-keys td { padding: 8px 10px; border-top: 1px solid var(--border); text-align: start; }
  .lg-keys .lg-kbd { width: 230px; }
  .lg-keys kbd { background: var(--bg3); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 7px; padding: 3px 9px; font-family: ui-monospace, monospace; font-size: 12px; }
  .lg-foot { color: var(--muted); font-size: 12px; text-align: center; padding: 40px 22px; }
</style>
</head>
<body>
<div class="lg-top">
  <span class="brand-he">המכחול המכני <span class="alpha-chip">BETA</span></span>
  <a class="back" href="index.html" data-he="← לאתר" data-en="← Home">← לאתר</a>
  <button class="lang-btn" id="langBtn">EN</button>
</div>

<div class="wrap lg-hero">
  <div class="sec-tag" data-he="מדריך מהיר" data-en="Quick guide">מדריך מהיר</div>
  <h1 class="display" data-he="מקרא הממשק וקיצורי מקלדת" data-en="Interface legend & keyboard shortcuts">מקרא הממשק וקיצורי מקלדת</h1>
  <p style="color:var(--muted);max-width:680px" data-he="כל כלי, כפתור ואפשרות במכחול המכני — לצד תמונת המסך. גרסת בטא ${esc(
    pkg.version || "",
  )}." data-en="Every tool, button and option in The Mechanical Brush — beside the screenshot. Beta ${esc(
  pkg.version || "",
)}.">כל כלי, כפתור ואפשרות במכחול המכני — לצד תמונת המסך. גרסת בטא ${esc(pkg.version || "")}.</p>

  <div class="lg-shot">
    <img src="./assets/app-screenshot.jpg" alt="המכחול המכני — מסך ראשי" onerror="this.parentNode.style.display='none'" />
  </div>

  ${body}
</div>

<div class="lg-foot">© המכחול המכני · The Mechanical Brush — Beta</div>

<script>
  var lang = localStorage.getItem("mb_lang") || "he";
  function applyLang(l){
    lang = l; localStorage.setItem("mb_lang", l);
    document.documentElement.lang = l;
    document.documentElement.dir = (l === "he") ? "rtl" : "ltr";
    document.querySelectorAll("[data-he]").forEach(function(el){
      var v = el.getAttribute("data-"+l); if(v!=null) el.innerHTML = v;
    });
    document.getElementById("langBtn").textContent = (l === "he") ? "EN" : "עב";
  }
  document.getElementById("langBtn").addEventListener("click", function(){ applyLang(lang === "he" ? "en" : "he"); });
  applyLang(lang);
  if("IntersectionObserver" in window){
    var io = new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add("in"); io.unobserve(e.target); } }); }, {threshold:0.08});
    document.querySelectorAll(".reveal").forEach(function(el){ io.observe(el); });
  }
</script>
</body>
</html>
`;

writeFileSync(path.join(root, "website/legend.html"), html);
console.log("✓ website/legend.html generated (" + legend.sections.length + " sections, " + legend.shortcuts.length + " shortcuts)");
