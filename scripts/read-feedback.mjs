#!/usr/bin/env node
/**
 * Read all feedback notes submitted from the app (stored in your Worker's KV).
 * Run:  node scripts/read-feedback.mjs
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "activation");
const w = (cmd) => execSync(`npx --yes wrangler ${cmd}`, { cwd: dir, encoding: "utf-8" });

let list;
try {
  list = JSON.parse(w(`kv key list --binding CODES --prefix "feedback:" --remote`));
} catch (e) {
  console.error("שגיאה בקריאה מ-KV. ודא שאתה מחובר (wrangler login).");
  process.exit(1);
}

if (!list.length) {
  console.log("אין משובים עדיין. 📭");
  process.exit(0);
}

list.sort((a, b) => (a.name < b.name ? 1 : -1)); // newest first
console.log(`\n📬 ${list.length} משובים:\n`);
for (const k of list) {
  try {
    const v = JSON.parse(w(`kv key get "${k.name}" --binding CODES --remote`));
    console.log("────────────────────────────");
    console.log(
      `${new Date(v.at).toLocaleString("he-IL")} · ${v.platform || "?"} v${v.version || "?"}` +
        (v.email ? ` · ${v.email}` : ""),
    );
    console.log(v.message);
  } catch {
    /* skip */
  }
}
console.log("");
