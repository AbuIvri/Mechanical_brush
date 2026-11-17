// The chat providers the assistant can talk to. Lifted out of ChatDock because the
// session store, the workflow planner and per-step model overrides all need it.

export type ChatProvider = "openai" | "google" | "xai" | "anthropic";

// Newest models first (the first is the default). The model field is free-text, so
// when newer models ship, just type their id — no app update needed.
export const PROVIDERS: { id: ChatProvider; label: string; keyId: string; models: string[] }[] = [
  { id: "openai", label: "OpenAI (GPT)", keyId: "umage2", models: ["gpt-5.6", "gpt-5.5", "gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-5-nano"] },
  { id: "google", label: "Google (Gemini)", keyId: "chat-google", models: ["gemini-3-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash"] },
  { id: "xai", label: "xAI (Grok)", keyId: "chat-xai", models: ["grok-4-1-fast-reasoning", "grok-4-fast", "grok-4"] },
  { id: "anthropic", label: "Anthropic (Claude)", keyId: "chat-anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"] },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

/** Models that were a provider's default in an earlier build, mapped to what replaced
 *  them. A session started before the newer model existed is sitting on yesterday's
 *  default, not on a choice — so it gets moved once. A model the user picked on purpose
 *  is not in this table and is never touched. */
export const SUPERSEDED_DEFAULTS: Record<string, string> = {
  "gpt-5.5": "gpt-5.6",
};

export function providerDef(id: ChatProvider) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export function isChatProvider(v: unknown): v is ChatProvider {
  return typeof v === "string" && (PROVIDER_IDS as string[]).includes(v);
}

/** Default model for a provider (used when a tab or a skill step names no model). */
export function defaultModel(id: ChatProvider): string {
  return providerDef(id).models[0];
}
