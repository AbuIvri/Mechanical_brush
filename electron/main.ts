import { app, BrowserWindow, session, nativeImage, ipcMain, dialog } from "electron";
import { IPC } from "../shared/ipc.js";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerIpcHandlers } from "./ipc/handlers.js";
import { appendLog } from "./log.js";
import { handleOriginalProtocol, registerOriginalScheme, ORIGINAL_SCHEME } from "./ipc/originals.js";

// Has to happen before the app is ready, or the scheme has no CORS and every canvas that
// draws an original becomes unreadable.
registerOriginalScheme();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Locate an asset in dev (project/build) and packaged builds. */
function assetPath(...names: string[]): string | undefined {
  const roots = [
    path.join(process.cwd(), "build"),
    path.join(__dirname, "..", "build"),
    process.resourcesPath ?? "",
  ];
  for (const root of roots) {
    for (const n of names) {
      const p = path.join(root, n);
      if (p && existsSync(p)) return p;
    }
  }
  return undefined;
}

function iconPath(): string | undefined {
  return assetPath("icon.png");
}

// Vite injects these in dev.
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

let mainWin: BrowserWindow | null = null;

// Errors nobody sees go to a log file in the app's own profile (logs/mbrush.log beside the
// settings), so a report from a student's machine can be answered — and a test run, which
// uses a throwaway profile, never writes into the real one.
const logError = (line: string) => appendLog(path.join(app.getPath("userData"), "logs"), line);
process.on("uncaughtException", (e) => {
  console.error(e);
  logError(`[main] uncaught ${e?.stack || e}`);
});
process.on("unhandledRejection", (r) => {
  console.error(r);
  logError(`[main] unhandled rejection ${(r as Error)?.stack || r}`);
});
/** Open documents with unsaved work, as last reported by the renderer. */
let unsavedDocs = 0;
let pendingFile: string | null = null;

function takeFileFromArgs(argv: string[]): string | null {
  const f = argv.find((a) => a.toLowerCase().endsWith(".mbrush") && existsSync(a));
  return f ?? null;
}

function pushOpenFile(p: string) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send("file:openFromOS", p);
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  } else {
    pendingFile = p;
  }
}

// macOS delivers file opens via this event (can fire before ready).
app.on("open-file", (e, p) => {
  e.preventDefault();
  pendingFile = p;
  pushOpenFile(p);
});

// Single instance: forward a file opened while already running (Windows/Linux).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const f = takeFileFromArgs(argv);
    if (f) pushOpenFile(f);
    else if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
}

function applyCsp() {
  // Strict in production; permissive enough for Vite HMR (eval/inline/ws) in dev.
  const policy = DEV_SERVER_URL
    ? "default-src 'self' http://localhost:* ws://localhost:*; " +
      `img-src 'self' data: blob: ${ORIGINAL_SCHEME}:; ` +
      "style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*; " +
      "connect-src 'self' http://localhost:* ws://localhost:*;"
    : `default-src 'self'; img-src 'self' data: blob: ${ORIGINAL_SCHEME}:; ` +
      "style-src 'self' 'unsafe-inline'; " +
      // 'wasm-unsafe-eval' is required by the local MediaPipe segmenter (smart select).
      "script-src 'self' 'wasm-unsafe-eval';";
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    // The splash is our own trusted local page and needs its small inline
    // script (click → IPC); give it a permissive policy.
    const isSplash = details.url.includes("mbrush-splash");
    const effective = isSplash
      ? "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline';"
      : policy;
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [effective],
      },
    });
  });
}

let splash: BrowserWindow | null = null;

function dataUri(file: string | undefined): string | null {
  if (!file) return null;
  try {
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "jpeg" : ext;
    return `data:image/${mime};base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

function createSplash() {
  const bg = dataUri(assetPath("splash.png", "splash.jpg", "splash.jpeg"));
  const hasBg = !!bg;

  // With a background artwork the splash is a landscape card; otherwise a
  // compact branded card. Text is placed in low-detail corners (sky / road).
  const w = hasBg ? 860 : 430;
  const h = hasBg ? 560 : 310;

  const body = hasBg
    ? `<div class="wrap art" style="background-image:url('${bg}')">
         <div class="scrim-top"></div>
         <div class="scrim-bottom"></div>
         <div class="corner">
           <div class="he">המכחול המכני<span class="chip">BETA</span></div>
           <div class="en">The Mechanical Brush</div>
           <div class="ver">גרסה ${app.getVersion()}</div>
           <div class="copy">© 2026 נמרוד פסח סונדרס · כל הזכויות שמורות</div>
         </div>
         <div class="hint-b">לחץ כדי להמשיך ←</div>
       </div>`
    : `<div class="wrap plain">
         <div class="he">המכחול המכני<span class="chip">BETA</span></div>
         <div class="en">The Mechanical Brush</div>
         <div class="ver">גרסה ${app.getVersion()}</div>
         <div class="copy">© 2026 נמרוד פסח סונדרס · כל הזכויות שמורות</div>
         <div class="hint-b">לחץ כדי להמשיך ←</div>
       </div>`;

  const html = `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;overflow:hidden;cursor:pointer;
      font-family:-apple-system,"Heebo","Assistant",sans-serif;color:#fff;}
    .wrap{position:relative;height:100vh;border-radius:14px;overflow:hidden;border:1px solid #2a2f3a;box-sizing:border-box;}
    .art{background-size:cover;background-position:center;}
    .plain{display:flex;flex-direction:column;align-items:center;justify-content:center;
      background:radial-gradient(circle at 50% 34%,#1d212b,#0f1014);}
    .scrim-top{position:absolute;inset:0 0 auto 0;height:42%;
      background:linear-gradient(to bottom,rgba(8,9,12,.72),rgba(8,9,12,0));}
    .scrim-bottom{position:absolute;inset:auto 0 0 0;height:30%;
      background:linear-gradient(to top,rgba(8,9,12,.82),rgba(8,9,12,0));}
    .corner{position:absolute;top:20px;right:26px;text-align:right;max-width:72%;}
    .he{font-size:30px;font-weight:800;color:#fff;text-shadow:0 2px 12px rgba(0,0,0,.85);}
    .en{font-size:14px;color:#e0c08a;letter-spacing:1px;margin-top:2px;text-shadow:0 2px 10px rgba(0,0,0,.85);}
    .ver{font-size:11px;color:#e3e6ec;margin-top:8px;opacity:.95;text-shadow:0 1px 8px rgba(0,0,0,.9);}
    .copy{font-size:11px;color:#e3e6ec;margin-top:6px;text-shadow:0 1px 8px rgba(0,0,0,.95);}
    .chip{font-size:8px;font-weight:700;color:#1a1206;background:#d98a3d;border-radius:3px;padding:1px 5px;margin-inline-end:8px;vertical-align:middle;}
    .hint-b{position:absolute;bottom:16px;inset-inline:24px;text-align:center;font-size:12px;color:#ffd9a3;font-weight:600;animation:pulse 1.4s infinite ease-in-out;text-shadow:0 1px 6px rgba(0,0,0,.85);}
    @keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}
  </style></head><body>${body}
  <script>
    const { ipcRenderer } = require('electron');
    const go = () => ipcRenderer.send('splash-continue');
    window.addEventListener('click', go);
    window.addEventListener('keydown', go);
  </script>
  </body></html>`;

  // Written to a temp file so nodeIntegration (for the click→IPC) works reliably.
  const file = path.join(app.getPath("temp"), `mbrush-splash-${Date.now()}.html`);
  writeFileSync(file, html, "utf-8");

  const win = new BrowserWindow({
    width: w,
    height: h,
    frame: false,
    transparent: !hasBg,
    backgroundColor: hasBg ? "#0f1014" : undefined,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile(file);
  return win;
}

function createWindow() {
  const icon = iconPath();
  const win = (mainWin = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: "#14151a",
    title: "המכחול המכני · The Mechanical Brush",
    icon: icon || undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  }));

  // Reveal the main window only once the user clicked the splash AND the app
  // has finished loading. A long fallback prevents getting stuck.
  let clicked = false;
  let ready = false;
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (!win.isDestroyed()) win.show();
    if (splash && !splash.isDestroyed()) splash.close();
    splash = null;
  };
  const maybeReveal = () => {
    if (clicked && ready) reveal();
  };
  win.once("ready-to-show", () => {
    ready = true;
    maybeReveal();
  });
  ipcMain.once("splash-continue", () => {
    clicked = true;
    maybeReveal();
  });
  setTimeout(reveal, 60000); // safety net

  // Closing the window (or quitting) with unsaved work asks first. It used to just go:
  // the active tab could be recovered at the next launch, every other tab was lost.
  win.on("close", (e) => {
    if (!unsavedDocs) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["צא בלי לשמור", "ביטול"],
      defaultId: 1,
      cancelId: 1,
      message: unsavedDocs === 1 ? "יש עבודה אחת שלא נשמרה" : `יש ${unsavedDocs} עבודות שלא נשמרו`,
      detail: "כדי לשמור: ביטול, ואז ⌘S בכל לשונית. יציאה עכשיו תוותר על השינויים שלא נשמרו.",
    });
    if (choice !== 0) e.preventDefault();
  });

  // Diagnostics: surface renderer errors to the terminal.
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
    logError(`[renderer] did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on("console-message", (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer:${level}] ${message} (${source}:${line})`);
    if (level >= 3) logError(`[renderer] ${message} (${source}:${line})`);
  });
  // The page itself died (out of memory, a GPU fault): the window would stay blank. Say
  // so and offer to reload — unsaved work comes back from its recovery slot.
  win.webContents.on("render-process-gone", (_e, details) => {
    logError(`[renderer] gone: ${details.reason} (exit ${details.exitCode})`);
    if (details.reason === "clean-exit" || win.isDestroyed()) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "error",
      buttons: ["טען מחדש", "סגור"],
      defaultId: 0,
      cancelId: 1,
      message: "התצוגה של המכחול המכני קרסה",
      detail: "טעינה מחדש תחזיר את החלון. עבודה שלא נשמרה תוצע לשחזור מהעותק האוטומטי.",
    });
    if (choice === 0) win.reload();
    else win.destroy();
  });

  if (DEV_SERVER_URL) {
    win.loadURL(DEV_SERVER_URL);
    if (process.env.MBRUSH_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  // Dock icon on macOS during development (packaged builds use the bundle icon).
  const icon = iconPath();
  if (process.platform === "darwin" && icon && app.dock) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(icon));
    } catch {
      /* ignore */
    }
  }
  // First-launch file open (Windows/Linux pass the path in argv).
  if (!pendingFile) pendingFile = takeFileFromArgs(process.argv);

  // Renderer pulls any pending file on startup (avoids a race with open-file).
  ipcMain.handle("file:getPending", async () => {
    const p = pendingFile;
    pendingFile = null;
    return { ok: true, data: p };
  });

  ipcMain.on(IPC.unsavedCount, (_e, n: unknown) => {
    unsavedDocs = Math.max(0, Number(n) || 0);
  });

  applyCsp();
  handleOriginalProtocol();
  registerIpcHandlers();
  splash = createSplash();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
