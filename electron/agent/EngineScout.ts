import type { ProviderCapabilities, ModelInfo } from "../../shared/types.js";

/**
 * Smart Engine Scout — architecture definition.
 *
 * This subsystem discovers, compares, and PLANS migrations to new image
 * engines. It is intentionally advisory: it NEVER swaps the active provider,
 * edits production code, or changes defaults without explicit human approval.
 *
 * The MVP ships the interfaces + a static registry + a deterministic
 * comparator/scorer. Online discovery (web search, docs crawling) and patch
 * generation are wired behind the same interfaces in later versions.
 */

export interface ProviderRegistryEntry {
  id: string;
  name: string;
  website?: string;
  docsUrl?: string;
  pricingUrl?: string;
  models: ModelInfo[];
  capabilities: ProviderCapabilities;
  lastCheckedAt: string;
  status: "available" | "experimental" | "deprecated" | "unavailable";
  notes?: string;
}

export interface ComparisonRow {
  feature: keyof ProviderCapabilities | "implementationComplexity";
  current: string | boolean | number;
  candidate: string | boolean | number;
  better: "current" | "candidate" | "equal";
}

export interface MigrationRecommendation {
  candidateId: string;
  compatibilityScore: number; // 0..100
  missingFeatures: string[];
  whySwitch: string;
  difficulty: "low" | "medium" | "high";
  rows: ComparisonRow[];
  requiresHumanApproval: true; // always
}

export interface MigrationPlan {
  candidateId: string;
  steps: string[];
  adapterSkeletonPath: string;
  testPlan: string[];
  rollback: string;
  requiresHumanApproval: true;
}

export interface EngineScout {
  /** Pull the known registry (later: refreshed from the network on demand). */
  listRegistry(): Promise<ProviderRegistryEntry[]>;
  /** Compare the active provider's capabilities against a candidate. */
  compare(
    current: ProviderCapabilities,
    candidateId: string,
  ): Promise<MigrationRecommendation>;
  /** Produce a human-readable, human-approved migration plan (no code is applied). */
  planMigration(candidateId: string): Promise<MigrationPlan>;
}

/**
 * Static, offline implementation. Safe by construction: read-only, generates
 * plans/recommendations only. Future online scouting implements the same shape.
 */
export class StaticEngineScout implements EngineScout {
  constructor(private registry: ProviderRegistryEntry[]) {}

  async listRegistry() {
    return this.registry;
  }

  async compare(current: ProviderCapabilities, candidateId: string): Promise<MigrationRecommendation> {
    const entry = this.registry.find((r) => r.id === candidateId);
    if (!entry) throw new Error(`מנוע לא מוכר: ${candidateId}`);
    const cap = entry.capabilities;
    const rows: ComparisonRow[] = [];
    const missing: string[] = [];
    let score = 100;

    (Object.keys(current) as (keyof ProviderCapabilities)[]).forEach((k) => {
      const cur = current[k];
      const cand = cap[k];
      if (typeof cur === "boolean" && typeof cand === "boolean") {
        rows.push({
          feature: k,
          current: cur,
          candidate: cand,
          better: cur === cand ? "equal" : cand ? "candidate" : "current",
        });
        if (cur && !cand) {
          missing.push(k);
          score -= 12;
        }
      }
    });

    return {
      candidateId,
      compatibilityScore: Math.max(0, score),
      missingFeatures: missing,
      whySwitch:
        missing.length === 0
          ? `${entry.name} מכסה את כל היכולות הקיימות וניתן להחליף בבטחה לאחר אישור.`
          : `${entry.name} חסר: ${missing.join(", ")}. נדרשת בדיקה לפני מעבר.`,
      difficulty: missing.length === 0 ? "low" : missing.length <= 2 ? "medium" : "high",
      rows,
      requiresHumanApproval: true,
    };
  }

  async planMigration(candidateId: string): Promise<MigrationPlan> {
    const entry = this.registry.find((r) => r.id === candidateId);
    if (!entry) throw new Error(`מנוע לא מוכר: ${candidateId}`);
    return {
      candidateId,
      steps: [
        `צור adapter חדש תחת electron/providers/${candidateId}/ שמיישם את ImageProvider`,
        "מפה את בקשות upscale/recreate/fill/generate ל-API של הספק",
        "תרגם פורמט מסכה לפי ConventionShim של הספק",
        "רשום את הספק ב-ProviderRegistry",
        "הרץ את חבילת הבדיקות התואמת (compatibility suite)",
      ],
      adapterSkeletonPath: `electron/providers/${candidateId}/${capitalize(candidateId)}Provider.ts`,
      testPlan: [
        "upscale מחזיר שכבה מיושרת",
        "fill עם מסכה לא דורס את המקור",
        "שמירה/פתיחה של פרויקט נשמרת",
      ],
      rollback: "בטל את רישום הספק מ-ProviderRegistry; ה-adapter מבודד ולא נוגע בליבה/קנבס.",
      requiresHumanApproval: true,
    };
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
