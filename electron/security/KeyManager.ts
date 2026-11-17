import { app, safeStorage } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../ipc/atomicWrite.js";

/**
 * Stores per-provider API keys encrypted at rest.
 * Uses Electron safeStorage, which is backed by the OS keychain
 * (macOS Keychain / Windows DPAPI / libsecret) when available.
 * Keys are NEVER written to project files or logs.
 */
export class KeyManager {
  private file: string;
  private cache: Record<string, string> = {};
  private loaded = false;

  constructor() {
    this.file = path.join(app.getPath("userData"), "credentials.enc.json");
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      const store: Record<string, string> = JSON.parse(raw);
      for (const [provider, enc] of Object.entries(store)) {
        try {
          if (safeStorage.isEncryptionAvailable()) {
            this.cache[provider] = safeStorage.decryptString(Buffer.from(enc, "base64"));
          } else {
            // Fallback: stored as base64 plaintext (warned in UI).
            this.cache[provider] = Buffer.from(enc, "base64").toString("utf-8");
          }
        } catch {
          /* skip corrupt entry */
        }
      }
    } catch {
      /* no file yet */
    }
  }

  private async persist() {
    const store: Record<string, string> = {};
    for (const [provider, key] of Object.entries(this.cache)) {
      const buf = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(key)
        : Buffer.from(key, "utf-8");
      store[provider] = buf.toString("base64");
    }
    // Atomic: a write cut short would otherwise lose every key at once.
    await writeFileAtomic(this.file, JSON.stringify(store), { mode: 0o600 });
  }

  isSecure(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async get(providerId: string): Promise<string | undefined> {
    await this.load();
    return this.cache[providerId];
  }

  async set(providerId: string, key: string) {
    await this.load();
    this.cache[providerId] = key;
    await this.persist();
  }

  async remove(providerId: string) {
    await this.load();
    delete this.cache[providerId];
    await this.persist();
  }

  async listConfigured(): Promise<string[]> {
    await this.load();
    return Object.keys(this.cache);
  }
}

export const keyManager = new KeyManager();
