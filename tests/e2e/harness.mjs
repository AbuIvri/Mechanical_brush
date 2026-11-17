// End-to-end harness: the real app, driven through its own store, with no engine and no
// side effects outside a throwaway folder.
//
// - Main and preload are built from the current source (vite build), then loaded the way
//   `npm run dev` loads them: VITE_DEV_SERVER_URL pointing at a Vite server. That server is
//   started here WITHOUT vite-plugin-electron, which would launch an Electron of its own.
// - Every run gets a fresh --user-data-dir under the OS temp folder: no API keys, no
//   license, no recents, nothing from the real profile.
// - `generate:run` is replaced inside the main process by a stub that answers with a solid
//   image of the right size and records what was asked. Nothing is sent to any engine,
//   nothing is billed, and nothing is written to ~/Pictures (the archive lives in the real
//   handler, which the stub replaces). `file:exportImage` is replaced the same way, so
//   exports land in the run's own folder instead of opening a save dialog.
// - Tests reach the store by importing the very module the app imported
//   (/src/state/store.ts on the Vite server): no test hook in the app's source.

import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { _electron } from "playwright-core";
import electronPath from "electron";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function buildMain() {
  execSync("npx vite build", { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

export async function startRenderer() {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: "error",
    plugins: [react()],
    server: { host: "localhost", port: 5199, strictPort: false, hmr: false },
  });
  await server.listen();
  const port = server.config.server.port ?? server.httpServer.address().port;
  return { server, url: `http://localhost:${server.httpServer.address().port ?? port}/` };
}

export function freshProfile() {
  // Real path: on macOS the temp folder is reached through /var → /private/var, and the
  // safety check below compares paths.
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mbrush-e2e-")));
  mkdirSync(path.join(dir, "out"), { recursive: true });
  return { userData: path.join(dir, "profile"), out: path.join(dir, "out"), root: dir };
}

/** Launch the app on a profile; returns { app, page, S } once the store is initialised. */
export async function launch(rendererUrl, profile, opts = {}) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [ROOT, `--user-data-dir=${profile.userData}`],
    env: { ...process.env, VITE_DEV_SERVER_URL: rendererUrl },
    timeout: 60_000,
  });
  const actualUserData = await app.evaluate(({ app }) => app.getPath("userData"));
  if (path.resolve(actualUserData) !== path.resolve(profile.userData)) {
    await app.close();
    throw new Error(`refusing to run: userData is ${actualUserData}, not the throwaway profile`);
  }
  await installStubs(app, profile.out, opts);

  let page = null;
  for (let i = 0; i < 200 && !page; i++) {
    page = app.windows().find((w) => w.url().startsWith(rendererUrl)) ?? null;
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw new Error("main window never appeared");
  // Past the splash, as a click on it would.
  await app.evaluate(({ ipcMain }) => ipcMain.emit("splash-continue", {}));

  page.__dialogs = [];
  page.__dialogAnswer = true;
  page.on("dialog", (d) => {
    page.__dialogs.push(d.message());
    void (page.__dialogAnswer ? d.accept() : d.dismiss());
  });
  await page.waitForLoadState("domcontentloaded");
  await ready(page);
  return { app, page };
}

/** The store module, made reachable for page.evaluate, and helpers for making images. */
export async function ready(page) {
  await page.waitForFunction(async () => {
    const m = await import("/src/state/store.ts");
    window.__S = m.useStore;
    const st = m.useStore.getState();
    return st.providers.length > 0 && !!st.activeDocId && st.configuredKeys.includes("umage2");
  }, null, { timeout: 60_000, polling: 250 });
  await page.evaluate(() => {
    window.__S.setState({ onboarding: false });
    window.__S.getState().setProvider("umage2");
    /** A deterministic, non-uniform picture: a gradient with a grid, so crops are checkable. */
    window.__img = (w, h, type = "image/png") => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, "#1d4f91");
      g.addColorStop(0.5, "#e2c044");
      g.addColorStop(1, "#7a1f3d");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
      x.fillStyle = "rgba(255,255,255,0.6)";
      for (let i = 0; i < w; i += 97) x.fillRect(i, 0, 3, h);
      for (let j = 0; j < h; j += 89) x.fillRect(0, j, w, 3);
      return c.toDataURL(type, 0.95);
    };
    window.__solid = (w, h, color) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      x.fillStyle = color;
      x.fillRect(0, 0, w, h);
      return c.toDataURL("image/png");
    };
  });
}

async function installStubs(app, outDir, opts = {}) {
  if (opts.realEngine) {
    // The app's own generate handler, for checks of what IT writes — on the offline Mock
    // engine only. Its archive goes to ~/Pictures, so that path is moved into the run's
    // folder first, and the move is verified before anything can be generated.
    const pictures = path.join(outDir, "pictures");
    mkdirSync(pictures, { recursive: true });
    const now = await app.evaluate(({ app }, p) => {
      app.setPath("pictures", p);
      return app.getPath("pictures");
    }, pictures);
    if (path.resolve(now) !== path.resolve(pictures)) throw new Error(`refusing to run: pictures is ${now}`);
  }
  await app.evaluate(({ ipcMain, nativeImage, dialog }, [out, realEngine]) => {
    // The "unsaved work" question on closing the window: answered here instead of on
    // screen (a real modal would hang the run), and recorded so a scenario can check it.
    globalThis.__quit = { asked: [], choice: 0 };
    dialog.showMessageBoxSync = (...a) => {
      globalThis.__quit.asked.push(a[a.length - 1]?.message ?? "");
      return globalThis.__quit.choice;
    };
    // The main process is ESM: no `require` here, but Node can hand over its own modules.
    const fs = process.getBuiltinModule("node:fs");
    const nodePath = process.getBuiltinModule("node:path");
    globalThis.__reqs = [];
    globalThis.__stub = { delayMs: 0, fail: null };
    if (!realEngine) ipcMain.removeHandler("generate:run");
    if (!realEngine) ipcMain.handle("generate:run", async (_e, req) => {
      const stub = globalThis.__stub;
      let w = 1024;
      let h = 1024;
      const rec = {
        mode: req.mode,
        providerId: req.providerId,
        modelId: req.modelId,
        prompt: req.prompt ?? "",
        refs: (req.references ?? []).length,
        hasMask: !!req.mask,
        settings: req.settings ?? {},
      };
      if (req.image) {
        const s = nativeImage.createFromDataURL(req.image).getSize();
        w = s.width;
        h = s.height;
        rec.imageSize = [w, h];
      } else {
        const ar = String(req.settings?.aspectRatio ?? "auto");
        const [a, b] = ar.split(":").map(Number);
        if (a > 0 && b > 0) h = Math.round((w * b) / a);
      }
      globalThis.__reqs.push(rec);
      if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
      if (stub.fail) return { ok: false, error: stub.fail };
      // BGRA, a muted red: distinguishable from every colour in the test pictures.
      const buf = Buffer.alloc(w * h * 4);
      for (let i = 0; i < buf.length; i += 4) {
        buf[i] = 40;
        buf[i + 1] = 40;
        buf[i + 2] = 200;
        buf[i + 3] = 255;
      }
      const png = nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG();
      return {
        ok: true,
        data: {
          id: `stub-${globalThis.__reqs.length}`,
          providerId: req.providerId,
          modelId: req.modelId,
          images: [{ src: `data:image/png;base64,${png.toString("base64")}`, width: w, height: h }],
          metadata: { costEstimate: 0.01, latencyMs: 1 },
        },
      };
    });
    // Engines "have keys", so the app takes its normal paths — no key exists anywhere in
    // this profile, and the stub above is all that ever answers a generation.
    ipcMain.removeHandler("key:list");
    ipcMain.handle("key:list", async () => ({ ok: true, data: ["umage2", "ideogram", "nano-banana", "reve", "grok", "crystal"] }));
    ipcMain.removeHandler("file:exportImage");
    ipcMain.handle("file:exportImage", async (_e, dataUrl, suggestedName) => {
      const m = /^data:[^;]+;base64,(.*)$/s.exec(dataUrl);
      if (!m) return { ok: false, error: "bad data url" };
      const file = nodePath.join(out, nodePath.basename(String(suggestedName || "export.png")));
      fs.writeFileSync(file, Buffer.from(m[1], "base64"));
      return { ok: true, data: { path: file } };
    });
  }, [outDir, !!opts.realEngine]);
}

export async function requests(app) {
  return app.evaluate(() => globalThis.__reqs);
}
export async function clearRequests(app) {
  await app.evaluate(() => {
    globalThis.__reqs = [];
    globalThis.__stub = { delayMs: 0, fail: null };
  });
}
export async function stub(app, patch) {
  await app.evaluate((_e, p) => Object.assign(globalThis.__stub, p), patch);
}
