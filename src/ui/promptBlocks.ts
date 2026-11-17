import { splitBlocks, type MdBlock } from "./miniMarkdown";
import { parsePromptList } from "../promptList";

// A chat answer is a conversation turn, not a prompt. Only a fenced ```prompt (or
// ```prompt-en) block is an actual proposal — everything else is the assistant
// thinking out loud with the user, and must NOT be offered as something to paste
// into the generation box.

export interface PromptBlock {
  lang: "he" | "en";
  text: string;
}

/** A fenced block, if it is a proposed prompt. One predicate, so the renderer and
 *  the "does this message contain a prompt" check can never disagree. */
export function asPromptBlock(b: MdBlock): PromptBlock | null {
  if (b.kind !== "code" || !/^prompt(-en)?$/i.test(b.lang ?? "")) return null;
  const text = b.content.trim();
  if (!text) return null;
  return { lang: /-en$/i.test(b.lang ?? "") ? "en" : "he", text };
}

/** A fenced ```prompts block: a LIST of prompts, one image each — run from the batch
 *  window rather than pasted into the prompt box. */
export interface PromptListBlock {
  text: string;
  count: number;
}

export function asPromptListBlock(b: MdBlock): PromptListBlock | null {
  if (b.kind !== "code" || !/^prompts$/i.test(b.lang ?? "")) return null;
  const text = b.content.trim();
  const count = parsePromptList(text).items.length;
  return count ? { text, count } : null;
}

/** The prompts proposed in a message. Empty when the message is just conversation —
 *  there is deliberately no "the whole message is the prompt" fallback here. */
export function promptBlocks(msg: string): PromptBlock[] {
  return splitBlocks(msg)
    .map(asPromptBlock)
    .filter((b): b is PromptBlock => b !== null);
}

/** Rough word count, for showing how long a proposed prompt actually is. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** May THIS turn end in a prompt?
 *
 *  The assistant's job is to understand the problem first and only then offer to write
 *  something — so the gate opens for the turn the user actually asked in, and closes
 *  again afterwards.
 *
 *  It used to stay open for the rest of the tab: once a prompt had been proposed, every
 *  later message got another prompt instead of a conversation. Combined with a
 *  `requested` flag that was set once and never cleared, a single press of ✍️ turned the
 *  assistant into a prompt dispenser for good. Iteration is preserved by the callers
 *  that genuinely want a prompt (the ✂️ shorten button) asking for one explicitly, and
 *  by the closed-gate directive, which still lets the model answer a user who asks for a
 *  prompt in their own words. */
export function gateOpen(_msgs: { role: string; content: string }[], requested: boolean): boolean {
  return requested;
}
