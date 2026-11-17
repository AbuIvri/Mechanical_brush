import { MB } from "./payload.js";

/** Above this, an upload is heavy enough to be a suspect in its own right. */
const HEAVY_UPLOAD = 8_000_000;

/** The provider is refusing to bill — out of credits, or over a spending cap. */
const BILLING = /insufficient_quota|insufficient_funds|subscription_required|priority_credit_required|exceeded your current quota|billing hard limit|check your plan and billing|payment required|402/i;

const BILLING_HELP =
  "נגמרו הקרדיטים בחשבון הספק, או שהגעת לתקרת החיוב שלו. טען יתרה " +
  "(OpenAI: platform.openai.com/settings/organization/billing · Ideogram: developer.ideogram.ai/ideogram-api/api-setup) ונסה שוב. " +
  "התקרה שבתוך האפליקציה היא נפרדת — היא לא זו שנגמרה.";

/**
 * A message the user can act on.
 *
 * The OpenAI SDK reports every transport failure as the bare string "Connection error."
 * and hides the real reason in `cause` — which is how an oversized upload ends up looking
 * to the user like a network outage. Unwrap the chain and say what to try.
 *
 * `uploadBytes` is what the request actually weighed. Without it this advice used to end
 * with "if the image is large, try a lower resolution" on every connection failure —
 * including a 3MB request that died mid-flight, where resolution is not the problem and
 * lowering it costs quality for nothing. Say the size and let it point somewhere true.
 */
export function describeError(error: unknown, uploadBytes = 0): string {
  if (!(error instanceof Error)) return String(error);
  const parts: string[] = [error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let i = 0; i < 3 && cause; i++) {
    const c = cause as { message?: string; code?: string; cause?: unknown };
    const text = c instanceof Error ? c.message : typeof c === "string" ? c : c?.code ?? "";
    if (text && !parts.includes(text)) parts.push(text);
    cause = c?.cause;
  }
  const joined = parts.join(" · ");
  // Say it plainly: "429 You exceeded your current quota" in English, mid-Hebrew UI, is a
  // sentence people read as a bug in the app.
  if (BILLING.test(joined)) return `${joined} — ${BILLING_HELP}`;
  // A request that ran out of time (see electron/providers/timeouts.ts). Said in words, and
  // honestly: the job may still be running, or have been billed, at the provider's end.
  if (error.name === "TimeoutError" || /aborted due to timeout|TimeoutError/i.test(joined)) {
    return "המנוע לא ענה בזמן, אז הבקשה בוטלה ולא נוצרה שכבה. ייתכן שהספק עדיין מעבד אותה או חייב עליה — בדוק בחשבון הספק לפני שתריץ שוב.";
  }
  if (!/connection error|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(joined)) return joined;
  const size = uploadBytes > 0 ? ` (נשלחו ${MB(uploadBytes)})` : "";
  // A connection that dies mid-upload is not always the network. An account the provider
  // refuses to bill is rejected early, and the server can close while the app is still
  // sending the multipart body — so the real answer (429 insufficient_quota) never gets
  // read, and this arrives instead. It is the first thing to check, because a mode whose
  // request body is small (יצירה) gets the true message and the same account on a masked
  // edit gets this one.
  const first = "ראשית בדוק שיש קרדיטים בחשבון הספק — חשבון שנגמרו בו הקרדיטים נדחה לפני שההעלאה מסתיימת, וזה נראה בדיוק כך.";
  return uploadBytes >= HEAVY_UPLOAD
    ? `${joined} — ההעלאה נקטעה${size}. ${first} אם יש קרדיטים: זו העלאה כבדה — הורד את רזולוציית האזור או הסר תמונות ייחוס כבדות ונסה שוב.`
    : `${joined} — החיבור לספק נקטע${size} לפני שהתקבלה תשובה, אז לא נוצרה שכבה (ואם הניתוק היה בזמן ההמתנה לתמונה, ייתכן שהספק כן חייב על ההרצה). ${first} אם יש קרדיטים: לרוב זה ניתוק רגעי — לחץ הרץ שוב.`;
}
