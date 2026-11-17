// Smoke test of the PACKAGED app on a throwaway profile: it starts, the page loads, the
// licence gate appears (fresh profile = no licence), the version reads the package version.
import { _electron } from "playwright-core";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const exe = process.argv[2];
const prof = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mbrush-smoke-")));
const app = await _electron.launch({ executablePath: exe, args: ["--user-data-dir=" + path.join(prof, "profile")] });
const ud = await app.evaluate(({ app }) => app.getPath("userData"));
if (!realpathSync(path.dirname(ud)).startsWith(prof)) { await app.close(); throw new Error("not the throwaway profile: " + ud); }
const t0 = Date.now();
let page = null;
while (Date.now() - t0 < 30000 && !page) {
  for (const w of app.windows()) if (/index\.html/.test(w.url())) page = w;
  if (!page) await new Promise((r) => setTimeout(r, 300));
}
if (!page) throw new Error("main window never loaded");
await page.waitForFunction(() => document.querySelector("#root")?.children.length > 0, null, { timeout: 30000 });
const info = await page.evaluate(() => ({ title: document.title, gate: !!document.querySelector(".code-input"), text: document.body.innerText.slice(0, 120).replace(/\s+/g, " ") }));
const ver = await app.evaluate(({ app }) => app.getVersion());
console.log("SMOKE", JSON.stringify({ ver, ...info }));
await app.close();
rmSync(prof, { recursive: true, force: true });
