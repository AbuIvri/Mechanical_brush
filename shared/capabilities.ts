import type { ProviderInfo } from "./types.js";

/**
 * Can this engine, on the model selected RIGHT NOW, remove a background?
 *
 * Two separate questions, and the second is the one that bites: `ProviderInfo.options`
 * is built once from the engine's *default* model, so it cannot say whether the model
 * the user has chosen is capable. The answer therefore lives on the model itself.
 */
export function canRemoveBackground(
  provider: Pick<ProviderInfo, "capabilities" | "models"> | undefined,
  modelId: string,
): boolean {
  if (!provider?.capabilities?.supportsTransparency) return false;
  return !!provider.models?.find((m) => m.id === modelId)?.supportsTransparency;
}
