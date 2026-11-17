// Chat attachments: the images a conversation carries, and which of them a turn sends.
//
// Pure and dependency-free on purpose. This used to live in chat.ts, which builds a
// zustand store and reads localStorage the moment it is imported — so the one function
// that decides what a turn actually sends could not be tested without a browser.

export interface Attachment {
  src: string; // 768px copy — what the chat model sees
  /** Larger copy (≤2048) used when promoted to a generation reference image. */
  full: string;
  label: string;
  /** Promote to a reference image when the finished prompt is applied. */
  asRef: boolean;
  /** Restored from disk without its pixels — the label survived, the image didn't. */
  stale?: boolean;
  /** The workflow step that collected this image. A workflow with two images steps —
   *  "the person" and "a wardrobe reference" — needs them kept apart, and the session
   *  holds one pool, so the pool has to carry the label. */
  stepId?: string;
}

/** What the model sees this turn. Freshly attached images replace the carried ones —
 *  that is what makes a new task reset the visual context by itself — and with
 *  nothing attached the previous turn's images carry forward, so a follow-up question
 *  still has its subject. */
export function contextForSend(pending: Attachment[], carry: Attachment[]): Attachment[] {
  const usable = (list: Attachment[]) => list.filter((a) => a.src && !a.stale);
  const fresh = usable(pending);
  return fresh.length ? fresh : usable(carry);
}
