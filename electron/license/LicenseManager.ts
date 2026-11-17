import { app } from "electron";
import crypto from "node:crypto";
import os from "node:os";
import { execSync } from "node:child_process";
import { promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../ipc/atomicWrite.js";

/**
 * Online, single-use, machine-bound activation.
 *
 * Flow:
 *  1. User enters a code → app POSTs {code, machineId} to the activation Worker.
 *  2. Worker checks the code pool (KV): unknown → reject; unused → bind to this
 *     machine; used by another machine → reject; used by this machine → allow.
 *  3. Worker returns a RECEIPT signed (Ed25519) with the server private key.
 *  4. App verifies the receipt with the embedded PUBLIC key, checks it is bound
 *     to THIS machine, and caches it. Every launch re-verifies offline, so a
 *     copied license file won't work on another machine.
 */

// ⬇️ After deploying the Worker, put its URL here (or set MBRUSH_ACTIVATION_URL).
const ACTIVATION_URL =
  process.env.MBRUSH_ACTIVATION_URL || "https://mbrush-activation.saundersnp.workers.dev";

// Public key matching the server's signing key (same Ed25519 pair).
const PUBLIC_KEY_DER_B64 = "MCowBQYDK2VwAyEAh8tLKK1nbOfPx5ZKrSU27fEctrYS8KeS22qLBFZk16I=";

export interface LicenseStatus {
  activated: boolean;
  name?: string;
  machineId?: string;
  reason?: string;
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function publicKey() {
  return crypto.createPublicKey({
    key: Buffer.from(PUBLIC_KEY_DER_B64, "base64"),
    format: "der",
    type: "spki",
  });
}

export class LicenseManager {
  private file = path.join(app.getPath("userData"), "license.json");
  private machineFile = path.join(app.getPath("userData"), "machine.id");

  /** Stable per-machine id (hashed hardware id, with a persistent fallback). */
  machineId(): string {
    let raw = "";
    try {
      if (process.platform === "darwin") {
        raw =
          execSync("ioreg -rd1 -c IOPlatformExpertDevice", { timeout: 4000 })
            .toString()
            .match(/IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || "";
      } else if (process.platform === "win32") {
        raw =
          execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', {
            timeout: 4000,
          })
            .toString()
            .match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i)?.[1] || "";
      } else {
        raw = readFileSync("/etc/machine-id", "utf-8").trim();
      }
    } catch {
      /* fall through */
    }
    if (!raw) {
      // Persistent random fallback so the id stays stable on this install.
      try {
        raw = readFileSync(this.machineFile, "utf-8").trim();
      } catch {
        raw = crypto.randomUUID();
        try {
          writeFileSync(this.machineFile, raw, { mode: 0o600 });
        } catch {
          /* ignore */
        }
      }
    }
    return crypto.createHash("sha256").update("mbrush:" + raw).digest("hex").slice(0, 32);
  }

  /** Verify a signed receipt against the embedded key + this machine. */
  private verifyReceipt(receipt: string, machineId: string): { valid: boolean; name?: string; reason?: string } {
    try {
      const dot = receipt.indexOf(".");
      if (dot < 0) return { valid: false, reason: "קבלה לא תקינה" };
      const payloadBytes = b64urlDecode(receipt.slice(0, dot));
      const sig = b64urlDecode(receipt.slice(dot + 1));
      if (!crypto.verify(null, payloadBytes, publicKey(), sig)) {
        return { valid: false, reason: "חתימת הקבלה אינה תקפה" };
      }
      const payload = JSON.parse(payloadBytes.toString("utf-8"));
      if (payload.machineId !== machineId) {
        return { valid: false, reason: "הרישיון משויך למחשב אחר" };
      }
      if (payload.exp && Date.now() > payload.exp) {
        return { valid: false, reason: "תוקף הרישיון פג" };
      }
      return { valid: true, name: payload.name };
    } catch {
      return { valid: false, reason: "קבלה פגומה" };
    }
  }

  async activate(code: string): Promise<LicenseStatus> {
    const machineId = this.machineId();
    let data: any;
    try {
      const resp = await fetch(`${ACTIVATION_URL.replace(/\/$/, "")}/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: (code || "").trim(), machineId }),
        signal: AbortSignal.timeout(15000),
      });
      data = await resp.json();
    } catch {
      return { activated: false, reason: "אין חיבור לשרת ההפעלה. בדוק אינטרנט ונסה שוב." };
    }
    if (!data?.ok || !data.receipt) {
      return { activated: false, reason: data?.error || "ההפעלה נכשלה" };
    }
    const v = this.verifyReceipt(data.receipt, machineId);
    if (!v.valid) return { activated: false, reason: v.reason };
    await writeFileAtomic(
      this.file,
      JSON.stringify({ receipt: data.receipt, activatedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    return { activated: true, name: v.name, machineId };
  }

  async status(): Promise<LicenseStatus> {
    // Development builds are never gated (only packaged apps enforce licensing).
    if (!app.isPackaged) return { activated: true, name: "Developer (dev)" };
    try {
      const { receipt } = JSON.parse(await fs.readFile(this.file, "utf-8"));
      const v = this.verifyReceipt(receipt, this.machineId());
      if (!v.valid) return { activated: false, reason: v.reason };
      return { activated: true, name: v.name };
    } catch {
      return { activated: false };
    }
  }

  async deactivate() {
    try {
      await fs.unlink(this.file);
    } catch {
      /* ignore */
    }
  }
}

export const licenseManager = new LicenseManager();
