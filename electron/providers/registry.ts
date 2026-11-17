import type { ImageProvider } from "./ImageProvider.js";
import { Umage2Provider } from "./umage2/Umage2Provider.js";
import { NanoBananaProvider } from "./nano-banana/NanoBananaProvider.js";
import { ReveProvider } from "./reve/ReveProvider.js";
import { CrystalProvider } from "./crystal/CrystalProvider.js";
import { GrokProvider } from "./grok/GrokProvider.js";
import { IdeogramProvider } from "./ideogram/IdeogramProvider.js";
// MagnificProvider exists but is unregistered — its API needs an admin-only key.
import { MockImageProvider } from "./mock/MockImageProvider.js";
import type {
  BaseGenerationRequest,
  GenerationResult,
  ProviderInfo,
} from "../../shared/types.js";

/**
 * Central provider registry. Adding a new engine = register one adapter here.
 * Nothing else in the app (canvas, layers, project, UI) needs to change.
 */
export class ProviderRegistry {
  private providers = new Map<string, ImageProvider>();

  constructor() {
    this.register(new Umage2Provider());
    this.register(new NanoBananaProvider());
    this.register(new ReveProvider());
    this.register(new CrystalProvider());
    this.register(new GrokProvider());
    this.register(new IdeogramProvider());
    this.register(new MockImageProvider());
  }

  register(p: ImageProvider) {
    this.providers.set(p.id, p);
  }

  get(id: string): ImageProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`ספק לא מוכר: ${id}`);
    return p;
  }

  list(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      capabilities: p.getCapabilities(),
      models: p.getModels(),
      options: p.getOptions(),
      requiresApiKey: p.requiresApiKey(),
    }));
  }

  async dispatch(req: BaseGenerationRequest, apiKey?: string): Promise<GenerationResult> {
    const p = this.get(req.providerId);
    switch (req.mode) {
      case "upscale":
        return p.upscaleImage(req, apiKey);
      case "recreate":
      // Background removal is an image-in/image-out edit like a recreate; what makes it
      // a different mode is the prompt and the transparent output, not the endpoint.
      case "removebg":
        return p.recreateImage(req, apiKey);
      case "fill":
        return p.editImageWithMask(req, apiKey);
      case "expand":
      case "ratio":
        return p.expandImage(req, apiKey);
      case "generate":
        return p.generateImage(req, apiKey);
      default:
        throw new Error(`מצב לא נתמך: ${req.mode}`);
    }
  }
}

export const registry = new ProviderRegistry();
