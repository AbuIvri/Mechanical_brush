import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { PNG } from "pngjs";
import { IdeogramProvider, readQuoteUsd, ideogramError, IDEOGRAM_MODEL } from "../electron/providers/ideogram/IdeogramProvider";
import { sizeForAspect, fitIdeogramSize, upscaleFactor, tierOf, IDEOGRAM_MAX_PIXELS } from "../shared/ideogramSize";
import { describeError } from "../shared/errors";
import { PIN_EDIT_BASE, ERASE_FILL_PROMPT } from "../shared/erasePrompts";
import type { BaseGenerationRequest } from "../shared/types";

// A stand-in for api.ideogram.ai, built to the documented shapes: multipart in, a
// generation_id back, GET /v2/generations/{id} to poll, a result URL to download.

function png(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]] = fill(x, y);
    }
  return PNG.sync.write(p);
}
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString("base64")}`;
const SOURCE = dataUrl(png(64, 32, () => [120, 140, 160, 255]));
const OUT = png(64, 32, () => [10, 200, 10, 255]);

interface Hit { method: string; path: string; key: string | undefined; fields: Map<string, (string | { name: string; size: number; type: string; bytes: Buffer })[]> }
let hits: Hit[] = [];
let mode: { cost: boolean; refuseSize: boolean; status402: string | null; unsafe: boolean; quote: unknown } = {
  cost: true, refuseSize: false, status402: null, unsafe: false, quote: { price: { usd: 0.07 } },
};
let polls = 0;
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url!, base);
    const fields: Hit["fields"] = new Map();
    if (req.method === "POST") {
      const fd = await new Response(raw, { headers: { "content-type": req.headers["content-type"]! } }).formData();
      for (const [k, v] of fd.entries()) {
        const val = typeof v === "string" ? v : { name: (v as File).name, size: (v as File).size, type: (v as File).type, bytes: Buffer.from(await (v as File).arrayBuffer()) };
        fields.set(k, [...(fields.get(k) ?? []), val]);
      }
    }
    hits.push({ method: req.method!, path: url.pathname + url.search, key: req.headers["api-key"] as string | undefined, fields });
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

    if (url.pathname.startsWith("/img/")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(OUT); }
    if (url.pathname.startsWith("/v2/generations/")) {
      polls++;
      if (polls % 2 === 1) return send(200, { generation_id: "g1", status: "pending", created: "x" });
      return send(200, {
        generation_id: "g1", status: "completed", created: "x", response_type: "url",
        ...(mode.cost ? { usage_cost_usd_micros: 80_000 } : {}),
        data: [{ object_type: "image.generation", url: mode.unsafe ? null : `${base}/img/1.png`, resolution: "64x32", is_image_safe: !mode.unsafe }],
      });
    }
    if (req.method === "POST") {
      if (mode.status402) return send(402, { reject_reason: mode.status402 });
      if (url.searchParams.get("dry_run") === "true") return send(200, mode.quote);
      const size = fields.get("size")?.[0];
      if (mode.refuseSize && typeof size === "string" && size !== "auto") return send(400, { message: `size ${size} is not a supported preset` });
      return send(200, { generation_id: "g1", seed: 7 });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  hits = [];
  polls = 0;
  mode = { cost: true, refuseSize: false, status402: null, unsafe: false, quote: { price: { usd: 0.07 } } };
});

const provider = () => new IdeogramProvider(base, 5, 5_000);
const KEY = "test-key";
const posts = () => hits.filter((h) => h.method === "POST");
const field = (h: Hit, k: string) => h.fields.get(k);
const req = (r: Partial<BaseGenerationRequest>): BaseGenerationRequest => ({ providerId: "ideogram", mode: "generate", ...r });

describe("Ideogram 4.5 provider", () => {
  it("generates: multipart to generate/ideogram-4-5, async, polled, cost read from the server", async () => {
    const out = await provider().generateImage(req({ prompt: "a red fox", settings: { aspectRatio: "16:9", ideogramResolution: "2k" } }), KEY);
    const [p] = posts();
    expect(p.path).toBe("/v2/image/generate/ideogram-4-5");
    expect(p.key).toBe(KEY);
    expect(field(p, "prompt")).toEqual(["a red fox"]);
    expect(field(p, "async")).toEqual(["true"]);
    expect(field(p, "magic_prompt")).toEqual(["auto"]);
    const [w, h] = String(field(p, "size")![0]).split("x").map(Number);
    expect(w % 32).toBe(0);
    expect(h % 32).toBe(0);
    expect(w * h).toBeLessThanOrEqual(IDEOGRAM_MAX_PIXELS);
    expect(w / h).toBeCloseTo(16 / 9, 1);
    // Polled until completed (pending first), then the image was downloaded.
    expect(hits.filter((x) => x.path.startsWith("/v2/generations/")).length).toBe(2);
    expect(out.images[0].src.startsWith("data:image/png;base64,")).toBe(true);
    expect([out.images[0].width, out.images[0].height]).toEqual([64, 32]);
    expect(out.metadata?.costEstimate).toBeCloseTo(0.08, 6);
    expect(out.modelId).toBe(IDEOGRAM_MODEL);
  });

  it("recreates through generate with the source first and the app's wording intact", async () => {
    await provider().recreateImage(
      req({ mode: "recreate", image: SOURCE, prompt: "Image 1 is the picture to work on.\ntranslate", references: [{ src: SOURCE, role: "typography" }], settings: { outputWidth: 3000, outputHeight: 1500 } }),
      KEY,
    );
    const [p] = posts();
    expect(p.path).toBe("/v2/image/generate/ideogram-4-5");
    expect(field(p, "images")).toHaveLength(2); // source, then the reference
    expect(field(p, "magic_prompt")).toEqual(["off"]);
    expect(String(field(p, "prompt")![0])).toMatch(/^Recreate the first image/);
    expect(String(field(p, "prompt")![0])).toContain("Image 1 is the picture to work on");
    const [w, h] = String(field(p, "size")![0]).split("x").map(Number);
    expect(w * h).toBeLessThanOrEqual(IDEOGRAM_MAX_PIXELS);
    expect(w / h).toBeCloseTo(2, 1);
  });

  it("sends a recreate that carries pins to precise-edit, which keeps untouched pixels", async () => {
    await provider().recreateImage(req({ mode: "recreate", image: SOURCE, prompt: "pin 1 (x: 50%, y: 50%) a red door", settings: { pinEdit: true } }), KEY);
    const [p] = posts();
    expect(p.path).toBe("/v2/image/precise-edit/ideogram-4-5");
    expect(String(field(p, "prompt")![0]).startsWith(PIN_EDIT_BASE)).toBe(true);
    expect(field(p, "image")).toHaveLength(1);
  });

  it("erases with a real mask in Ideogram's convention, and keeps the app's own references last", async () => {
    const mask = dataUrl(png(64, 32, (x) => (x < 32 ? [255, 255, 255, 255] : [0, 0, 0, 0])));
    const user = Array.from({ length: 4 }, () => ({ src: SOURCE, role: "style" as const }));
    await provider().editImageWithMask(
      req({ mode: "fill", image: SOURCE, mask, prompt: ERASE_FILL_PROMPT, references: [...user, { src: SOURCE, role: "composition", note: "erase marks" }, { src: SOURCE, role: "composition", note: "full-image context" }] }),
      KEY,
    );
    const [p] = posts();
    expect(p.path).toBe("/v2/image/precise-edit/ideogram-4-5");
    // Three references at most with a mask — the user's go, the app's two stay.
    const refs = field(p, "reference_images")!;
    expect(refs).toHaveLength(3);
    const m = field(p, "mask")![0] as { bytes: Buffer };
    const img = PNG.sync.read(m.bytes);
    const at = (x: number) => img.data[(5 * img.width + x) * 4];
    expect(at(10)).toBe(0); // painted → black = edit
    expect(at(50)).toBe(255); // untouched → white = keep
    expect(String(field(p, "prompt")![0])).toContain("low-resolution view of the complete picture");
  });

  it("removes a background on the dedicated endpoint — a cut-out, not a redraw", async () => {
    await provider().recreateImage(req({ mode: "removebg", image: SOURCE }), KEY);
    const [p] = posts();
    expect(p.path).toBe("/v2/image/remove-background/ideogram-1");
    expect([...p.fields.keys()].sort()).toEqual(["async", "image", "private"]);
  });

  it("upscales by a factor that stays inside 8192px", async () => {
    await provider().upscaleImage(req({ mode: "upscale", image: SOURCE, settings: { ideogramUpscale: 4 } }), KEY);
    expect(field(posts()[0], "upscale_factor")).toEqual(["4"]);
    expect(upscaleFactor(3000, 4)).toBe(2); // 3000×4 would be 12000
    expect(upscaleFactor(1000, 8)).toBe(8);
    expect(() => upscaleFactor(5000, 2)).toThrow(/8192/);
  });

  it("asks again with 'auto' when a computed size is not one of the unpublished presets", async () => {
    mode.refuseSize = true;
    await provider().generateImage(req({ prompt: "x", settings: { aspectRatio: "3:2" } }), KEY);
    const sizes = posts().filter((p) => !p.path.includes("dry_run")).map((p) => field(p, "size")![0]);
    expect(sizes).toHaveLength(2);
    expect(sizes[1]).toBe("auto");
  });

  it("prices a run from a free dry run when the result carries no cost — once per shape", async () => {
    mode.cost = false;
    const prov = provider();
    const a = await prov.generateImage(req({ prompt: "x", settings: { aspectRatio: "1:1" } }), KEY);
    const b = await prov.generateImage(req({ prompt: "y", settings: { aspectRatio: "1:1" } }), KEY);
    expect(a.metadata?.costEstimate).toBe(0.07);
    expect(b.metadata?.costEstimate).toBe(0.07);
    expect(posts().filter((p) => p.path.includes("dry_run=true"))).toHaveLength(1);
    // The dry run never carries async — it is not a generation.
    expect(field(posts().find((p) => p.path.includes("dry_run"))!, "async")).toBeUndefined();
  });

  it("reports no cost rather than inventing one when Ideogram will not say", async () => {
    mode.cost = false;
    mode.quote = { ok: true };
    const out = await provider().generateImage(req({ prompt: "x" }), KEY);
    expect(out.metadata?.costEstimate).toBeUndefined();
  });

  it("an out-of-credits refusal reads as one", async () => {
    mode.status402 = "insufficient_funds";
    const e = await provider().generateImage(req({ prompt: "x" }), KEY).catch((x) => x);
    expect(describeError(e)).toContain("נגמרו הקרדיטים");
    expect(describeError(ideogramError(402, { reject_reason: "daily_limit" }))).toMatch(/המכסה היומית/);
    expect(describeError(ideogramError(402, { reject_reason: "daily_limit" }))).not.toContain("נגמרו הקרדיטים");
  });

  it("says so when the safety check withheld the image", async () => {
    mode.unsafe = true;
    await expect(provider().generateImage(req({ prompt: "x" }), KEY)).rejects.toThrow(/בדיקת הבטיחות/);
  });

  it("checks a key with a dry run, so checking costs nothing", async () => {
    expect(await provider().validateApiKey(KEY)).toEqual({ valid: true });
    expect(posts()[0].path).toBe("/v2/image/generate/ideogram-4-5?dry_run=true");
    expect(hits.some((h) => h.path.startsWith("/v2/generations/"))).toBe(false);
  });
});

describe("Ideogram size rules", () => {
  it("every computed size obeys the documented limits", () => {
    for (const a of [1, 16 / 9, 9 / 16, 4 / 3, 3 / 4, 21 / 9, 6, 1 / 6, 10, 0.05]) {
      for (const budget of [1024 * 1024, IDEOGRAM_MAX_PIXELS]) {
        const { w, h } = sizeForAspect(a, budget);
        expect(w % 32, `${a}`).toBe(0);
        expect(h % 32, `${a}`).toBe(0);
        expect(Math.min(w, h)).toBeGreaterThanOrEqual(256);
        expect(w * h).toBeLessThanOrEqual(budget);
        expect(Math.max(w / h, h / w)).toBeLessThanOrEqual(6.0001);
      }
    }
  });

  it("does not pay for 2K when 1K was asked for", () => {
    const s = fitIdeogramSize(1000, 1000);
    expect(tierOf(s.w, s.h)).toBe("1k");
    const big = fitIdeogramSize(4000, 2250);
    expect(tierOf(big.w, big.h)).toBe("2k");
    expect(big.w * big.h).toBeLessThanOrEqual(IDEOGRAM_MAX_PIXELS);
  });

  it("reads a price quote without knowing its exact shape", () => {
    expect(readQuoteUsd({ price: { usd: 0.06 } })).toBe(0.06);
    expect(readQuoteUsd({ estimated_cost_usd_micros: 90_000 })).toBe(0.09);
    expect(readQuoteUsd({ total_cents: 12 })).toBe(0.12);
    expect(readQuoteUsd({ ok: true, seed: 3 })).toBeUndefined();
  });
});
