import {
  REVIEWED_CODEX_MODEL_IDS,
  TELEMETRY_MODEL_IDS,
} from "@app-usagemonitor/telemetry-contract";

// These identify the existing v0.1 wire dictionary, not current provider support.
export const TELEMETRY_V01_REGISTRY_VERSION = "telemetry-v0.1-registry-2026-10-19.1";
export const TELEMETRY_V01_REVIEWED_AT = "2026-10-19";

export const OPENAI_CODEX_MODEL_IDS = REVIEWED_CODEX_MODEL_IDS;

// Codex-emitted model identities that are reviewed and safe to display but
// that OpenAI publishes no API price card for. They are deliberately kept
// distinct from arbitrary unknown labels: a reader must be able to tell
// "we know what this is and chose not to invent a price" apart from
// "we have never seen this identifier". Never move an id here to silence a
// pricing gap for a model that does have a published card.
export const OPENAI_CODEX_UNPRICED_MODEL_IDS = Object.freeze([
  // `codex-auto-review` is no longer here: it is now priced as an alias of
  // gpt-5.4 by owner direction, with the assumption and its known limits
  // recorded in OPENAI_ALIAS_ASSUMPTIONS. It draws on the ordinary Codex
  // allowance, so an API-equivalent figure for it is comparable.
  // Spark is metered against its own subscription allowance, so it is not
  // merely unpriced - an API-equivalent figure for it is not comparable with
  // the primary pool at all.
  "gpt-5.3-codex-spark",
  // Reviewed as a forecast identity, with no published API price card.
  "gpt-6.1-astra",
]);

export const OPENAI_CODEX_SPARK_MODEL_ID = "gpt-5.3-codex-spark";
export const OPENAI_CODEX_SPARK_LIMIT_ID = "codex-spark";

export const OPENAI_CODEX_LIMIT_IDS = Object.freeze([
  "codex",
  "codex-spark",
]);

export const EXPORT_DIAGNOSTIC_CODES = Object.freeze([
  "collector_empty_lines",
  "collector_irrelevant_records",
  "collector_out_of_bounds_records",
  "collector_oversized_irrelevant_lines",
  "collector_unsupported_schema_records",
  "collector_unsupported_source_records",
  "cumulative_prefix_unattributed",
  "fork_replay_events_skipped",
  "last_only_events",
  "lineage_parents_missing",
  "malformed_lines",
  "malformed_rate_limit_records",
  "malformed_task_events",
  "malformed_timestamps",
  "malformed_usage_records",
  "missing_rate_limit_records",
  "replayed_events_skipped",
  "replayed_tool_calls_skipped",
  "response_unverified_prefix_turns",
  "unattached_tool_calls",
  "unattributed_fork_replay_events_skipped",
]);

export const TELEMETRY_PROVIDER_IDS = Object.freeze([
  "openai_codex",
]);

const modelIds = new Set(OPENAI_CODEX_MODEL_IDS);
const limitIds = new Set(OPENAI_CODEX_LIMIT_IDS);
const providerByModelId = new Map([
  ...OPENAI_CODEX_MODEL_IDS.map((id) => [id, "openai_codex"]),
]);
const providerByLimitId = new Map(
  OPENAI_CODEX_LIMIT_IDS.map((id) => [id, "openai_codex"]),
);
const codexModelIds = new Set(OPENAI_CODEX_MODEL_IDS);
const codexUnpricedModelIds = new Set(OPENAI_CODEX_UNPRICED_MODEL_IDS);

export function recognizedExportModelId(value) {
  return recognizedCodexModelId(value);
}

export function recognizedCodexModelId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return codexModelIds.has(normalized) ? normalized : null;
}

// The three model-identity states every display surface has to be able to
// tell apart:
//   "priced"         - recognised, and an official API price card exists.
//   "known_unpriced" - recognised, but deliberately carries no price.
//   "unrecognized"   - never reviewed; the identifier is withheld entirely.
export function codexModelPricingStatus(value) {
  const modelId = recognizedCodexModelId(value);
  if (modelId === null) return "unrecognized";
  return codexUnpricedModelIds.has(modelId) ? "known_unpriced" : "priced";
}

// Which subscription allowance the identity is metered against. Spark has its
// own allowance, so its usage must never be pooled with - or compared in
// money terms against - the primary Codex track.
export function codexModelAllowanceTrack(value) {
  return recognizedCodexModelId(value) === OPENAI_CODEX_SPARK_MODEL_ID
    ? "spark"
    : "primary";
}

// False only where an API-price equivalent is not a meaningful figure to
// quote at all, as opposed to merely missing. A separate allowance is not
// substitutable for the primary pool, so no dollar comparison is honest.
export function codexModelApiPriceEquivalentApplicable(value) {
  return codexModelAllowanceTrack(value) !== "spark";
}

/**
 * The reviewed Codex model-identity -> provider mapping, and the limit-identity
 * one for records that carry no model. "unknown" is deliberate; an identifier
 * this registry has never reviewed must not be attributed by guess.
 */
export function exportModelProvider(value) {
  if (typeof value !== "string") return "unknown";
  return providerByModelId.get(value.toLowerCase()) ?? "unknown";
}

export function exportLimitProvider(value) {
  if (typeof value !== "string") return "unknown";
  return providerByLimitId.get(
    value.toLowerCase().replaceAll("_", "-"),
  ) ?? "unknown";
}

export function recognizedExportLimitId(value) {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return limitIds.has(normalized) ? normalized : "unknown";
}

// Only the compatibility tuple consumes this historical serialized dictionary.
// Product dispatch uses TELEMETRY_PROVIDER_IDS and the Codex-only recognizers.
// Retaining its identifiers does not register a reader, price card or adapter.
export function exportRegistrySnapshot() {
  return {
    schemaVersion: TELEMETRY_V01_REGISTRY_VERSION,
    reviewedAt: TELEMETRY_V01_REVIEWED_AT,
    evidence: "reviewed_local_observations_and_repository_fixtures",
    providers: {
      openai_codex: {
        modelIds: [...OPENAI_CODEX_MODEL_IDS],
        limitIds: [...OPENAI_CODEX_LIMIT_IDS],
      },
      anthropic_claude_code: {
        modelIds: TELEMETRY_MODEL_IDS.filter(id => id.startsWith("claude-")).sort(),
        limitIds: [],
      },
    },
    diagnosticCodes: [...EXPORT_DIAGNOSTIC_CODES],
  };
}
