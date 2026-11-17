// Generates email/resend-tool.html — a local admin tool for re-sending EXISTING codes
// to people who were given one and never activated it.
//
// Different from gen-issue-tool.mjs: that one hands out NEW codes from a fresh batch.
// This one repeats a code somebody already has, so the pairing must come from a file
// rather than from "the next unused code".
//
// Input:  license-codes/never-activated.csv  (email,code)
// Run:    node scripts/gen-resend-tool.mjs
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tpl = readFileSync(path.join(root, "email/reminder-email.html"), "utf8");

const csv = readFileSync(path.join(root, "license-codes/never-activated.csv"), "utf8");
const people = csv
  .split(/\r?\n/)
  .slice(1)
  .filter((l) => l.trim())
  .map((l) => {
    const [email, code] = l.split(",").map((s) => s.trim());
    // No real names in the data. A username scraped from the address ("ggmedia2010")
    // reads worse than no name at all, so the greeting starts nameless and the tool
    // lets you type one where you know it.
    return { email, code, name: "" };
  });

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const html = `<!doctype html>
<html dir="rtl" lang="he"><head><meta charset="utf-8" />
<title>שליחה חוזרת · המכחול המכני</title>
<style>
  body{font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;background:#0b0c0f;color:#e6e8ee;margin:0;padding:26px}
  h1{font-size:19px;margin:0 0 4px;color:#d98a3d}
  .sub{color:#8a91a0;font-size:13px;margin-bottom:20px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:9px 10px;border-bottom:1px solid #2a2f3a;text-align:right}
  th{color:#8a91a0;font-weight:600;font-size:12px}
  code{font-family:ui-monospace,Menlo,monospace;color:#e6c79a;direction:ltr;display:inline-block}
  button{background:#22242c;color:#fff;border:1px solid #3a3f4a;border-radius:7px;padding:6px 12px;cursor:pointer;font-family:inherit;font-size:12px}
  button:hover{border-color:#d98a3d}
  button.done{background:#1c3324;border-color:#2f6b45;color:#9fe0b8}
  .em{color:#b9bfca;direction:ltr;display:inline-block}
  .bar{margin-bottom:16px;color:#8a91a0;font-size:13px}
  .bar b{color:#e6e8ee}
</style></head><body>
<h1>שליחה חוזרת — מי שקיבל קוד ולא הפעיל</h1>
<div class="sub">כל שורה מייצרת את המייל עם <b>הקוד המקורי של אותו אדם</b>. לחיצה על "העתק מייל" מעתיקה HTML מעוצב — הדבק ישירות ב-Gmail. הסימון נשמר בדפדפן הזה.</div>
<div class="bar"><b id="doneN">0</b> מתוך <b>${people.length}</b> נשלחו · <button onclick="reset()">אפס סימונים</button></div>
<table><thead><tr><th>#</th><th>אימייל</th><th>קוד</th><th>שם</th><th></th><th></th></tr></thead><tbody>
${people
  .map(
    (p, i) => `<tr>
  <td>${i + 1}</td>
  <td><span class="em">${esc(p.email)}</span></td>
  <td><code>${esc(p.code)}</code></td>
  <td><input id="n${i}" placeholder="שם (לא חובה)" oninput="saveName(${i},this.value)" style="background:#15161c;border:1px solid #2a2f3a;border-radius:6px;color:#e6e8ee;padding:5px 8px;font-family:inherit;font-size:12px;width:120px" /></td>
  <td><button onclick="copyMail(${i})">📋 העתק מייל</button></td>
  <td><button id="m${i}" onclick="mark(${i})">סמן כנשלח</button></td>
</tr>`,
  )
  .join("\n")}
</tbody></table>

<script>
const PEOPLE = ${JSON.stringify(people)};
const TPL = ${JSON.stringify(tpl)};
const LS = "mb_resend_state_v1";
let sent = (()=>{try{return JSON.parse(localStorage.getItem(LS))||[]}catch{return[]}})();
const LSN = "mb_resend_names_v1";
let names = (()=>{try{return JSON.parse(localStorage.getItem(LSN))||{}}catch{return{}}})();
function saveName(i,v){ names[PEOPLE[i].email]=v.trim(); localStorage.setItem(LSN, JSON.stringify(names)); }

function render(){
  document.getElementById("doneN").textContent = sent.length;
  PEOPLE.forEach((p,i)=>{
    const inp=document.getElementById("n"+i); if(inp && names[p.email]) inp.value=names[p.email];
    const b=document.getElementById("m"+i);
    const on=sent.includes(p.email);
    b.textContent = on ? "✓ נשלח" : "סמן כנשלח";
    b.className = on ? "done" : "";
  });
}
function mark(i){
  const e=PEOPLE[i].email;
  sent = sent.includes(e) ? sent.filter(x=>x!==e) : [...sent,e];
  localStorage.setItem(LS, JSON.stringify(sent)); render();
}
function reset(){ if(confirm("לאפס את כל הסימונים?")){ sent=[]; localStorage.setItem(LS,"[]"); render(); } }
async function copyMail(i){
  const p=PEOPLE[i];
  const nm = (names[p.email]||"").trim();
  // With no name the greeting must read "שלום 👋", not "שלום  👋".
  const html = TPL
    .replace(/שלום \\{\\{NAME\\}\\} 👋/g, nm ? ("שלום " + nm + " 👋") : "שלום 👋")
    .replace(/\\{\\{NAME\\}\\}/g, nm)
    .replace(/\\{\\{CODE\\}\\}/g, p.code);
  const body = html.replace(/^[\\s\\S]*?<body[^>]*>/i,"").replace(/<\\/body>[\\s\\S]*$/i,"");
  try{
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([body],{type:"text/html"}),
      "text/plain": new Blob([p.code],{type:"text/plain"})
    })]);
    alert("הועתק. פתח Compose ב-Gmail והדבק.\\n\\nאל: " + p.email);
  }catch(err){
    const w=window.open("","_blank"); w.document.write(body); w.document.close();
    alert("ההעתקה האוטומטית נחסמה. נפתח חלון עם המייל — בחר הכל (⌘A), העתק (⌘C) והדבק ב-Gmail.\\n\\nאל: " + p.email);
  }
}
render();
</script>
</body></html>`;

writeFileSync(path.join(root, "email/resend-tool.html"), html);
console.log(`✓ email/resend-tool.html generated (${people.length} recipients)`);
