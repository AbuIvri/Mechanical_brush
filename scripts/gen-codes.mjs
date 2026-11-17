#!/usr/bin/env node
/**
 * Generate a pool of activation codes for "The Mechanical Brush".
 *
 * Usage:
 *   node scripts/gen-codes.mjs [count] [--name "Batch label"] [--days N]
 *
 * Outputs (in ./license-codes/):
 *   codes-<timestamp>.txt   — human list to hand out
 *   kv-seed-<timestamp>.json — upload to Cloudflare KV:
 *       npx wrangler kv bulk put license-codes/kv-seed-XXX.json --binding CODES --remote
 *     (run from server/activation/, after creating the CODES namespace)
 */
import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const args = process.argv.slice(2);
const count = Number(args.find((a) => /^\d+$/.test(a))) || 25;
const nameIdx = args.indexOf("--name");
const name = nameIdx >= 0 ? args[nameIdx + 1] : null;
const daysIdx = args.indexOf("--days");
const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) : null;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
function block() {
  let s = "";
  for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}
function makeCode() {
  return `MB-${block()}-${block()}-${block()}`;
}

const exp = days ? Date.now() + days * 86400000 : null;
const codes = new Set();
while (codes.size < count) codes.add(makeCode());

const list = [...codes];
const kv = list.map((code) => ({
  key: "code:" + code,
  value: JSON.stringify({ name: name || null, exp }),
}));

const outDir = path.join(root, "license-codes");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const txtPath = path.join(outDir, `codes-${stamp}.txt`);
const kvPath = path.join(outDir, `kv-seed-${stamp}.json`);

writeFileSync(txtPath, list.join("\n") + "\n");
writeFileSync(kvPath, JSON.stringify(kv, null, 2));

console.log(`\n✅ נוצרו ${count} קודים${name ? ` (${name})` : ""}${days ? `, תוקף ${days} ימים` : ""}`);
console.log(`📄 רשימה לחלוקה:  ${txtPath}`);
console.log(`☁️  לטעינה ל-KV:   ${kvPath}`);
console.log(`\nהעלאה ל-KV (מתוך server/activation):`);
console.log(`  npx wrangler kv bulk put "${kvPath}" --binding CODES --remote\n`);
