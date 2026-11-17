import type {
  BaseGenerationRequest,
  GenerationResult,
  ProviderCapabilities,
  ModelInfo,
  ProviderOption,
  ValidationResult,
} from "../../shared/types.js";

/**
 * Generic image provider contract. The whole app talks ONLY to this interface.
 * Each concrete model/API lives in its own adapter under providers/<name>/.
 *
 * All image payloads are passed as PNG data URLs so the contract is transport
 * agnostic and easy to mock.
 */
export interface ImageProvider {
  readonly id: string;
  readonly name: string;
  readonly version?: string;

  getCapabilities(): ProviderCapabilities;
  getModels(): ModelInfo[];
  /** Adjustable options this engine exposes (drives the dynamic options UI). */
  getOptions(): ProviderOption[];
  requiresApiKey(): boolean;

  validateApiKey(apiKey: string | undefined): Promise<ValidationResult>;

  /** Upscale / high-res reconstruction. */
  upscaleImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult>;

  /** Recreate while preserving identity/composition. */
  recreateImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult>;

  /** Masked generative fill / inpainting. */
  editImageWithMask(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult>;

  /** Generative expand / outpaint: continue the image into new (transparent) margins. */
  expandImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult>;

  /** Optional text-to-image. */
  generateImage(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult>;
}

/** Helpers shared by adapters. */
export function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mime: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error("Invalid data URL");
  return { mime: match[1], buffer: Buffer.from(match[2], "base64") };
}

export function bufferToDataUrl(buffer: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}
