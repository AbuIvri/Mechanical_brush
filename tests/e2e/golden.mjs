// The golden scenarios: what the app must keep doing, checked end to end.
//
//   npm run test:e2e                     build main, run everything
//   npm run test:e2e -- --no-build       reuse dist-electron as it is
//   npm run test:e2e -- --update-baseline  re-record what the engine is sent
//   npm run test:e2e -- --only=piece,tabs  run some scenarios
//   npm run test:e2e -- --keep           leave the temp profiles for inspection
//   MBRUSH_E2E_PROJECTS=/a.mbrush:/b.mbrush npm run test:e2e
//                                        also round-trip real projects (copies only)
//
// No engine is called and nothing outside a temp folder is written; see harness.mjs.

import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { ROOT, buildMain, startRenderer, freshProfile, launch, ready, requests, clearRequests, stub } from "./harness.mjs";

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const BASELINE = path.join(ROOT, "tests", "e2e", "baseline-requests.json");

const results = [];
const profiles = []; // removed at the end unless --keep
const sent = {}; // scenario → what the engine was asked, for the contract check

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`${msg}\n    got:      ${ja.slice(0, 400)}\n    expected: ${jb.slice(0, 400)}`);
}

/** What a request is, minus nothing: prompt, sizes, settings, references, mask. */
function summarize(reqs) {
  return reqs.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------- page helpers
const S = (page, fn, arg) => page.evaluate(fn, arg);

async function reset(ctx) {
  await ctx.page.reload();
  await ready(ctx.page);
  await clearRequests(ctx.app);
  ctx.page.__dialogs.length = 0;
  ctx.page.__dialogAnswer = true;
}

async function freshProject(page, w = 1600, h = 1000, name = "base.png") {
  await S(page, async ([w, h, name]) => {
    await window.__S.getState().newProjectFromImage(name, window.__img(w, h));
  }, [w, h, name]);
}

const summary = (page) =>
  S(page, () => {
    const s = window.__S.getState();
    const p = s.project;
    if (!p) return null;
    return {
      canvas: { w: p.canvas.width, h: p.canvas.height },
      layers: p.layers.map((l) => ({ id: l.id, name: l.name, x: l.x, y: l.y, w: l.width, h: l.height, visible: l.visible })),
      jobs: p.jobs.length,
      rects: s.mask.rects.length,
    };
  });

const errorOf = (page) => S(page, () => window.__S.getState().error);

// ---------------------------------------------------------------- scenarios
const scenarios = {
  async open(ctx) {
    await freshProject(ctx.page, 1600, 1000);
    const s = await summary(ctx.page);
    eq(s.canvas, { w: 1600, h: 1000 }, "canvas size");
    eq(s.layers.length, 1, "one base layer");
    eq([s.layers[0].w, s.layers[0].h], [1600, 1000], "base layer size");
    // It opens in the middle of the canvas, not against one side.
    await ctx.page.waitForTimeout(400);
    const off = await S(ctx.page, () => {
      const st = window.__S.getState();
      const host = document.querySelector(".canvas-host");
      const { width, height } = st.project.canvas;
      return {
        x: Math.abs(st.panX + (width * st.zoom) / 2 - host.clientWidth / 2),
        y: Math.abs(st.panY + (height * st.zoom) / 2 - host.clientHeight / 2),
        fits: width * st.zoom <= host.clientWidth && height * st.zoom <= host.clientHeight,
        dirty: st.dirty,
      };
    });
    assert(off.fits, "the test image should fit the view");
    assert(off.x <= 2 && off.y <= 2, `the image is ${off.x.toFixed(1)}px / ${off.y.toFixed(1)}px off centre`);
    eq(off.dirty, false, "centring is not an edit");
  },

  async modes(ctx) {
    const cases = [
      { mode: "upscale", prompt: "" },
      { mode: "recreate", prompt: "make it evening" },
      { mode: "generate", prompt: "a red ball on grass" },
      { mode: "removebg", prompt: "" },
      { mode: "fill", prompt: "a round window", rect: { x: 400, y: 300, w: 300, h: 200 } },
      { mode: "expand", prompt: "", settings: { expandDir: "right", expandAmount: 25 } },
      { mode: "ratio", prompt: "", settings: { ratioTarget: "1:1" } },
    ];
    const asked = [];
    for (const c of cases) {
      await reset(ctx);
      await freshProject(ctx.page);
      const before = await summary(ctx.page);
      await S(ctx.page, async (c) => {
        const st = window.__S.getState();
        st.setMode(c.mode);
        st.setPrompt(c.prompt);
        if (c.settings) st.updateSettings(c.settings);
        if (c.rect) st.addRect(c.rect);
        await window.__S.getState().generate();
      }, c);
      const err = await errorOf(ctx.page);
      assert(!err, `${c.mode}: error "${err}"`);
      const after = await summary(ctx.page);
      assert(after.layers.length > before.layers.length, `${c.mode}: no layer added`);
      const busy = await S(ctx.page, () => window.__S.getState().busy);
      assert(!busy, `${c.mode}: still busy`);
      const reqs = await requests(ctx.app);
      assert(reqs.length >= 1, `${c.mode}: engine never asked`);
      if (c.mode === "fill") {
        const l = after.layers[after.layers.length - 1];
        const r = c.rect;
        assert(l.x <= r.x && l.y <= r.y && l.x + l.w >= r.x + r.w && l.y + l.h >= r.y + r.h, "fill: patch does not cover the marked area");
        assert(l.w < after.canvas.w && l.h < after.canvas.h, "fill: patch is the whole canvas, not a patch");
        // By design: an ordinary fill edits the crop in place and sends no mask (the mask
        // only composites the result back). Only the erase brush sends one.
        assert(!reqs[0].hasMask, "fill: a mask was sent — ordinary fill edits in place without one");
      }
      asked.push({ mode: c.mode, requests: summarize(reqs) });
    }
    sent.modes = asked;
  },

  async erase(ctx) {
    await freshProject(ctx.page);
    const areas = await S(ctx.page, async () => {
      const st = window.__S.getState();
      st.addRemoveStroke({ tool: "brush", size: 60, points: [200, 200, 260, 230], hardness: 100 });
      st.addRemoveStroke({ tool: "brush", size: 60, points: [1200, 700, 1260, 720], hardness: 100 });
      return window.__S.getState().planErase();
    });
    eq(areas, 2, "two separate painted areas");
    const before = await summary(ctx.page);
    await S(ctx.page, () => window.__S.getState().runErase("areas"));
    assert(!(await errorOf(ctx.page)), `erase per area: ${await errorOf(ctx.page)}`);
    const perArea = await requests(ctx.app);
    eq(perArea.map((r) => r.mode), ["fill", "fill"], "one fill per area");
    eq(perArea.map((r) => r.hasMask), [true, true], "erase tells a mask-taking engine exactly what to remove");
    const after = await summary(ctx.page);
    eq(after.layers.length, before.layers.length + 2, "a patch layer per area");
    const left = await S(ctx.page, () => window.__S.getState().removeMask.strokes.length + window.__S.getState().removeMask.bitmaps.length);
    eq(left, 0, "erase paint cleared after success");

    await reset(ctx);
    await freshProject(ctx.page);
    await S(ctx.page, async () => {
      const st = window.__S.getState();
      st.addRemoveStroke({ tool: "brush", size: 60, points: [200, 200, 260, 230], hardness: 100 });
      await window.__S.getState().runErase("whole");
    });
    const whole = await requests(ctx.app);
    eq(whole.map((r) => r.mode), ["recreate"], "one recreate for the whole image");
    sent.erase = { perArea: summarize(perArea), whole: summarize(whole) };
  },

  async pins(ctx) {
    await freshProject(ctx.page);
    await S(ctx.page, async () => {
      const st = window.__S.getState();
      st.addAnnotation({ kind: "pin", x: 800, y: 500, n: 1, note: "make it red", color: "#ff3b30" });
      st.setMode("recreate");
      st.setPrompt("📍1 make it red");
      await window.__S.getState().generate();
    });
    assert(!(await errorOf(ctx.page)), `pin run: ${await errorOf(ctx.page)}`);
    const reqs = await requests(ctx.app);
    eq(reqs.length, 1, "one request");
    assert(/pin 1 \(x: ?50(\.0)?%, y: ?50(\.0)?%\)/.test(reqs[0].prompt), `pin not expanded to coordinates: ${reqs[0].prompt.slice(0, 200)}`);
    assert(!reqs[0].prompt.includes("📍"), "raw pin emoji went to the engine");
    sent.pins = summarize(reqs);
  },

  async undo(ctx) {
    await freshProject(ctx.page);
    const s0 = await summary(ctx.page);
    const steps = [];
    const ops = [
      () => window.__S.getState().addRect({ x: 10, y: 10, w: 100, h: 100 }),
      () => window.__S.getState().addRect({ x: 300, y: 300, w: 100, h: 50 }),
      async () => window.__S.getState().duplicateLayer(window.__S.getState().activeLayerId),
      () => {
        const s = window.__S.getState();
        s.moveLayer(s.project.layers[s.project.layers.length - 1].id, -1);
      },
      () => {
        const s = window.__S.getState();
        s.deleteLayer(s.project.layers[0].id);
      },
    ];
    for (const op of ops) {
      await ctx.page.evaluate(`(${op.toString()})()`);
      steps.push(await summary(ctx.page));
    }
    for (let i = 0; i < ops.length; i++) await S(ctx.page, () => window.__S.getState().undo());
    eq(await summary(ctx.page), s0, "five undos return to the start");
    for (let i = 0; i < ops.length; i++) await S(ctx.page, () => window.__S.getState().redo());
    eq(await summary(ctx.page), steps[steps.length - 1], "five redos return to the end");
  },

  async save(ctx) {
    await freshProject(ctx.page);
    await S(ctx.page, async () => {
      const st = window.__S.getState();
      st.setMode("fill");
      st.setPrompt("a round window");
      st.addRect({ x: 400, y: 300, w: 300, h: 200 });
      await window.__S.getState().generate();
    });
    const file = path.join(ctx.profile.out, "round-trip.mbrush");
    await S(ctx.page, async (file) => {
      window.__S.setState({ filePath: file });
      await window.__S.getState().saveProject(false);
    }, file);
    assert(existsSync(file), "project file not written");
    const json = JSON.parse(readFileSync(file, "utf8"));
    eq([json.format, json.version], ["mechanical-brush-project", 1], ".mbrush header");
    const a = await summary(ctx.page);
    const dirty = await S(ctx.page, () => window.__S.getState().dirty);
    eq(dirty, false, "clean after save");
    // Saving over it keeps the version it replaces, whole, as .bak.
    const first = readFileSync(file);
    await S(ctx.page, async () => {
      window.__S.getState().renameLayer(window.__S.getState().project.layers[0].id, "renamed");
      await window.__S.getState().saveProject(false);
    });
    assert(existsSync(`${file}.bak`), "no .bak kept when saving over a project");
    assert(readFileSync(`${file}.bak`).equals(first), ".bak is not the version that was replaced");
    assert(!readdirSync(ctx.profile.out).some((f) => f.endsWith(".tmp")), "a temp file was left behind");
    const a2 = await summary(ctx.page);
    await S(ctx.page, () => window.__S.getState().closeProject());
    eq(await summary(ctx.page), null, "closed");
    await S(ctx.page, (file) => window.__S.getState().openProjectByPath(file), file);
    eq(await summary(ctx.page), { ...a2, rects: 0 }, "reopened project is the saved one");
    eq(a2.layers.slice(1), a.layers.slice(1), "only the renamed layer changed");
  },

  async tabs(ctx) {
    await freshProject(ctx.page, 1200, 800, "one.png");
    await S(ctx.page, async () => {
      for (const n of ["two.png", "three.png"]) {
        window.__S.getState().newDocTab();
        await window.__S.getState().newProjectFromImage(n, window.__img(1200, 800));
      }
      const st = window.__S.getState();
      st.setMode("recreate");
      st.setPrompt("make it snowy");
      await window.__S.getState().runAllDocs("current");
    });
    const counts = await S(ctx.page, () => {
      const st = window.__S.getState();
      return st.docs.map((d) => (d.id === st.activeDocId ? st.project : d.slice.project)?.layers.length ?? 0);
    });
    eq(counts, [2, 2, 2], "every tab got its result");
    const reqs = await requests(ctx.app);
    eq(reqs.length, 3, "one request per tab");
    const busy = await S(ctx.page, () => {
      const st = window.__S.getState();
      return st.docs.some((d) => (d.id === st.activeDocId ? st.busy : d.slice.busy));
    });
    eq(busy, false, "no tab left spinning");
  },

  async promptList(ctx) {
    const list = path.join(ctx.profile.out, "list.txt");
    writeFileSync(list, "A red sneaker on wet asphalt, night city lights\n\n[16:9] The same sneaker on a white studio sweep\n\n// a note\n\nA billboard above a desert highway, dusk\n");
    const out = await S(ctx.page, async (list) => {
      const r = await window.mbrush.promptFileOpen(list);
      if (!r.ok) return { error: r.error };
      const { parsePromptList } = await import("/src/promptList.ts");
      const { items } = parsePromptList(r.data.text);
      await window.__S.getState().runPromptList(items, r.data.dir);
      const st = window.__S.getState();
      return {
        items: items.length,
        names: st.docs.map((d) => (d.id === st.activeDocId ? st.project : d.slice.project)?.name ?? null),
        error: st.error,
      };
    }, list);
    assert(!out.error, `list: ${out.error}`);
    eq(out.items, 3, "three prompts understood (note skipped)");
    eq(out.names.filter(Boolean).length, 3, "a project per prompt");
    const reqs = await requests(ctx.app);
    eq(reqs.map((r) => r.mode), ["generate", "generate", "generate"], "three generations");
    eq(reqs.map((r) => r.settings.aspectRatio === "16:9"), [false, true, false], "[16:9] applies to its prompt only");
    sent.promptList = summarize(reqs).sort((a, b) => a.prompt.localeCompare(b.prompt));

    // Stop: the two already running finish, nothing else starts.
    await reset(ctx);
    await stub(ctx.app, { delayMs: 300 });
    const stopped = await S(ctx.page, async () => {
      const { parsePromptList } = await import("/src/promptList.ts");
      const { items } = parsePromptList("one\ntwo\nthree\nfour\nfive");
      const run = window.__S.getState().runPromptList(items, null);
      window.__S.getState().stopPromptList();
      await run;
      return window.__S.getState().status;
    });
    eq((await requests(ctx.app)).length, 2, "stop: only the two in flight ran");
    assert(/נעצרה/.test(stopped), `stop not reported: ${stopped}`);
  },

  async piece(ctx) {
    const rect = { x: 1000, y: 800, w: 1200, h: 900 };
    const big = await S(ctx.page, async (rect) => {
      const src = window.__img(5000, 3000);
      const st = window.__S.getState();
      const opening = st.newProjectFromImage("big.png", src);
      const until = async (f) => {
        for (let i = 0; i < 300 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
      };
      await until(() => !!window.__S.getState().largeImageAsk);
      window.__S.getState().answerLargeImage("piece");
      await until(() => !!window.__S.getState().piecePicker);
      window.__S.getState().finishPiecePick(rect);
      await opening;
      await window.__S.getState().addImageLayer(window.__solid(rect.w, rect.h, "#00ff00"), "green");
      await window.__S.getState().exportToOriginal({ band: 0, matchColor: false });
      return { src, error: window.__S.getState().error, canvas: window.__S.getState().project?.canvas };
    }, rect);
    assert(!big.error, `piece: ${big.error}`);
    eq([big.canvas.width, big.canvas.height], [rect.w, rect.h], "the piece is its own project at full resolution");
    const exported = readdirSync(ctx.profile.out).find((f) => f.endsWith("-ערוך.png"));
    assert(exported, "nothing written back");
    const orig = PNG.sync.read(Buffer.from(big.src.split(",")[1], "base64"));
    const back = PNG.sync.read(readFileSync(path.join(ctx.profile.out, exported)));
    eq([back.width, back.height], [5000, 3000], "written back at the original's size");
    let outsideDiff = 0;
    let insideWrong = 0;
    for (let y = 0; y < 3000; y += 37) {
      for (let x = 0; x < 5000; x += 41) {
        const i = (y * 5000 + x) * 4;
        const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
        if (inside) {
          if (Math.abs(back.data[i] - 0) > 2 || Math.abs(back.data[i + 1] - 255) > 2 || Math.abs(back.data[i + 2] - 0) > 2) insideWrong++;
        } else {
          for (let k = 0; k < 3; k++) if (back.data[i + k] !== orig.data[i + k]) outsideDiff++;
        }
      }
    }
    eq(outsideDiff, 0, "pixels outside the piece are untouched");
    eq(insideWrong, 0, "the edited piece is in its exact place");
  },

  async exports(ctx) {
    await freshProject(ctx.page, 1600, 1000, "export-me.png");
    const before = new Set(readdirSync(ctx.profile.out));
    for (const f of ["png", "jpeg", "webp"]) {
      await S(ctx.page, (f) => window.__S.getState().exportFlattened(f), f);
      assert(!(await errorOf(ctx.page)), `export ${f}: ${await errorOf(ctx.page)}`);
    }
    const made = readdirSync(ctx.profile.out).filter((f) => !before.has(f));
    eq(made.length, 3, `three files exported (${made.join(", ")})`);
    const magic = { png: "89504e47", jpg: "ffd8ff", jpeg: "ffd8ff", webp: "52494646" };
    for (const f of made) {
      const ext = f.split(".").pop().toLowerCase();
      const head = readFileSync(path.join(ctx.profile.out, f)).subarray(0, 4).toString("hex");
      assert(head.startsWith(magic[ext]), `${f}: not a real ${ext}`);
      if (ext !== "webp") {
        const size = await ctx.app.evaluate(({ nativeImage }, p) => nativeImage.createFromPath(p).getSize(), path.join(ctx.profile.out, f));
        eq([size.width, size.height], [1600, 1000], `${f}: size`);
      }
    }
  },

  async closeGuard(ctx) {
    await freshProject(ctx.page, 800, 600, "clean.png");
    await S(ctx.page, async () => {
      window.__S.getState().newDocTab();
      await window.__S.getState().newProjectFromImage("dirty.png", window.__img(800, 600));
      await window.__S.getState().duplicateLayer(window.__S.getState().activeLayerId);
    });
    const ids = await S(ctx.page, () => ({ docs: window.__S.getState().docs.map((d) => d.id), active: window.__S.getState().activeDocId }));
    eq(ids.docs.length, 2, "two tabs open");

    // A tab with unsaved work asks, and "no" keeps it.
    ctx.page.__dialogAnswer = false;
    await S(ctx.page, (id) => window.__S.getState().closeDoc(id), ids.active);
    eq(ctx.page.__dialogs.length, 1, "closing a dirty tab asks");
    assert(ctx.page.__dialogs[0].includes("dirty"), `the question names the tab: ${ctx.page.__dialogs[0]}`);
    eq(await S(ctx.page, () => window.__S.getState().docs.length), 2, "declined: the tab stays");
    eq((await summary(ctx.page)).layers.length, 2, "declined: its work is untouched");

    // Closing the window with unsaved work asks too, and "cancel" keeps the window.
    await ctx.app.evaluate(() => { globalThis.__quit.choice = 1; });
    await ctx.page.waitForTimeout(150);
    const stillOpen = await ctx.app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith("http"));
      w.close();
      await new Promise((r) => setTimeout(r, 300));
      return !w.isDestroyed();
    });
    const asked = await ctx.app.evaluate(() => globalThis.__quit.asked);
    eq(asked.length, 1, "closing the window with unsaved work asks");
    assert(/אחת/.test(asked[0]), `it says how many: ${asked[0]}`);
    eq(stillOpen, true, "cancelled: the window stays");
    await ctx.app.evaluate(() => { globalThis.__quit.choice = 0; });

    // A clean tab closes without a word, exactly as before.
    ctx.page.__dialogs.length = 0;
    await S(ctx.page, (id) => window.__S.getState().closeDoc(id), ids.docs[0]);
    eq(ctx.page.__dialogs.length, 0, "a clean tab does not ask");
    eq(await S(ctx.page, () => window.__S.getState().docs.length), 1, "the clean tab closed");
  },

  // Nothing off-screen, Run always in view, messages never on top of one another — at the
  // window's minimum size and at three common ones. All three failed before the redesign:
  // the top bar was 1,869px wide in a 1,440px window, and Run sat below the fold.
  async layout(ctx) {
    await freshProject(ctx.page, 1200, 1438, "דיוקן סטודיו.jpg");
    await S(ctx.page, async () => {
      const st = window.__S.getState();
      st.setMode("fill");
      st.setPrompt("חלון עגול עם אור בוקר רך");
      st.addRect({ x: 300, y: 300, w: 300, h: 200 });
      await window.__S.getState().generate(); // puts a session figure in the meter
      window.__S.setState({ status: "נוצרה שכבה חדשה · 1024×768px", warning: "יישור לא ודאי", error: "נגמרו הקרדיטים בחשבון OpenAI — טען קרדיט ונסה שוב." });
    });
    const win = await ctx.app.browserWindow(ctx.page);
    const start = await win.evaluate((w) => w.getSize());
    try {
      for (const [w, h] of [[1024, 680], [1280, 800], [1440, 900], [1728, 1050]]) {
        await win.evaluate((bw, [w, h]) => bw.setSize(w, h), [w, h]);
        await ctx.page.waitForTimeout(350);
        const m = await S(ctx.page, () => {
          const box = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
          const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const inside = (b) => b.l >= -0.5 && b.r <= innerWidth + 0.5 && b.t >= -0.5 && b.b <= innerHeight + 0.5;
          const bar = document.querySelector(".tb");
          const controls = [...bar.querySelectorAll("button, select")].filter(shown);
          const run = document.querySelector(".generate-btn");
          const toasts = [...document.querySelectorAll(".toast")].map(box);
          const overlap = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
          let clashes = 0;
          for (let i = 0; i < toasts.length; i++) for (let j = i + 1; j < toasts.length; j++) if (overlap(toasts[i], toasts[j])) clashes++;
          return {
            win: [innerWidth, innerHeight],
            barOverflow: bar.scrollWidth - bar.clientWidth,
            barHeight: Math.round(box(bar).h),
            cut: controls.filter((c) => !inside(box(c))).map((c) => c.textContent.trim().slice(0, 14) || c.getAttribute("aria-label")),
            controls: controls.length,
            runVisible: !!run && inside(box(run)),
            toasts: toasts.length,
            clashes,
          };
        });
        const at = `${w}×${h}`;
        eq(m.cut, [], `${at}: top-bar controls outside the window`);
        assert(m.barOverflow <= 1, `${at}: the top bar is ${m.barOverflow}px wider than the window`);
        eq(m.barHeight, 42, `${at}: the top bar is one row`);
        eq(m.runVisible, true, `${at}: Run is in view`);
        eq([m.toasts, m.clashes], [3, 0], `${at}: three messages, none overlapping`);
      }
      // Narrow: what left the bar is in the "more" menu, not gone.
      await win.evaluate((bw) => bw.setSize(1024, 680));
      await ctx.page.waitForTimeout(300);
      const menu = await S(ctx.page, () => {
        [...document.querySelectorAll(".tb button")].find((b) => b.textContent.includes("עוד")).click();
        return new Promise((r) => setTimeout(() => r([...document.querySelectorAll(".tb-menu-end button")].filter((b) => b.getBoundingClientRect().height > 0).map((b) => b.textContent.trim())), 80));
      });
      eq(menu, ["היסטוריה", "סגור עבודה", "מקרא וקיצורים", "הגדרות", "משוב למפתח"], "1024px: everything that left the bar is in the menu");
    } finally {
      await win.evaluate((bw, [w, h]) => bw.setSize(w, h), start);
    }
  },

  async realProjects(ctx) {
    const list = (process.env.MBRUSH_E2E_PROJECTS ?? "").split(":").filter(Boolean);
    if (!list.length) return "skipped (set MBRUSH_E2E_PROJECTS)";
    for (const src of list) {
      // Copies only: the user's own files are read once, never opened by the app.
      const copy = path.join(ctx.profile.out, `real-${path.basename(src)}`);
      copyFileSync(src, copy);
      await reset(ctx);
      await S(ctx.page, (p) => window.__S.getState().openProjectByPath(p), copy);
      const err = await errorOf(ctx.page);
      assert(!err, `${path.basename(src)}: ${err}`);
      const a = await summary(ctx.page);
      assert(a, `${path.basename(src)}: did not open`);
      const again = copy.replace(/\.mbrush$/, "-resaved.mbrush");
      await S(ctx.page, async (p) => {
        window.__S.setState({ filePath: p });
        await window.__S.getState().saveProject(false);
        window.__S.getState().closeProject();
        await window.__S.getState().openProjectByPath(p);
      }, again);
      eq(await summary(ctx.page), a, `${path.basename(src)}: re-saved copy reopens identical`);
    }
    return `${list.length} project(s) round-tripped`;
  },

  // A component that throws while drawing no longer blanks the window: the boundary shows
  // the crash screen, writes the recovery slot, and a reload brings the app back.
  async crash(ctx) {
    await freshProject(ctx.page, 800, 600);
    await S(ctx.page, () => {
      const st = window.__S.getState();
      window.__S.setState({ project: { ...st.project, layers: null }, dirty: true });
    }).catch(() => {});
    await ctx.page.waitForSelector(".crash", { timeout: 5000 });
    await ctx.page.waitForFunction(() => /נשמר|לא הצלחתי/.test(document.querySelector(".crash-saved")?.textContent || ""), null, { timeout: 8000 });
    const saved = await S(ctx.page, () => document.querySelector(".crash-saved").textContent);
    await ctx.page.click(".crash .primary");
    await ctx.page.waitForLoadState("domcontentloaded");
    await ready(ctx.page);
    if (await ctx.page.$(".crash")) throw new Error("still on the crash screen after reload");
    return `caught; "${saved.trim()}"; reload brought the app back`;
  },
};

// Recovery needs its own process: it kills one and starts another on the same profile.
async function recovery(rendererUrl) {
  const profile = freshProfile();
  profiles.push(profile.root);
  const dir = path.join(profile.userData, "autosave");
  const slotCount = () => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0);
  const waitFor = async (f, what) => {
    for (let i = 0; i < 80 && !f(); i++) await new Promise((r) => setTimeout(r, 250));
    // `what` may be a function, so a failure reports the count at the END of the wait.
    assert(f(), typeof what === "function" ? what() : what);
  };
  const names = (page) =>
    S(page, () => {
      const st = window.__S.getState();
      return st.docs.map((d) => {
        const p = d.id === st.activeDocId ? st.project : d.slice.project;
        return p ? `${p.name}:${p.layers.length}` : null;
      });
    });

  // Three tabs with unsaved work, and one clean tab that must not be offered.
  let ctx = { ...(await launch(rendererUrl, profile)), profile };
  await S(ctx.page, async () => {
    const st = () => window.__S.getState();
    await st().newProjectFromImage("one.png", window.__img(800, 600));
    await st().duplicateLayer(st().activeLayerId);
    st().newDocTab();
    await st().newProjectFromImage("two.png", window.__img(640, 480));
    await st().duplicateLayer(st().activeLayerId);
    await st().duplicateLayer(st().activeLayerId);
    st().newDocTab();
    await st().newProjectFromImage("clean.png", window.__img(320, 240));
    st().newDocTab();
    await st().newProjectFromImage("three.png", window.__img(500, 500));
    st().renameLayer(st().activeLayerId, "renamed");
  });
  await waitFor(() => slotCount() === 3, () => `three slots expected, found ${slotCount()}`);
  await new Promise((r) => setTimeout(r, 400));
  ctx.app.process().kill("SIGKILL");

  ctx = { ...(await launch(rendererUrl, profile)), profile };
  const rec = await S(ctx.page, () => window.__S.getState().recovery);
  assert(rec, "recovery not offered after a crash");
  eq(rec.slots.map((s) => s.name).sort(), ["one", "three", "two"], "every tab with unsaved work is offered, the clean one is not");
  await S(ctx.page, () => window.__S.getState().restoreAutosave());
  assert(!(await errorOf(ctx.page)), `restore: ${await errorOf(ctx.page)}`);
  eq((await names(ctx.page)).filter(Boolean).sort(), ["one:2", "three:1", "two:3"], "all three come back, each with its own layers");
  eq(await S(ctx.page, () => window.__S.getState().recovery), null, "the offer is gone once answered");
  await waitFor(() => slotCount() === 3, () => `restored work keeps a slot under its new tab (found ${slotCount()})`);

  // Saving one drops its slot and leaves the other two alone.
  const saved = path.join(profile.out, "saved-one.mbrush");
  await S(ctx.page, async (file) => {
    window.__S.setState({ filePath: file });
    await window.__S.getState().saveProject(false);
  }, saved);
  await waitFor(() => slotCount() === 2, () => `saving one tab should leave two slots (found ${slotCount()})`);

  // A slot from before this change — the single file in the profile root — is still read.
  const [someSlot] = readdirSync(dir).filter((f) => f.endsWith(".mbrush"));
  ctx.app.process().kill("SIGKILL");
  copyFileSync(path.join(dir, someSlot), path.join(profile.userData, "autosave.mbrush"));
  writeFileSync(path.join(profile.userData, "autosave.meta.json"), JSON.stringify({ name: "from-old-version", originalPath: null, savedAt: 5 }));
  rmSync(dir, { recursive: true, force: true });
  ctx = { ...(await launch(rendererUrl, profile)), profile };
  try {
    const old = await S(ctx.page, () => window.__S.getState().recovery);
    eq(old?.slots, [{ id: "legacy", name: "from-old-version" }], "the old single slot is offered");
    await S(ctx.page, () => window.__S.getState().restoreAutosave());
    assert((await summary(ctx.page))?.layers.length >= 1, "the old slot restores");
    await waitFor(() => !existsSync(path.join(profile.userData, "autosave.mbrush")) && slotCount() === 1, "the old slot moved into the new layout");

    // Declining an offer removes what was offered — and not the slot of work begun in
    // this session before the offer was answered.
    ctx.app.process().kill("SIGKILL");
    ctx = { ...(await launch(rendererUrl, profile)), profile };
    eq((await S(ctx.page, () => window.__S.getState().recovery))?.slots.length, 1, "offered again after another crash");
    const mine = await S(ctx.page, async () => {
      await window.__S.getState().newProjectFromImage("this-session.png", window.__img(400, 300));
      await window.__S.getState().duplicateLayer(window.__S.getState().activeLayerId);
      return window.__S.getState().activeDocId;
    });
    await waitFor(() => slotCount() === 2, () => `this session's work gets its own slot beside the offered one (found ${slotCount()})`);
    await S(ctx.page, () => window.__S.getState().dismissRecovery());
    await waitFor(() => slotCount() === 1, () => `declined: only the offered slot goes (found ${slotCount()})`);
    eq(readdirSync(dir).filter((f) => f.endsWith(".json")), [`${mine}.json`], "what is left is this session's own slot");
  } finally {
    await ctx.app.close().catch(() => {});
  }
}

// What the app itself writes when it generates: needs the real handler, so its own
// process, on the offline Mock engine, with ~/Pictures moved into the run's folder.
async function devDumps(rendererUrl) {
  const profile = freshProfile();
  profiles.push(profile.root);
  const ctx = await launch(rendererUrl, profile, { realEngine: true });
  try {
    await freshProject(ctx.page, 800, 600);
    await S(ctx.page, async () => {
      const st = window.__S.getState();
      st.setProvider("mock");
      st.setMode("recreate");
      st.setPrompt("anything");
      await window.__S.getState().generate();
    });
    assert(!(await errorOf(ctx.page)), `mock run: ${await errorOf(ctx.page)}`);
    const debug = path.join(profile.userData, "debug");
    const dumped = existsSync(debug) ? readdirSync(debug) : [];
    assert(dumped.some((f) => f.includes("_SENT_")) && dumped.some((f) => f.includes("_OUT_")), `a development run should dump what was sent and returned (${dumped.join(", ") || "nothing"})`);
    assert(dumped.includes(".cap-start"), "no cap marker written");
    const archived = readdirSync(path.join(profile.out, "pictures"), { recursive: true }).filter((f) => String(f).endsWith(".png"));
    eq(archived.length, 1, "the raw output is still archived, as before");
  } finally {
    await ctx.app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- runner
async function main() {
  if (!args.includes("--no-build")) {
    process.stdout.write("building main + preload… ");
    buildMain();
    console.log("ok");
  }
  const { server, url } = await startRenderer();
  const profile = freshProfile();
  profiles.push(profile.root);
  console.log(`profile: ${profile.root}`);
  let ctx;
  try {
    ctx = { ...(await launch(url, profile)), profile };
    for (const [name, fn] of Object.entries(scenarios)) {
      if (only.length && !only.includes(name)) continue;
      const t0 = Date.now();
      try {
        await reset(ctx);
        const note = await fn(ctx);
        results.push({ name, ok: true, note, ms: Date.now() - t0 });
        console.log(`  ✓ ${name}${note ? ` — ${note}` : ""} (${Date.now() - t0}ms)`);
      } catch (e) {
        results.push({ name, ok: false, error: e.message });
        console.log(`  ✗ ${name}\n    ${e.message}`);
      }
    }
    await ctx.app.close().catch(() => {});

    if (!only.length || only.includes("recovery")) {
      const t0 = Date.now();
      try {
        await recovery(url);
        results.push({ name: "recovery", ok: true });
        console.log(`  ✓ recovery (${Date.now() - t0}ms)`);
      } catch (e) {
        results.push({ name: "recovery", ok: false, error: e.message });
        console.log(`  ✗ recovery\n    ${e.message}`);
      }
    }

    if (!only.length || only.includes("devDumps")) {
      const t0 = Date.now();
      try {
        await devDumps(url);
        results.push({ name: "devDumps", ok: true });
        console.log(`  ✓ devDumps (${Date.now() - t0}ms)`);
      } catch (e) {
        results.push({ name: "devDumps", ok: false, error: e.message });
        console.log(`  ✗ devDumps\n    ${e.message}`);
      }
    }

    // The contract: the engine is asked exactly what it was asked before.
    if (!only.length) {
      if (args.includes("--update-baseline") || !existsSync(BASELINE)) {
        writeFileSync(BASELINE, JSON.stringify(sent, null, 2) + "\n");
        console.log(`  • engine requests recorded as the baseline (${path.relative(ROOT, BASELINE)})`);
      } else {
        const base = JSON.parse(readFileSync(BASELINE, "utf8"));
        try {
          eq(sent, base, "engine requests differ from the baseline");
          results.push({ name: "contract", ok: true });
          console.log("  ✓ contract — engine requests identical to the baseline");
        } catch (e) {
          results.push({ name: "contract", ok: false, error: e.message });
          console.log(`  ✗ contract\n    ${e.message}`);
        }
      }
    }
  } finally {
    await server.close();
    if (!args.includes("--keep")) for (const p of profiles) rmSync(p, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
