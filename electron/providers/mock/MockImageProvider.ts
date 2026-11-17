import { v4 as uuid } from "uuid";
import zlib from "node:zlib";
import {
  type ImageProvider,
  bufferToDataUrl,
  dataUrlToBuffer,
} from "../ImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../../shared/types.js";
import { ASPECT_EDIT, ASPECT_GEN, FILL_RES, GEN_RES, RECREATE_RES, UPSCALE_RES, RATIO_RES } from "../options.js";

/** Minimal solid-color RGBA PNG encoder (no external deps). */
function solidPng(w: number, h: number, rgba: [number, number, number, number]): Buffer {
  const crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rest 0

  const row = Buffer.alloc(1 + w * 4);
  for (let x = 0; x < w; x++) {
    row[1 + x * 4] = rgba[0];
    row[1 + x * 4 + 1] = rgba[1];
    row[1 + x * 4 + 2] = rgba[2];
    row[1 + x * 4 + 3] = rgba[3];
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Offline test provider. Echoes the source image (proving pipeline + alignment)
 * or synthesizes a solid placeholder when there is no input.
 */
export class MockImageProvider implements ImageProvider {
  readonly id = "mock";
  readonly name = "Mock (offline)";
  readonly version = "1.0";

  getCapabilities(): ProviderCapabilities {
    return {
      supportsUpscale: true,
      supportsRecreate: true,
      supportsInpainting: true,
      supportsMasks: true,
      supportsTransparency: true,
      supportsReferenceImages: true,
      supportsMultipleReferenceImages: true,
      supportsNegativePrompt: true,
      supportsSeed: true,
      supportsVariations: true,
      supportsCustomOutputSize: true,
      supportedFormats: ["png"],
      notes: "Deterministic offline provider for testing — makes no network calls.",
    };
  }

  getModels(): ModelInfo[] {
    return [{ id: "mock-1", label: "Mock Model" }];
  }

  getOptions(): ProviderOption[] {
    return [ASPECT_EDIT, ASPECT_GEN, GEN_RES, RECREATE_RES, UPSCALE_RES, RATIO_RES, FILL_RES];
  }

  requiresApiKey(): boolean {
    return false;
  }

  async validateApiKey(): Promise<ValidationResult> {
    return { valid: true };
  }

  private result(src: string, w: number, h: number): GenerationResult {
    return {
      id: uuid(),
      providerId: this.id,
      modelId: "mock-1",
      images: [{ src, width: w, height: h }],
      metadata: { latencyMs: 1 },
    };
  }

  private echo(req: BaseGenerationRequest): GenerationResult {
    if (req.image) {
      const { buffer } = dataUrlToBuffer(req.image);
      let w = 1024,
        h = 1024;
      if (buffer.length > 24 && buffer.toString("ascii", 12, 16) === "IHDR") {
        w = buffer.readUInt32BE(16);
        h = buffer.readUInt32BE(20);
      }
      return this.result(bufferToDataUrl(buffer), w, h);
    }
    const w = req.settings?.outputWidth ?? 1024;
    const h = req.settings?.outputHeight ?? 1024;
    return this.result(bufferToDataUrl(solidPng(w, h, [40, 80, 160, 255])), w, h);
  }

  async upscaleImage(req: BaseGenerationRequest) {
    return this.echo(req);
  }
  async recreateImage(req: BaseGenerationRequest) {
    return this.echo(req);
  }
  async editImageWithMask(req: BaseGenerationRequest) {
    return this.echo(req);
  }
  async expandImage(req: BaseGenerationRequest) {
    const w = req.settings?.outputWidth ?? 1024;
    const h = req.settings?.outputHeight ?? 1024;
    return this.result(bufferToDataUrl(solidPng(w, h, [90, 110, 140, 255])), w, h);
  }
  async generateImage(req: BaseGenerationRequest) {
    const w = req.settings?.outputWidth ?? 1024;
    const h = req.settings?.outputHeight ?? 1024;
    return this.result(bufferToDataUrl(solidPng(w, h, [120, 60, 160, 255])), w, h);
  }
}
