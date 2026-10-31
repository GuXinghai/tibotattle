export const CODEX_PLAN_TYPES: readonly ["free", "go", "plus", "pro", "prolite", "promax", "team", "self_serve_business_prolite", "self_serve_business_usage_based", "business", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise", "edu", "edu_plus", "edu_pro", "sci", "sci_plus", "unknown"];
export type CodexPlanType = typeof CODEX_PLAN_TYPES[number];
export const CODEX_PLAN_DISPLAY_NAMES: Readonly<Record<Exclude<CodexPlanType, "unknown">, string>>;

export type ReviewedCodexModelId =
  "gpt-4.1"
  | "gpt-5"
  | "gpt-5.4"
  | "gpt-5.4-mini"
  | "gpt-5.5"
  | "gpt-5.5-codex"
  | "gpt-5.6-luna"
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "codex-auto-review"
  | "gpt-4-turbo-2024-04-09"
  | "gpt-4.1-mini"
  | "gpt-4.1-nano"
  | "gpt-4o"
  | "gpt-4o-2024-05-13"
  | "gpt-4o-mini"
  | "gpt-5-codex"
  | "gpt-5-mini"
  | "gpt-5-nano"
  | "gpt-5-pro"
  | "gpt-5.1"
  | "gpt-5.1-codex"
  | "gpt-5.1-codex-mini"
  | "gpt-5.2"
  | "gpt-5.2-codex"
  | "gpt-5.2-pro"
  | "gpt-5.3-codex"
  | "gpt-5.3-codex-spark"
  | "gpt-5.4-nano"
  | "gpt-5.4-pro"
  | "gpt-5.5-pro"
  | "gpt-5.6-sol-wm"
  | "gpt-6-astra"
  | "o1"
  | "o1-pro"
  | "o3"
  | "o3-mini"
  | "o3-pro"
  | "o4-mini"
  | "gpt-6-sol"
  | "gpt-6-luna"
  | "gpt-6.1-astra"
  | "gpt-6.1-sol"
  | "gpt-5.1-codex-max"
  | "gpt-6.1-terra";

export interface ReviewedModelIdentity {
  readonly id: ReviewedCodexModelId;
  readonly label: string;
  readonly provider: "openai_codex";
  readonly allowanceTrack: "primary" | "spark";
  readonly pricingStatus: "published" | "assumed_alias" | "unpriced";
  readonly priceModelId: ReviewedCodexModelId | null;
}
export const REVIEWED_MODEL_CATALOG_VERSION: "reviewed-model-catalog-2026-10-28.1";
export const REVIEWED_MODEL_CATALOG: readonly ReviewedModelIdentity[];
export const REVIEWED_CODEX_MODEL_IDS: readonly ReviewedCodexModelId[];
export function reviewedModelIdentity(value: unknown): ReviewedModelIdentity | null;
export type ReviewedModelVocabularyEntry =
  Omit<ReviewedModelIdentity, "label">;
export interface ReviewedModelCatalogCompleteness {
  readonly version: typeof REVIEWED_MODEL_CATALOG_VERSION;
  readonly identityCount: number;
  readonly modelIds: readonly string[];
  readonly identities: readonly ReviewedModelVocabularyEntry[];
}
export function assertReviewedModelCatalogCompleteness(
  options?: { catalog?: readonly ReviewedModelIdentity[] },
): ReviewedModelCatalogCompleteness;
export function codexRequestReasoningEffort(modelId: unknown, effort: unknown):
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "unknown" | null;
export function codexCacheReasoningConfiguration(modelId: unknown, effort: unknown):
  ReturnType<typeof codexRequestReasoningEffort>;
