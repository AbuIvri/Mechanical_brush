// Generates email/issue-tool.html — a local admin tool to issue access codes:
// shows the next unused code, fills the email template, previews it, copies it
// ready to paste into Gmail, and logs/advances. Re-run after changing the email
// template or adding code batches:  node scripts/gen-issue-tool.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const emailTpl = readFileSync(path.join(root, "email/access-email.html"), "utf8");

// Use only the NEWEST codes-*.txt batch (the one you most recently generated and
// seeded into KV). Older batches may be unseeded/expired, so we don't offer them.
// Added later batches: re-run this script after seeding, or paste them into the
// tool's "add codes" box.
const codesDir = path.join(root, "license-codes");
let codes = [];
try {
  const files = readdirSync(codesDir).filter((f) => /^codes-.*\.txt$/.test(f)).sort();
  const latest = files[files.length - 1];
  if (latest) {
    const txt = readFileSync(path.join(codesDir, latest), "utf8");
    for (const m of txt.matchAll(/MB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g)) {
      if (!codes.includes(m[0])) codes.push(m[0]);
    }
  }
} catch {
  /* none yet */
}

// Safe JS string embedding (prevents premature </script> and quote breakage).
const jsStr = (s) => JSON.stringify(s).replace(/<\//g, "<\\/");

const html = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>הנפקת קודים · המכחול המכני</title>
<style>
  :root{--bg:#0b0c0f;--card:#15161c;--card2:#101116;--bd:#2a2f3a;--acc:#d98a3d;--tx:#e6e8ee;--mut:#8a91a0}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);font-family:'Heebo','Helvetica Neue',Arial,sans-serif;padding:22px}
  .wrap{max-width:1080px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:18px}
  @media(max-width:860px){.wrap{grid-template-columns:1fr}}
  h1{font-size:20px;margin:0 0 2px;color:var(--acc)}
  .sub{color:var(--mut);font-size:12px;margin-bottom:16px}
  .panel{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px}
  label{display:block;font-size:12px;color:var(--mut);margin:12px 0 5px}
  input,textarea{width:100%;background:var(--card2);border:1px solid var(--bd);border-radius:9px;color:var(--tx);padding:10px;font-size:14px;font-family:inherit}
  input:focus,textarea:focus{outline:none;border-color:var(--acc)}
  .code-box{background:#1c1710;border:1.5px solid var(--acc);border-radius:12px;padding:14px;text-align:center;margin-bottom:6px}
  .code-box .lbl{font-size:11px;color:var(--acc);font-weight:700;letter-spacing:.5px}
  .code-box .code{font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:800;letter-spacing:2px;color:#fff;margin-top:5px;direction:ltr}
  .remain{font-size:12px;color:var(--mut);margin-top:6px}
  .remain b{color:var(--tx)}
  .btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
  button{background:#22242c;color:var(--tx);border:1px solid #3a3f4a;border-radius:9px;padding:10px 16px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit}
  button:hover{border-color:var(--acc)}
  button.primary{background:var(--acc);color:#14151a;border:none}
  button:disabled{opacity:.45;cursor:not-allowed}
  .ok{color:#5fbf78;font-size:12px;margin-top:8px;min-height:14px}
  #preview{width:100%;height:600px;overflow:auto;border:1px solid var(--bd);border-radius:12px;background:#0b0c0f}
  table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
  th,td{padding:6px 8px;border-top:1px solid var(--bd);text-align:right}
  th{color:var(--mut);font-weight:600}
  td.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--mut);direction:ltr;text-align:left}
  .row{display:flex;gap:8px;align-items:center}
  .copy-field{display:flex;gap:6px;margin-top:4px}
  .copy-field input{flex:1}
  details{margin-top:14px}
  summary{cursor:pointer;color:var(--mut);font-size:12px}
</style>
</head>
<body>
  <h1>הנפקת קודים — המכחול המכני</h1>
  <div class="sub">כלי מקומי בלבד · הנתונים נשמרים בדפדפן הזה (localStorage). פתח את הקובץ הזה ישירות בדפדפן.</div>
  <div class="wrap">
    <div class="panel">
      <div class="code-box">
        <div class="lbl">הקוד הבא לחלוקה</div>
        <div class="code" id="nextCode">—</div>
      </div>
      <div class="remain"><b id="remain">0</b> קודים פנויים · <span id="issuedCount">0</span> הונפקו · <span id="total">0</span> סה״כ</div>

      <label>שם הנמען</label>
      <input id="name" placeholder="לדוגמה: דנה" />
      <label>אימייל הנמען (לרישום)</label>
      <input id="email" type="email" placeholder="dana@example.com" dir="ltr" />

      <label>שורת נושא (העתק ל-Gmail)</label>
      <div class="copy-field">
        <input id="subject" value="גישת אלפא — המכחול המכני 🎨" readonly />
        <button onclick="copyText(document.getElementById('subject').value,this)">העתק</button>
      </div>

      <div class="btns">
        <button class="primary" id="copyBtn" onclick="copyEmail()">📋 העתק את המייל</button>
        <button id="issueBtn" onclick="markIssued()">✓ סמן כהונפק → הבא</button>
        <button onclick="openGmail()">↗ פתח Gmail</button>
      </div>
      <div class="ok" id="msg"></div>

      <details>
        <summary>הוסף קודים (batch חדש) — הדבק שורה לכל קוד</summary>
        <textarea id="moreCodes" rows="4" placeholder="MB-XXXX-XXXX-XXXX&#10;MB-YYYY-..."></textarea>
        <div class="btns"><button onclick="addCodes()">הוסף לרשימה</button></div>
      </details>

      <details open>
        <summary>יומן הנפקות (<span id="logN">0</span>)</summary>
        <div class="btns" style="margin-top:8px">
          <button onclick="exportCsv()">⬇ ייצוא CSV</button>
          <button onclick="exportJson()">⬇ גיבוי JSON</button>
          <button onclick="importJson()">⬆ שחזור JSON</button>
          <button onclick="resetAll()">🗑 אפס הכל</button>
        </div>
        <table id="logTable"><thead><tr><th>תאריך</th><th>שם</th><th>אימייל</th><th>קוד</th></tr></thead><tbody></tbody></table>
      </details>
    </div>

    <div class="panel">
      <label style="margin-top:0">תצוגה מקדימה של המייל</label>
      <div id="preview"></div>
    </div>
  </div>

<script>
const BASE_CODES = ${JSON.stringify(codes)};
const EMAIL_TPL = ${jsStr(emailTpl)};
const LS = "mb_issue_state_v1";

function load(){ try{return JSON.parse(localStorage.getItem(LS))||{}}catch{return{}} }
function save(s){ localStorage.setItem(LS, JSON.stringify(s)); }
let state = load();
state.issued = state.issued || [];      // [{code,name,email,ts}]
state.extra  = state.extra  || [];      // extra codes added later

function allCodes(){ return BASE_CODES.concat(state.extra.filter(c=>!BASE_CODES.includes(c))); }
function issuedSet(){ return new Set(state.issued.map(i=>i.code)); }
function nextCode(){ const used=issuedSet(); return allCodes().find(c=>!used.has(c)) || null; }

function fillEmail(code,name){
  let h = EMAIL_TPL.split("{{CODE}}").join(code || "—");
  if(name && name.trim()) h = h.split("{{NAME}}").join(name.trim());
  else h = h.split("שלום {{NAME}},").join("שלום,").split("{{NAME}}").join("");
  return h;
}
function bodyOf(html){ return new DOMParser().parseFromString(html,"text/html").body.innerHTML; }

function render(){
  const code = nextCode();
  document.getElementById("nextCode").textContent = code || "אין קודים פנויים!";
  const total = allCodes().length, issued = state.issued.length;
  document.getElementById("remain").textContent = total - issued;
  document.getElementById("issuedCount").textContent = issued;
  document.getElementById("total").textContent = total;
  document.getElementById("copyBtn").disabled = !code;
  document.getElementById("issueBtn").disabled = !code;
  const name = document.getElementById("name").value;
  document.getElementById("preview").innerHTML = bodyOf(fillEmail(code, name));
  // log
  const tb = document.querySelector("#logTable tbody"); tb.innerHTML="";
  state.issued.slice().reverse().forEach(i=>{
    const tr=document.createElement("tr");
    tr.innerHTML='<td>'+new Date(i.ts).toLocaleString("he-IL")+'</td><td>'+(i.name||"—")+'</td><td class="mono">'+(i.email||"—")+'</td><td class="mono">'+i.code+'</td>';
    tb.appendChild(tr);
  });
  document.getElementById("logN").textContent = state.issued.length;
}

function copyEmail(){
  const code = nextCode(); if(!code) return;
  // Select the actual rendered preview and copy it → rich HTML on the clipboard.
  const box = document.getElementById("preview");
  const r=document.createRange(); r.selectNodeContents(box);
  const s=getSelection(); s.removeAllRanges(); s.addRange(r);
  let ok=false; try{ ok=document.execCommand("copy"); }catch{}
  s.removeAllRanges();
  msg(ok ? "✓ הועתק! הדבק ב-Gmail (⌘V) — העיצוב יישמר." : "אם לא הועתק: לחץ בתצוגה המקדימה, ⌘A ואז ⌘C, והדבק.");
}

function copyText(t,btn){ navigator.clipboard?.writeText(t); const o=btn.textContent; btn.textContent="✓"; setTimeout(()=>btn.textContent=o,1200); }

function markIssued(){
  const code = nextCode(); if(!code) return;
  state.issued.push({code, name:document.getElementById("name").value.trim(), email:document.getElementById("email").value.trim(), ts:Date.now()});
  save(state);
  document.getElementById("name").value=""; document.getElementById("email").value="";
  render(); msg("✓ הקוד "+code+" סומן כהונפק. הקוד הבא מוכן.");
}

function openGmail(){
  const to=encodeURIComponent(document.getElementById("email").value);
  const su=encodeURIComponent(document.getElementById("subject").value);
  window.open("https://mail.google.com/mail/?view=cm&fs=1&to="+to+"&su="+su,"_blank");
  msg("נפתח Gmail — הדבק את גוף המייל (אחרי 'העתק את המייל').");
}

function addCodes(){
  const lines=(document.getElementById("moreCodes").value.match(/MB-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g))||[];
  let added=0; lines.forEach(c=>{ if(!allCodes().includes(c)){ state.extra.push(c); added++; }});
  save(state); document.getElementById("moreCodes").value=""; render(); msg("נוספו "+added+" קודים.");
}

function exportCsv(){
  const rows=[["date","name","email","code"]].concat(state.issued.map(i=>[new Date(i.ts).toISOString(),i.name||"",i.email||"",i.code]));
  dl("issued-codes.csv", rows.map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(",")).join("\\n"));
}
function exportJson(){ dl("issue-state-backup.json", JSON.stringify(state,null,2)); }
function importJson(){
  const inp=document.createElement("input"); inp.type="file"; inp.accept=".json";
  inp.onchange=e=>{ const f=e.target.files[0]; const rd=new FileReader(); rd.onload=()=>{ try{ state=JSON.parse(rd.result); state.issued=state.issued||[]; state.extra=state.extra||[]; save(state); render(); msg("שוחזר."); }catch{ msg("קובץ לא תקין."); } }; rd.readAsText(f); };
  inp.click();
}
function resetAll(){ if(confirm("לאפס את כל יומן ההנפקות ולהתחיל מהקוד הראשון? (גבה JSON קודם אם צריך)")){ state={issued:[],extra:[]}; save(state); render(); msg("אופס — מתחילים מחדש."); } }
function dl(name,content){ const b=new Blob([content],{type:"text/plain"}); const a=document.createElement("a"); a.href=URL.createObjectURL(b); a.download=name; a.click(); }
function msg(t){ document.getElementById("msg").textContent=t; }

document.getElementById("name").addEventListener("input",()=>{ const c=nextCode(); document.getElementById("preview").innerHTML=bodyOf(fillEmail(c,document.getElementById("name").value)); });
render();
</script>
</body>
</html>
`;

writeFileSync(path.join(root, "email/issue-tool.html"), html);
console.log("✓ email/issue-tool.html generated (" + codes.length + " codes embedded)");
