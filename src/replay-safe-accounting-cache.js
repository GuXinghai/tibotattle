import { DEFAULT_UNKNOWN_SPEED_POLICY, validateUnknownSpeedPolicy, unknownSpeedScenario, unknownSpeedCalculationIdentity, unknownSpeedCalibrationOptions, mixUnknownSpeedUsd } from "./unknown-speed-policy.js";
import { speedApiPrice, addSpeedApiCost, speedApiCostSummary } from "./speed-api-cost.js";
import { createLocalRefreshTimer } from "./local-refresh-timing.js";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import { buildWeeklyApiIntervals, validWeeklyApiIntervals, unavailableWeeklyApiIntervals } from "./weekly-api-intervals.js";
import {
  CODEX_TRANSITION_DERIVATION_CEILINGS,
  deriveCodexTransitionSeriesCooperatively,
  PARSER_VERSION,
} from "./codex-transition-miner.js";
import { validAbortSignal } from "./valid-abort-signal.js";
import {
  codexModelAllowanceTrack,
  codexModelApiPriceEquivalentApplicable,
  codexModelPricingStatus,
  OPENAI_CODEX_SPARK_MODEL_ID,
  recognizedCodexModelId,
} from "./export/index.js";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  createExportResourceGuard,
  ExportResourceLimitError,
} from "./export-resource-policy.js";
import {
  addUsdStrings,
  costWarningCodes,
  emptySpeedWeightingCrossing,
  speedModeModelFamilyKey,
  quotaWeightedApiPriceEquivalent,
  FAST_MODE_ASSUMED_MULTIPLIER,
  FAST_MODE_QUOTA_MULTIPLIERS,
  LOCAL_API_PRICING_METHOD_VERSION,
  priceCodexUsageEvent,
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
} from "@app-usagemonitor/accounting";
import { codexPrimaryAllowanceBasis } from "./codex-primary-allowance-basis.js";
import {
  analyzeQuotaPace,
  blendedCompositionCapacityUsd,
  buildCompositionObservations,
  buildPlanAttributionIndex,
  classifyUsageAttribution,
  calibrateCompositionCapacities,
  FIVE_HOUR_WINDOW_MINUTES,
  isValidQuotaWindowDuration,
  MODEL_COMPOSITION_POLICY,
  planAttributionContextKey,
  planEraForInterval,
  SEVEN_DAY_WINDOW_MINUTES,
} from "@app-usagemonitor/quota-analysis";
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
import {
  addComponentCosts as addComponentCostsApproximate,
  emptyComponentCosts,
  SPARK_QUOTA_LIMIT_IDS,
} from "./local-companion-usage-model.js";
import {
  defaultLocalCollectorStatePath,
  prepareLocalCollectorState,
  readLocalCollectorAccountingCache,
  readLocalCollectorPreservedAccountingHistory,
  serializeLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "./local-collector-state.js";
import { stableJson } from "./storage.js";
import {
  BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT,
  projectBoundedWeeklyCalibrationSummary,
  validWeeklyPlanPopulations,
} from "./reporting/index.js";

// v0.4 added per-model allowance-track and API-price-applicability state, and
// the combined `modelUsage` row set. v0.5 (2026-08-08) sources the weekly
// calibration transition corpus from the unified local index when one is
// present — the corpus then spans the whole indexed history rather than the
// scan window — and records that provenance in `weeklyCalibrationInput.source`
// and `.coveredAt`. A v0.4 cache's calibration was silently bounded by its
// scan window, so it is withheld and rebuilt rather than shown as full
// history.
// v0.6: quota-track identity became slot-agnostic (keyed on limitId +
// duration). A v0.5 cache derived its weekly calibration with pre-Jul-12
// history filtered out by slot, so it is withheld and rebuilt rather than
// blended with the restored corpus.
// v0.7 (2026-08-11): the weekly calibration gained the composition-aware
// per-model $/pp vector (`weeklyCalibration.composition`, NNLS over the same
// corpus — design: docs/design/composition-aware-expected-line.md). A v0.6
// cache carries no composition block and its expected line silently misreads
// model mix as deviation, so it is withheld and rebuilt rather than served
// alongside surfaces that now assume the fit can exist.
// v0.8 (2026-08-11): the scan retains Spark quota snapshots under every id in
// SPARK_QUOTA_LIMIT_IDS. A v0.7 cache matched the reserved marketing token
// ("codex-spark") only, while real captures report "codex_bengalfox", so its
// `sparkQuotaTimeline` is empty against every capture to date; it is withheld
// and rebuilt rather than served as evidence that no Spark quota history
// exists.
// v0.9 (2026-08-17): each 15-minute usage bucket retains a sparse observed and
// declared speed/model-family crossing, and the cache carries independently
// fitted unresolved-as-Standard and unresolved-as-Fast weekly capacities.
// Allowance-facing readers can therefore couple every weighted numerator to a
// denominator derived under the same scenario without replaying raw events.
// v0.10 (2026-08-17): production refreshes select the unified typed index by
// default, record the source/generation/context contract, and attach a
// separate full-history period. A v0.9 cache cannot prove which scanner or
// generation produced its totals, so it is withheld and rebuilt.
// v0.11 (2026-08-19): the retained pace forecast names its two rates
// separately and its ETA follows the wall-clock one. A v0.10 cache carries a
// single `percentagePointsPerHour` whose ETA assumed the reader never paused,
// so it is withheld and rebuilt rather than reinterpreted.
// v0.12 (2026-08-19): every `byModel` row carries its own token components and
// per-component priced cost, so the model table and the component bars are the
// two margins of one crossing that can now be read cell by cell. A v0.11 row
// holds only its totals, and the missing cells cannot be recovered by dividing
// them, so the cache is withheld and rebuilt rather than served with the
// components silently absent.
// v0.13 (2026-08-30): speed crossings use canonical registered models and
// event-qualified Priority cards. Old prefix-family crossings cannot recover
// the model/context/epoch eligibility, so they must be rebuilt, not relabeled.
// v0.14: exact occurrence plans and bounded quantity intervals survive compact
// replay; plan-era populations replace provider-wide calibration numerators.
// v0.15: the selected plan gets its own generation-bound, plan-era-attributed
// usage timeline. The ordinary timeline remains the conserved all-plan ledger;
// allowance-facing Trends may use the scoped timeline only when its plan,
// generation, basis and fitted-reset cohort match the selected capacity.
// v0.16: the calibration corpus retains both main Codex allowance durations
// and stores a plan-separated five-hour fit. A v0.15 cache discarded every
// 300-minute main-track snapshot, so that evidence cannot be reconstructed at
// read time and the five-hour history must remain unavailable until rebuild.
// v0.17: third-mode crossings and explicit unavailable Ultrafast scenarios.
// Never reuse a binary-speed cache under the new weighting contract.
// v0.18: preserve unavailable context/components and derive fast-plan context
// bands from reviewed cards. Rebuild prior totals rather than treating unknown
// context as zero or reusing a short-context plan above a model's threshold.
// v0.19: retain event-speed API valuations and their component/provenance
// coverage separately from the unchanged Standard and quota-analysis metrics.
// v0.20: independently fenced historical-plan comparison projections. Rebuild
// older caches; historical absence must not be mistaken for absent source usage.
// v0.21: preserve observed quota outside comparable intervals independently.
// v0.22: rebuild prices with model-wide context partitions and preserve nullable
// local-index components, contradictory output and partial/assumed provenance.
// v0.23: derive every displayed monetary margin from exact decimal accumulation
// so weighted groups and individual events have identical half-up rounding.
// v0.25: require the exact public API-pricing method and rebuild caches produced
// before missing-component coverage and Date timestamp support were corrected.
export const REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION =
  "local-replay-safe-accounting-v0.26";
const ALLOWANCE_CAPACITY_SCHEMA_VERSION =
  "codex-primary-allowance-capacity-v0.2";
const PLAN_SCOPED_TIMELINE_SCHEMA_VERSION =
  "local-plan-scoped-accounting-timeline-v2";
const PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION = "plan-era-v1";
const ALLOWANCE_SCENARIO_CANDIDATES = Object.freeze({
  unresolved_as_standard: "speed_lower",
  unresolved_as_fast: "speed_upper",
  unresolved_as_custom: "speed_custom",
});

export const REPLAY_SAFE_ACCOUNTING_SOURCE_MODES = Object.freeze([
  "unified",
]);

export const REPLAY_SAFE_ACCOUNTING_CONTEXT_BEHAVIORS = Object.freeze([
  "source_native",
]);

const DEFAULT_ACCOUNTING_CONTEXT_BEHAVIOR = "source_native";
const SOURCE_DESCRIPTOR_VERSION = "local-accounting-source-descriptor-v1";
const GENERATION_TOKEN = /^[A-Za-z0-9._:-]{1,256}$/u;
const ACCOUNTING_SOURCE_ERROR_CODES = Object.freeze({
  local_unified_index_missing: "accounting_unified_index_missing",
  local_unified_index_unavailable: "accounting_unified_index_unavailable",
  local_unified_index_file_invalid: "accounting_unified_index_unavailable",
  local_unified_index_file_changed: "accounting_unified_generation_changed",
  local_unified_index_schema_invalid: "accounting_unified_index_incompatible",
  local_unified_index_schema_newer: "local_unified_index_schema_newer",
  local_unified_index_compatibility_invalid: "accounting_unified_index_incompatible",
  local_unified_index_meta_invalid: "accounting_unified_index_invalid",
  local_unified_index_row_invalid: "accounting_unified_index_invalid",
  local_unified_index_accounting_coverage_incomplete:
    "accounting_unified_coverage_incomplete",
  local_unified_index_generation_mismatch:
    "accounting_unified_generation_mismatch",
  local_unified_index_read_aborted: "accounting_refresh_aborted",
  local_unified_index_callback_failed: "accounting_unified_callback_failed",
  local_unified_index_read_failed: "accounting_unified_read_failed",
});

const HISTORICAL_PRICE_EPOCH_BASIS =
  "event_time_when_registry_has_effective_evidence";

// Bound the compact durable cache, independently of the rebuild's RSS guards
// and the optional plan-scoped lane's own row/byte limits. This is a resource
// ceiling, not a history window or a preallocated memory budget.
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
// Standing owner rule (2026-08-08, stated after five rounds of cap-shuffling):
// NEVER introduce or retain small data-window caps. A history limit is either
// absent or extreme (365+ days), never convenience-sized — 31 and 93 were
// both wrong. The floor makes a convenience-sized window unrepresentable; the
// ceiling is a ten-year typo guard, not a data-window policy.
const MINIMUM_WINDOW_DAYS = 365;
const MAXIMUM_WINDOW_DAYS = 3_653;
const DEFAULT_WINDOW_DAYS = MINIMUM_WINDOW_DAYS;
const TIMELINE_BUCKET_MS = 15 * 60 * 1_000;
// Resource ceilings, not retention windows: refuse this optional comparison
// lane as a whole rather than truncating history or failing ordinary accounting.
const MAX_PLAN_TIMELINE_ROWS = 100_000;
const MAX_PLAN_TIMELINE_BYTES = 4 * 1024 * 1024;
const PLAN_TIMELINE_ENCODING = "plan_bucket_v2";
const MAX_QUOTA_TIMELINE_ROWS = 10_000;
const WEEKLY_WINDOW_MINUTES = SEVEN_DAY_WINDOW_MINUTES;
const ALLOWANCE_HISTORY_WINDOW_MINUTES = new Set([
  FIVE_HOUR_WINDOW_MINUTES,
  WEEKLY_WINDOW_MINUTES,
]);
const SPARK_MODEL = OPENAI_CODEX_SPARK_MODEL_ID;
const PACE_CURRENT_MAX_AGE_MS = 30 * 60_000;
const PACE_STATUSES = new Set([
  "unavailable",
  "insufficient_observations",
  "available",
  "will_reach_reset_first",
]);
const ACCOUNT_SCOPE_ID_PATTERN = /^openai-account:v1:[A-Za-z0-9_-]{43}$/u;
const ACCOUNT_TRACK_ID_PATTERN = /^account-track:v1:[a-f0-9]{64}$/u;
const MAX_RETAINED_TRANSITION_BYTES = 320 * 1024 * 1024;
// ---------------------------------------------------------------------------
// The accounting rebuild's memory policy. Two numbers, set by hand:
//
//   MAX_ACCOUNTING_RSS_BYTES          absolute whole-process RSS target
//   ACCOUNTING_RSS_DELTA_BUDGET_BYTES what one pass may ADD over its own
//                                     start-of-build baseline
//
// A pass runs under min(MAX_ACCOUNTING_RSS_BYTES,
// baselineRss + ACCOUNTING_RSS_DELTA_BUDGET_BYTES), so the two only mean
// anything together: raising the absolute while leaving the delta behind moves
// nothing at all off a clean baseline, and raising the delta alone can never
// pass the absolute. Change them as a PAIR.
//
// The rebuild runs in process (the companion's own process). The resident
// companion's archive projection has a separate pair, MAX_ARCHIVE_ACCOUNTING_RSS_BYTES
// and ARCHIVE_ACCOUNTING_RSS_DELTA_BUDGET_BYTES, further down. Nothing here is a
// default for anything there; that inheritance is the bug they exist to close.
// ---------------------------------------------------------------------------
// Absolute whole-process RSS TARGET for one accounting rebuild. It is a
// TARGET, not a hard blocker: a miss degrades to a retained-cache soft-fail
// rather than failing the refresh (see refreshReplaySafeAccountingCache and
// ACCOUNTING_BUDGET_MISS_CODES). It remains the backstop that stops a runaway
// pass before it can OOM the process.
//
// The number has moved twice, and both moves are worth keeping:
//
//   1.5 -> 2 GiB (2026-08-11), after a live 0.1.6 incident: the
//     transition-mining pass tripped at ~1.6 GB whole-process RSS on a
//     companion idling near ~800 MB, and the throw hard-failed the entire
//     refresh — blanking the dashboard and flip-flopping every 5 minutes as
//     the scheduler re-ran the doomed pass. That incident is why a miss is
//     soft today.
//   2 -> 6 GiB (2026-08-20, owner directive), recorded below.
//
// What 6 GiB rests on is the owner's REAL corpus rather than a model of it,
// and the distinction is the whole point. The pair this replaces (2 GiB
// absolute / 1.25 GiB delta) was held earlier the same day on the strength of
// a SYNTHETIC 572,000-event corpus that peaked at 485 MiB of RSS growth in the
// child — a measurement which argued the ceiling already carried ~2.7x the
// need and therefore could not be what was failing. The real corpus is 4,886
// sources, 128.5 GB indexed, 572,089 all-time events, and it does not behave
// like that model. Dogfood build 1020 — which already carries BOTH the
// rebuild's move into an isolated child (#38), since retired, and the child heap
// cap derived from this constant (#45) — still deferred at 2026-08-20T15:02Z: refresh
// status "succeeded", accountingRebuildDeferred {status: "deferred", reason:
// "accounting_transition_rss_limit_exceeded", retained: true, consecutive: 1},
// and accounting.historyCoverage stuck at "partial" /
// "cache_generation_mismatch" against an index that was itself fully complete
// (4,886/4,886 sources, 0 pending). Isolation was supposed to have retired
// that class of deferral. On real data it did not, so the ceiling does bind
// here and the synthetic peak is not evidence about this corpus.
//
// No measured child peak on the real corpus stands behind 6 GiB either: the
// one live sampling attempt landed inside the post-deferral backoff, so no
// rebuild ran during it and it measured nothing. The number is therefore set
// for HEADROOM rather than fitted to a peak — deliberately, because that is
// the cheaper error in both directions. A rebuild is a bounded pass whose
// transient growth is returned to the OS afterwards, so ceiling headroom that goes
// unused costs literally nothing; a ceiling trimmed to a measured peak buys a
// fresh diagnosis cycle the first time the corpus grows past it, and this
// corpus grows every day. The guard is not being removed — a runaway still
// climbs into it and still stops — it is being moved off the path of an
// ordinary large install, so that what fires is a defect and not a big
// history.
//
// Consequence to know before touching this number: its reach STOPS at the
// rebuild. The archive projection that the resident companion runs resolves
// its own ceiling from MAX_ARCHIVE_ACCOUNTING_RSS_BYTES below, and must not
// follow this constant: headroom is cheap in a rebuild, not in a resident
// process.
const MAX_ACCOUNTING_RSS_BYTES = Math.floor(6 * 1024 * 1024 * 1024);
// What one accounting rebuild may itself ADD to process RSS over the baseline
// captured at build start. The effective ceiling is
// min(MAX_ACCOUNTING_RSS_BYTES, baselineRss + this delta), so the delta must
// be large enough that a NORMAL baseline reaches the absolute target rather
// than capping the pass below it. The old 512 MiB delta is exactly what made
// the 2026-08-11 incident inevitable: with the ~800 MB live baseline it capped
// the build at ~1.3 GB — BELOW the 1.6 GB the pass actually needed — so the
// miss was structural, not a real leak.
//
// 5.25 GiB (2026-08-20, owner directive), moved in lockstep with the absolute
// target above because the rebuild runs in process and THIS is the number that
// actually binds from a clean baseline. Off a ~60 MB baseline the effective
// ceiling is baseline + delta and never the absolute, so the previous 1.25 GiB
// delta pinned every rebuild at ~1.31 GiB however high the absolute went —
// which is precisely why build 1020 kept deferring under a 2 GiB absolute that
// looked like ample room. At 5.25 GiB the effective ceiling is
// ~5.31 GiB, and MAX_ACCOUNTING_RSS_BYTES becomes what binds only above a
// ~768 MiB baseline (6 - 5.25 GiB), i.e. for an in-process build off a fat
// companion — which is the arm it was always meant to police.
//
// This is still a backstop and not an absence: a regression back to O(corpus)
// residency on a corpus this size climbs into 5.31 GiB and stops the pass, as
// a metered deferral with the prior cache retained and served.
const ACCOUNTING_RSS_DELTA_BUDGET_BYTES = Math.floor(5.25 * 1024 * 1024 * 1024);
// A memory-budget miss — whole-process RSS over the effective ceiling, the
// scan guard's own RSS trip, or the per-row retained-byte meter over budget —
// is a soft TARGET miss, not a hard failure. refreshReplaySafeAccountingCache
// catches exactly these codes, retains the last good on-disk cache untouched,
// and reports a degraded/deferred outcome instead of throwing and blanking the
// dashboard. Every OTHER accounting_* stop (input-count ceilings, source-size
// safety stops, aborts, measurement-invalid) stays hard by design.
const ACCOUNTING_BUDGET_MISS_CODES = new Set([
  "accounting_transition_rss_limit_exceeded",
  "accounting_transition_memory_budget_exceeded",
  "accounting_scan_rss_limit_exceeded",
]);
const ACCOUNTING_READER_PASSTHROUGH_CODES = new Set([
  ...Object.values(ACCOUNTING_SOURCE_ERROR_CODES),
  "accounting_refresh_aborted",
  "accounting_scan_source_bytes_limit_exceeded",
  "accounting_scan_rss_limit_exceeded",
  "accounting_transition_rss_measurement_invalid",
  "accounting_transition_rss_limit_exceeded",
  "accounting_transition_memory_budget_exceeded",
  "accounting_transition_usage_limit_exceeded",
  "accounting_transition_snapshot_limit_exceeded",
  "accounting_transition_input_limit_exceeded",
  "accounting_transition_derivation_limit_exceeded",
  "accounting_archive_rss_measurement_invalid",
  "accounting_archive_rss_limit_exceeded",
  "accounting_unified_coverage_unavailable",
  "accounting_unified_generation_unavailable",
  "accounting_unified_generation_required",
  "accounting_unified_history_unavailable",
]);
const ACCOUNTING_RSS_CHECK_INTERVAL = 2_048;
// ---------------------------------------------------------------------------
// The ARCHIVE projection's own ceiling, deliberately NOT the rebuild's.
//
// buildReplaySafeAccountingPeriod has two callers with opposite memory
// situations, and until 2026-08-20 they shared one number by inheritance
// rather than by decision:
//   - the rebuild calls it as a sub-build and NAMES its own ceiling (the
//     effective target it already computed), so it is unaffected by anything
//     here and must stay that way;
//   - the resident companion's archive projection names nothing, and runs
//     inside a process the user leaves running all day.
// A ceiling sized for one rebuild pass is the wrong ceiling for that process.
// The 2 -> 6 GiB rebuild raise reached this path only because the default was
// never chosen; that is the defect these two constants close.
//
// The shape is baseline + delta rather than a bare absolute, and that is the
// substance of the fix rather than a stylistic echo of the rebuild policy. A
// whole-process absolute cannot work in the companion, because it charges the
// pass for memory the pass did not allocate and cannot free. Measured on the
// owner's own machine (dogfood 0.1.13 build 1020, 4,886 sources / 128.5 GB
// indexed), the resident companion oscillates between 1,312 and 2,089 MiB
// across a twenty-second window — it crosses 2 GiB on GC timing alone. Under
// the pre-raise 2 GiB absolute this projection would therefore have deferred
// or not deferred depending on when V8 last collected, which is the worst of
// the available failure modes: not a bound, a coin flip. A delta measured off
// THIS pass's own baseline is the only arm that attributes growth to the pass
// that caused it.
//
// 512 MiB of delta is set against a measured need, not a guess. Streaming a
// corpus the size of the owner's real one (572,089 events over two years,
// with production dimension cardinality across model, speed, service tier,
// surface, agent scope and lineage) through this builder peaks at 98.6 MiB of
// RSS growth. Doubling and quadrupling that stream — 1.14M and 2.29M events —
// peaks at 119.8 MiB and 113.9 MiB, i.e. FLAT. That is the constant-memory
// contract in the builder's own doc comment holding up under measurement: the
// aggregate is fixed-shape and retains no raw inputs, so its residency tracks
// dimension cardinality and not corpus size. 512 MiB is roughly 4x the peak
// at 4x the owner's corpus, which is headroom for cardinality drift and lazy
// GC without being room for a regression to hide in. Note what this delta is
// NOT: it is not the 512 MiB that made the 2026-08-11 incident inevitable.
// That number was applied to the REBUILD, whose transition mining genuinely
// needs gigabytes; applying it to a pass measured flat at ~100 MiB is a
// different claim with different evidence behind it.
const ARCHIVE_ACCOUNTING_RSS_DELTA_BUDGET_BYTES = Math.floor(
  512 * 1024 * 1024,
);
// The absolute backstop over the delta, and the arm that stops the companion
// being driven into swap by a projection off an already-enormous baseline.
// 3 GiB is picked so that on real hardware the DELTA is what binds: at the
// companion's observed 2,089 MiB peak the effective ceiling is
// min(3 GiB, ~2.54 GiB) = ~2.54 GiB, leaving the pass its full 512 MiB
// against a measured need near 100 MiB. The absolute takes over only above a
// ~2.5 GiB baseline — a companion half again the size of the fattest yet
// observed — and above that line refusing to add another half gigabyte is the
// correct answer rather than a regrettable one. This is a real cliff and is
// meant to be, and it is survivable in the exact way that matters: the trip
// is caught and reported as archive_projection_unavailable, never a failed
// refresh and never a lost index — the indexing pass has already committed by
// the time the projection runs. The prior projection is left on disk and goes
// on being served until the index advances past its coverage fingerprint,
// after which the surface reads unavailable rather than stale. Past this line
// the companion's size is the bug to fix, not the ceiling.
const MAX_ARCHIVE_ACCOUNTING_RSS_BYTES = Math.floor(3 * 1024 * 1024 * 1024);
// The memory policy as the tests and any future caller should read it: derived
// from the constants above rather than mirrored, so a regression can pin the
// RELATIONSHIPS (cap >= absolute >= effective ceiling) without going stale the
// next time the numbers move, and one deliberate tripwire can pin the VALUES.
export const REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY = Object.freeze({
  maximumRssBytes: MAX_ACCOUNTING_RSS_BYTES,
  rssDeltaBudgetBytes: ACCOUNTING_RSS_DELTA_BUDGET_BYTES,
  // The resident archive projection's ceiling, carried here so a regression
  // can pin that it is SEPARATE from the rebuild's rather than trusting the
  // two to stay apart by accident. Every field above describes a process that
  // exits after one pass; these two describe one that does not.
  archiveMaximumRssBytes: MAX_ARCHIVE_ACCOUNTING_RSS_BYTES,
  archiveRssDeltaBudgetBytes: ARCHIVE_ACCOUNTING_RSS_DELTA_BUDGET_BYTES,
});
const COMPACT_USAGE_RETAINED_BYTES = 352;
const COMPACT_SNAPSHOT_RETAINED_BYTES = 192;
// Exact typed-buffer storage: two Float64 stamp columns, then Uint8 +
// Int32 + Float64 + Uint8 attribution memo columns. SQLite page objects,
// dictionaries and decoded batches remain covered by the unchanged RSS guard.
const STREAMED_USAGE_STAMP_BYTES = 16;
const STREAMED_USAGE_MEMO_BYTES = 14;
const DEFAULT_TRANSITION_RESOURCE_LIMITS = Object.freeze({
  usageEvents: CODEX_TRANSITION_DERIVATION_CEILINGS.usageEvents,
  weeklySnapshots:
    CODEX_TRANSITION_DERIVATION_CEILINGS.rateLimitSnapshots,
  combinedInputs: CODEX_TRANSITION_DERIVATION_CEILINGS.totalInputs,
  retainedBytes: MAX_RETAINED_TRANSITION_BYTES,
});
const COMPONENT_KEYS = Object.freeze([
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
]);
const SPEEDS = new Set(["standard", "fast", "ultrafast", "flex", "batch", "unknown"]);
const API_TIERS = new Set(["standard", "priority", "ultrafast", "flex", "batch", "unknown"]);
const SURFACES = new Set([
  "extension_or_ide",
  "scheduled_task",
  "subagent",
  "cli_exec",
  "work",
  "workspace_agent",
  "excel",
  "voice_task",
  "unknown",
]);
const AGENT_SCOPES = new Set(["root", "subagent", "automation", "unknown"]);
const LINEAGE = new Set(["standalone", "forked", "parent_linked", "unknown"]);
const QUOTA_PLANS = new Set(TELEMETRY_PLAN_TYPES);
const QUOTA_SLOTS = new Set(["primary", "secondary"]);

// The exact shape Date#toISOString produces for years 0000 through 9999. A
// string of this shape whose fields are in range is the unique canonical
// representation of its instant; anything else takes the round trip below.
// Copied from the retired unified accounting source, which this module no
// longer imports.
const CANONICAL_INSTANT_SHAPE =
  /^(d{4})-(d{2})-(d{2})T(d{2}):(d{2}):(d{2}).d{3}Z$/u;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(year, month) {
  if (month !== 2) return DAYS_IN_MONTH[month - 1];
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
}

function canonicalInstant(value) {
  if (typeof value !== "string") return null;
  const shape = CANONICAL_INSTANT_SHAPE.exec(value);
  if (shape !== null) {
    const month = Number(shape[2]);
    const day = Number(shape[3]);
    return month >= 1 && month <= 12
      && day >= 1 && day <= daysInMonth(Number(shape[1]), month)
      && Number(shape[4]) <= 23
      && Number(shape[5]) <= 59
      && Number(shape[6]) <= 59
      ? value
      : null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
      && new Date(timestamp).toISOString() === value
    ? value
    : null;
}

function fixedError(code, name = "Error") {
  const error = new Error(code);
  error.name = name;
  error.code = code;
  return error;
}

// The shipping store is the only accounting source. A caller that names any
// other mode is refused here; a stored cache that names one is reported as a
// source-mode mismatch by the reader rather than served.
function normalizeAccountingSourceMode(value) {
  const selected = value ?? "unified";
  if (selected !== "unified") {
    throw new TypeError("sourceMode must be unified");
  }
  return selected;
}

function normalizeContextBehavior(value, {
  defaultValue = DEFAULT_ACCOUNTING_CONTEXT_BEHAVIOR,
} = {}) {
  const selected = value ?? defaultValue;
  if (!REPLAY_SAFE_ACCOUNTING_CONTEXT_BEHAVIORS.includes(selected)) {
    throw new TypeError("contextBehavior is invalid");
  }
  return selected;
}

function generationToken(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return GENERATION_TOKEN.test(value) ? value : null;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of ["generation", "generationId", "id", "fingerprint"]) {
    if (Object.hasOwn(value, key)) {
      const token = generationToken(value[key]);
      if (token !== null) return token;
    }
  }
  return null;
}

// SQLite stores the published generation id in the TEXT-valued meta table.
// Keep generation fingerprints byte-for-byte exact, but accept the
// integer-like decimal spelling SQLite can produce for an id (for example,
// `"1.0"`) and compare it using the same canonical token as the reader's
// numeric generation descriptor.
function generationIdMetaToken(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;
  }
  if (typeof value !== "string" || !/^\d+(?:\.0+)?$/u.test(value)) {
    return null;
  }
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0
    ? String(numeric)
    : null;
}

function expectedGenerationIdToken(value) {
  return generationIdMetaToken(value) ?? generationToken(value);
}

function scannerGeneration(scanned) {
  return generationToken(
    scanned?.generation
      ?? scanned?.generationId
      ?? scanned?.coverage?.generation
      ?? scanned?.coverage?.generationId
      ?? scanned?.coverage?.generationFingerprint
      ?? scanned?.coverage?.fingerprint,
  );
}

function scannerGenerationTokens(scanned) {
  const values = [
    scanned?.generation,
    scanned?.generationId,
    scanned?.generationFingerprint,
    scanned?.coverage?.generation,
    scanned?.coverage?.generationId,
    scanned?.coverage?.generationFingerprint,
    scanned?.coverage?.fingerprint,
  ];
  return [...new Set(values.map(generationToken).filter((value) => value !== null))];
}

function expectedGenerationParts(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    const token = generationToken(value);
    return token === null
      ? null
      : { opaque: token, id: null, fingerprint: null };
  }
  const collect = (keys, tokenForValue = generationToken) => {
    const present = keys.filter((key) => Object.hasOwn(value, key));
    const tokens = present.map((key) => tokenForValue(value[key]));
    if (tokens.some((token) => token === null)) return null;
    const unique = [...new Set(tokens)];
    return unique.length <= 1 ? unique[0] ?? null : null;
  };
  const id = collect([
    "generation",
    "generationId",
    "currentGenerationId",
    "id",
  ], expectedGenerationIdToken);
  const fingerprint = collect([
    "fingerprint",
    "generationFingerprint",
    "currentGenerationFingerprint",
  ]);
  const hasId = [
    "generation",
    "generationId",
    "currentGenerationId",
    "id",
  ].some((key) => Object.hasOwn(value, key));
  const hasFingerprint = [
    "fingerprint",
    "generationFingerprint",
    "currentGenerationFingerprint",
  ].some((key) => Object.hasOwn(value, key));
  if ((hasId && id === null) || (hasFingerprint && fingerprint === null)
      || (!hasId && !hasFingerprint)) return null;
  return { opaque: null, id, fingerprint };
}

function expectedGenerationTokens(value) {
  const parts = expectedGenerationParts(value);
  return parts === null
    ? []
    : [...new Set([
      parts.opaque,
      parts.id,
      parts.fingerprint,
    ].filter((token) => token !== null))];
}

function generationMatchesExpected(value, observedTokens) {
  const parts = expectedGenerationParts(value);
  if (parts === null) return false;
  const observed = new Set(observedTokens);
  if (parts.opaque !== null) return observed.has(parts.opaque);
  return (parts.id === null || observed.has(parts.id))
    && (parts.fingerprint === null || observed.has(parts.fingerprint));
}

function coverageWindow(coverage) {
  const coveredAt = coverage?.coveredAt ?? coverage?.coverage ?? null;
  const startAt = canonicalInstant(coveredAt?.startAt);
  const endAt = canonicalInstant(coveredAt?.endAt);
  if (startAt === null || endAt === null || Date.parse(startAt) > Date.parse(endAt)) {
    return null;
  }
  return { startAt, endAt };
}

function boundedDescriptorText(value) {
  return typeof value === "string" && GENERATION_TOKEN.test(value)
    ? value
    : null;
}

function boundedDescriptorCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function descriptorCapability(value, key) {
  return typeof value?.[key] === "boolean" ? value[key] : null;
}

function sourceDescriptor({
  mode,
  contextBehavior,
  scanned,
  coverage,
  generation,
  generationMatched = false,
}) {
  const coveredAt = mode === "unified" ? coverageWindow(coverage) : null;
  return {
    schemaVersion: SOURCE_DESCRIPTOR_VERSION,
    mode,
    contextBehavior,
    readerVersion: boundedDescriptorText(scanned?.readerVersion),
    schemaVersionUsed: boundedDescriptorText(scanned?.schemaVersion),
    parserVersion: boundedDescriptorText(scanned?.parserVersion),
    contractVersion: boundedDescriptorText(scanned?.contractVersion),
    generation,
    generationFingerprint: boundedDescriptorText(
      scanned?.generationFingerprint
        ?? coverage?.generationFingerprint
        ?? coverage?.fingerprint,
    ),
    coverageStatus: mode === "unified"
      ? boundedDescriptorText(coverage?.status)
      : null,
    coverage: mode === "unified"
      ? {
        status: boundedDescriptorText(coverage?.status),
        blockReason: boundedDescriptorText(coverage?.blockReason),
        generatedAt: canonicalInstant(coverage?.generatedAt) ?? null,
        coveredAt,
        sourceCount: boundedDescriptorCount(coverage?.sourceCount),
        sourceBytes: boundedDescriptorCount(coverage?.sourceBytes),
        skippedSourceCount: boundedDescriptorCount(
          coverage?.skippedSourceCount,
        ),
        skippedSourceBytes: boundedDescriptorCount(
          coverage?.skippedSourceBytes,
        ),
        skippedThreadCount: boundedDescriptorCount(
          coverage?.skippedThreadCount,
        ),
        usageEvents: boundedDescriptorCount(coverage?.usageEvents),
        quotaObservations: boundedDescriptorCount(coverage?.quotaObservations),
        quotaOccurrences: boundedDescriptorCount(coverage?.quotaOccurrences),
        admittedQuotaOccurrences: boundedDescriptorCount(
          coverage?.admittedQuotaOccurrences,
        ),
        generationProof: coverage?.generationProof === true,
      }
      : null,
    diagnosticsAvailable: mode === "unified"
      ? (typeof scanned?.diagnosticsAvailable === "boolean"
        ? scanned.diagnosticsAvailable
        : null)
      : null,
    generationMatched,
    fallbackCount: 0,
    capabilities: mode === "unified"
      ? {
        readsRawSources: descriptorCapability(
          scanned?.capabilities,
          "readsRawSources",
        ),
        deterministicCanonicalOrder: descriptorCapability(
          scanned?.capabilities,
          "deterministicCanonicalOrder",
        ),
        sourceOrderingProvenance: descriptorCapability(
          scanned?.capabilities,
          "sourceOrderingProvenance",
        ),
        sourceOffsetProvenance: descriptorCapability(
          scanned?.capabilities,
          "sourceOffsetProvenance",
        ),
        sourceScopedQuotaOccurrences: descriptorCapability(
          scanned?.capabilities,
          "sourceScopedQuotaOccurrences",
        ),
        durableDiagnostics: descriptorCapability(
          scanned?.capabilities,
          "durableDiagnostics",
        ),
        crashSafeGenerationPublication: descriptorCapability(
          scanned?.capabilities,
          "crashSafeGenerationPublication",
        ),
      }
      : null,
  };
}

function normalizeUnifiedCoverage(scanned, expectedGeneration) {
  const coverage = scanned?.coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
    throw fixedError("accounting_unified_coverage_unavailable");
  }
  const attestedGap = coverage.status === "partial"
    && coverage.blockReason === "codex_rollout_sources_quarantined"
    && coverage.generationProof === true
    && Number.isSafeInteger(coverage.skippedSourceCount)
    && coverage.skippedSourceCount > 0
    && Number.isSafeInteger(coverage.skippedThreadCount)
    && coverage.skippedThreadCount > 0;
  if ((coverage.status !== "complete" && !attestedGap)
      || coverage.generationProof !== true) {
    throw fixedError("accounting_unified_coverage_incomplete");
  }
  const capabilities = scanned?.capabilities;
  if (scanned?.diagnosticsAvailable !== true
      || !capabilities
      || capabilities.readsRawSources !== false
      || capabilities.deterministicCanonicalOrder !== true
      || capabilities.sourceOrderingProvenance !== true
      || capabilities.sourceOffsetProvenance !== true
      || capabilities.sourceScopedQuotaOccurrences !== true
      || capabilities.durableDiagnostics !== true
      || capabilities.crashSafeGenerationPublication !== true) {
    throw fixedError("accounting_unified_coverage_incomplete");
  }
  const coveredAt = coverageWindow(coverage);
  if (coveredAt === null) {
    throw fixedError("accounting_unified_coverage_unavailable");
  }
  const generation = scannerGeneration(scanned);
  if (generation === null) {
    throw fixedError("accounting_unified_generation_unavailable");
  }
  const generationFingerprint = generationToken(
    scanned?.generationFingerprint
      ?? coverage?.generationFingerprint
      ?? coverage?.fingerprint,
  );
  if (generationFingerprint === null) {
    throw fixedError("accounting_unified_generation_unavailable");
  }
  const expected = expectedGenerationTokens(expectedGeneration);
  if (expectedGeneration !== null && expected.length === 0) {
    throw new TypeError("expectedGeneration is invalid");
  }
  const observed = scannerGenerationTokens(scanned);
  if (expected.length > 0
      && !generationMatchesExpected(expectedGeneration, observed)) {
    throw fixedError("accounting_unified_generation_mismatch");
  }
  return {
    coverage,
    coveredAt,
    generation,
    generationFingerprint,
  };
}

function mapUnifiedReaderError(error) {
  const code = error?.code;
  if (typeof code === "string" && !code.startsWith("local_unified_index_")) {
    if (ACCOUNTING_READER_PASSTHROUGH_CODES.has(code)) {
      return fixedError(
        code,
        error?.name === "AbortError" ? "AbortError" : "Error",
      );
    }
    return fixedError("accounting_unified_read_failed");
  }
  const mappedCode = ACCOUNTING_SOURCE_ERROR_CODES[code]
    ?? "accounting_unified_read_failed";
  const mapped = fixedError(
    mappedCode,
    error?.name === "AbortError"
      || (typeof code === "string" && code.endsWith("_aborted"))
      ? "AbortError"
      : "Error",
  );
  return mapped;
}

function historyUnavailable(
  errorCode,
  coverage = null,
  generation = null,
  generationFingerprint = null,
) {
  const coveredAt = coverage?.coveredAt ?? coverage;
  return {
    status: "unavailable",
    errorCode,
    coverage: {
      status: "unavailable",
      generatedAt: null,
      coveredAt: coveredAt?.startAt && coveredAt?.endAt
        ? {
          startAt: coveredAt.startAt,
          endAt: coveredAt.endAt,
        }
        : { startAt: null, endAt: null },
      generation,
      generationFingerprint,
    },
    generation,
    generationFingerprint,
    period: null,
  };
}

function historyProjection(value, coverage, generation, generationFingerprint) {
  return {
    status: "available",
    errorCode: null,
    coverage: {
      status: coverage.coverage.status,
      generatedAt: value.generatedAt,
      coveredAt: value.coveredAt,
      generation,
      generationFingerprint,
    },
    generation,
    generationFingerprint,
    period: value.period,
  };
}

// True for the RSS/byte memory-budget misses that the refresh wrapper treats
// as a soft, recoverable TARGET miss (retain the prior cache, defer the
// rebuild) rather than a hard refresh failure. Keyed on the fixed code alone,
// so it recognizes a miss no matter which of the build's guard sites raised it.
function isAccountingBudgetMiss(error) {
  return typeof error?.code === "string"
    && ACCOUNTING_BUDGET_MISS_CODES.has(error.code);
}


function attachBudgetMissMeasurements(error, {
  baselineRssBytes,
  observedRssBytes,
  ceilingRssBytes,
}) {
  const mib = (value) => (
    Number.isSafeInteger(value) && value >= 0
      ? Math.round(value / (1024 * 1024))
      : null
  );
  error.measurements = Object.freeze({
    baselineRssMib: mib(baselineRssBytes),
    observedRssMib: mib(observedRssBytes),
    ceilingRssMib: mib(ceilingRssBytes),
  });
  return error;
}

function accountingScanResourceError(error) {
  const code = error?.code;
  if (!(error instanceof ExportResourceLimitError)
      && (typeof code !== "string"
        || !code.startsWith("export_resource_"))) return null;
  const suffix = code.slice("export_resource_".length);
  return fixedError(`accounting_scan_${suffix}_limit_exceeded`);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = fixedError("accounting_refresh_aborted");
  error.name = "AbortError";
  throw error;
}

function transitionResourceLimits(value) {
  if (value === null || value === undefined) {
    return DEFAULT_TRANSITION_RESOURCE_LIMITS;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("transitionResourceLimits must be an object or null");
  }
  const ceilings = {
    usageEvents: CODEX_TRANSITION_DERIVATION_CEILINGS.usageEvents,
    weeklySnapshots:
      CODEX_TRANSITION_DERIVATION_CEILINGS.rateLimitSnapshots,
    combinedInputs: CODEX_TRANSITION_DERIVATION_CEILINGS.totalInputs,
    retainedBytes: MAX_RETAINED_TRANSITION_BYTES,
  };
  const allowed = new Set(Object.keys(ceilings));
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError("transitionResourceLimits contains an unknown key");
  }
  return Object.fromEntries(Object.entries(ceilings).map(([key, ceiling]) => {
    const selected = value[key] ?? ceiling;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > ceiling) {
      throw new TypeError(
        `transitionResourceLimits.${key} must be between 1 and ${ceiling}`,
      );
    }
    return [key, selected];
  }));
}

function emptyComponents() {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, 0]));
}

function tokenTotal(components) {
  const input = (components.input_uncached_tokens ?? 0)
    + (components.input_cache_read_tokens ?? 0)
    + (components.input_cache_write_tokens ?? 0);
  const separatedOutput = (components.output_text_tokens ?? 0)
    + (components.output_reasoning_tokens ?? 0);
  const combinedOutput = components.output_combined_tokens ?? 0;
  return input + (combinedOutput > 0 ? combinedOutput : separatedOutput);
}

function safeEnum(value, allowed) {
  return allowed.has(value) ? value : "unknown";
}

function safeModel(value) {
  return recognizedCodexModelId(value) ?? "unknown";
}

function emptyDimension(keys) {
  return Object.fromEntries([...keys].map((key) => [
    key,
    { events: 0, totalTokens: 0, apiPriceEquivalentUsd: 0 },
  ]));
}

function newPeriod(id, label, { includeSpark = true } = {}) {
  const period = {
    id,
    label,
    events: 0,
    totalTokens: 0,
    components: emptyComponents(),
    componentCosts: emptyComponentCosts(),
    apiPriceEquivalentUsd: 0,
    apiPriceEquivalentUsdExact: "0",
    priceCardIds: [],
    priceCardBreakdown: {},
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
    byModel: {},
    bySpeed: emptyDimension(SPEEDS),
    byApiServiceTier: emptyDimension(API_TIERS),
    bySurface: emptyDimension(SURFACES),
    byAgentScope: emptyDimension(AGENT_SCOPES),
    byLineage: emptyDimension(LINEAGE),
    // Observed speed mode crossed with the model's Priority (Fast) price-
    // ratio family. The crossing is what lets the published ratio be applied
    // at read time without rebuilding this cache.
    speedWeighting: emptySpeedWeightingCrossing(),
    // The same crossing, holding only the events the log left UNOBSERVED that
    // a timestamped Codex `service_tier` reading actually covers. Kept apart
    // from the observed crossing so a declaration can never be read back as an
    // observation.
    declaredSpeedWeighting: emptySpeedWeightingCrossing(),
  };
  if (includeSpark) {
    period.spark = newPeriod("spark", "Spark allowance", {
      includeSpark: false,
    });
  }
  return period;
}

function addComponents(target, source) {
  for (const key of COMPONENT_KEYS) {
    const value = source?.[key];
    if (Number.isSafeInteger(value) && value >= 0) target[key] += value;
  }
}

function addDimension(target, key, event) {
  const row = target[key] ?? target.unknown;
  row.events += event.eventCount ?? 1;
  row.totalTokens += event.totalTokens;
  row.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  addProjectedUsd(row, "apiPriceEquivalentUsd", event.priced);
}

const FAST_PRICE_SCALE = 1_000_000_000;

function scaledUsdString(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return "0";
  const whole = Math.floor(value / FAST_PRICE_SCALE);
  const fraction = String(value % FAST_PRICE_SCALE).padStart(9, "0");
  return `${whole}.${fraction}`.replace(/\.?0+$/u, "");
}

// Exact-ledger fast lane. The decimal-string ledger (`addUsdStrings`) is the
// contract: every retained exact total is the canonical decimal string of an
// exact sum. Folding it one event at a time re-parses the growing total and
// re-formats the sum on every add, and at ~1.2 us a call it was ~5% of a
// large rebuild. Fast-path prices are integer nano-dollars, so an event's
// contribution can be accumulated as a BigInt and folded into the string
// ledger only when a non-integer addend arrives or the period is finalized.
// The exact sum is the same either way; the canonical string of that sum is
// therefore identical to the per-event fold, and the string field stays the
// value of record. The pending BigInt lives on a non-enumerable symbol so it
// never reaches a spread, JSON, or the closed cache schema.
const EXACT_SCALED = Symbol("exactUsdScaledPending");
const SCALED_TOTAL = Symbol("pricedUsdScaledTotals");
// A fused unified read delivers one raw usage row to both the windowed and
// the full-history consumer. The projection is a pure function of the row
// and the (memoized, instance-independent) pricer, so the first consumer
// leaves it on the row under this non-enumerable symbol and the second reuses
// it rather than pricing the row again.
const PROJECTED_EVENT = Symbol("projectedUsageEvent");

// Every numeric monetary margin is a projection of exact decimal evidence.
// A binary-float fold can cross a six-place half boundary when the same rows
// are grouped differently. Keep the shared event/group path exact without
// exposing a second ledger field in the persisted schema.
const PROJECTED_USD = new WeakMap();

function addProjectedUsd(target, key, priced) {
  let fields = PROJECTED_USD.get(target);
  if (fields === undefined) {
    fields = new Map();
    PROJECTED_USD.set(target, fields);
  }
  let sum = fields.get(key);
  if (sum === undefined) {
    sum = { exact: "0" };
    fields.set(key, sum);
  }
  const scaled = priced?.[SCALED_TOTAL]?.totalUsd ?? null;
  addExactUsd(sum, "exact", priced?.totalUsd ?? "0", scaled);
}

function roundedProjectedUsd(target, key) {
  const sum = PROJECTED_USD.get(target)?.get(key);
  if (sum === undefined) return roundedMoney(target[key]);
  flushExactUsd(sum, "exact");
  return roundedExactMoney(sum.exact);
}

function addComponentCosts(target, components, priced) {
  addComponentCostsApproximate(target, components, priced);
  for (const row of priced?.components ?? []) {
    if (row.pricingStatus === "priced" && target[row.name] !== undefined
        && Number.isFinite(Number(row.costUsd)) && Number(row.costUsd) >= 0) {
      addProjectedUsd(target[row.name], "costUsd", { totalUsd: row.costUsd });
    }
  }
}

function bigIntNanoUsdString(value) {
  const whole = value / 1_000_000_000n;
  const fraction = String(value % 1_000_000_000n).padStart(9, "0");
  return `${whole}.${fraction}`;
}

function addExactUsd(target, key, addendString, addendScaled) {
  if (addendScaled !== null) {
    const pending = target[EXACT_SCALED];
    const next = (pending === undefined ? 0n : pending) + BigInt(addendScaled);
    if (pending === undefined) {
      Object.defineProperty(target, EXACT_SCALED, {
        value: next,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } else {
      target[EXACT_SCALED] = next;
    }
    return;
  }
  flushExactUsd(target, key);
  target[key] = addUsdStrings(target[key], addendString);
}

function flushExactUsd(target, key) {
  const pending = target[EXACT_SCALED];
  if (pending === undefined) return;
  if (pending > 0n) {
    target[key] = addUsdStrings(target[key], bigIntNanoUsdString(pending));
  }
  target[EXACT_SCALED] = 0n;
}

// Exported for the unified-index companion read: one memoized unit-price plan
// per (model, context band, effective date), integer-scaled per event, falling
// back to the full pricer whenever a plan cannot be proven exact. This is the
// same pricer the replay-safe cache itself accounts with.
export function createAccountingPricer({ apiServiceTier = "standard" } = {}) {
  const plans = new Map();
  const contextFloors = new Map();
  const priceObservedComponents = (event, components) => {
    // Incomplete observations need the full ledger's coverage and context
    // checks. Zero-filled display totals cannot establish an exact unit plan.
    if (COMPONENT_KEYS.some((name) => (
      components[name] === null
      || event.componentAvailability?.[name] === false
      || (name.startsWith("input_") && !Number.isSafeInteger(components[name]))
    ))) {
      return priceCodexUsageEvent({ ...event, components }, {
        apiServiceTier, priceEpochBasis: "event_time",
      });
    }
    // Derive the threshold across the model's public reviewed cards. A tier
    // can omit a long-context card; that missing band must still reach the
    // kernel rather than reusing the tier's short-context template.
    // Older models begin
    // the long band at 272,000; GPT6 models begin at 272,001. The representative
    // template must itself belong to the keyed band.
    if (!contextFloors.has(event.model)) {
      const floors = new Set(APP_OFFICIAL_PRICE_CARDS
        .filter((card) => card.provider === "openai"
          && (card.model === event.model || card.aliases?.includes(event.model)))
        .flatMap((card) => card.components
          .filter((component) => component.unit === "token")
          .map((component) => component.conditions?.min_total_input_tokens)
          .filter((floor) => floor !== undefined)
          .map(Number)));
      contextFloors.set(event.model, floors.size === 1
        ? [...floors][0] : floors.size === 0 ? Infinity : null);
    }
    const contextFloor = contextFloors.get(event.model);
    if (contextFloor === null) {
      return priceCodexUsageEvent({ ...event, components }, {
        apiServiceTier, priceEpochBasis: "event_time",
      });
    }
    const suppliedTotal = event.totalInputContextTokens
      ?? (event.rawAvailability === undefined || event.rawAvailability?.input_tokens === true
        ? event.raw?.input_tokens : null);
    const reportedTotal = suppliedTotal === undefined || suppliedTotal === null
      ? null : Number(suppliedTotal);
    if (reportedTotal !== null && (!Number.isSafeInteger(reportedTotal) || reportedTotal < 0)) {
      return priceCodexUsageEvent({ ...event, components }, {
        apiServiceTier, priceEpochBasis: "event_time",
      });
    }
    const inputSum = (components.input_uncached_tokens ?? 0)
      + (components.input_cache_read_tokens ?? 0)
      + (components.input_cache_write_tokens ?? 0);
    const contextBand =
      (reportedTotal ?? inputSum) >= contextFloor
        ? "long"
        : "short";
    // Keep the effective date in the fast-plan key: official price cards may
    // change by date, and a later plan must never price an earlier event.
    const effectiveDate = canonicalInstant(event.timestamp)?.slice(0, 10)
      ?? "missing_timestamp";
    const key = `${event.model}\0${contextBand}\0${effectiveDate}`;
    let plan = plans.get(key);
    if (plan === undefined) {
      const templateComponents = Object.fromEntries(
        COMPONENT_KEYS.filter(name => name !== "output_combined_tokens")
          .map((name) => [name, 1]),
      );
      const template = priceCodexUsageEvent({
        ...event,
        totalInputContextTokens:
          contextBand === "long" ? contextFloor : 0,
        components: templateComponents,
      }, {
        apiServiceTier,
        priceEpochBasis: "event_time",
      });
      // Keep only rows whose unit price is proven exact. The per-event loop
      // below falls back to the full pricer the moment an event actually USES
      // a component that has no such row, so a partially priced card — Codex
      // never prices cache writes, for example — still yields a fast plan for
      // the events that never touch the unpriced component. The previous
      // all-components gate nullified every Codex plan and silently sent the
      // entire corpus down the slow path.
      const rows = new Map(template.components
        .filter((row) => (
          typeof row.unitPriceUsd === "string"
          && /^\d+(?:\.\d{1,9})?$/u.test(row.unitPriceUsd)
        ))
        .map((row) => [row.name, row]));
      plan = ["fully_priced", "partially_priced"].includes(
        template.coverageStatus,
      ) && rows.size > 0
        ? {
          rows,
          // A fast-priced event uses only fully priced components, so the
          // template's unpriced-component warnings do not describe it. The
          // coverage list mirrors the full pricer's warnings object; identity
          // provenance such as an explicit alias remains informative.
          warnings: template.coverageStatus === "fully_priced"
            ? template.warnings
            : { coverage: [], informational: template.warnings.informational },
          selectedPriceCardIds: template.selectedPriceCardIds,
        }
        : null;
      plans.set(key, plan);
    }
    if (plan === null) {
      return priceCodexUsageEvent({
        ...event,
        components,
      }, {
        apiServiceTier,
        priceEpochBasis: "event_time",
      });
    }
    const pricedComponents = [];
    const priceCardBreakdown = new Map();
    const cardScaled = new Map();
    let totalUsdScaled = 0;
    for (const name of COMPONENT_KEYS) {
      const quantity = components[name] ?? 0;
      if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
      const template = plan.rows.get(name);
      if (!template || typeof template.unitPriceUsd !== "string") {
        return priceCodexUsageEvent({
          ...event,
          components,
        }, {
          apiServiceTier,
          priceEpochBasis: "event_time",
        });
      }
      const unitPriceScaled = Math.round(
        Number(template.unitPriceUsd) * FAST_PRICE_SCALE,
      );
      const costUsdScaled = unitPriceScaled * quantity;
      if (!Number.isSafeInteger(costUsdScaled)
          || !Number.isSafeInteger(
            totalUsdScaled + costUsdScaled,
          )) {
        return priceCodexUsageEvent({
          ...event,
          components,
        }, {
          apiServiceTier,
          priceEpochBasis: "event_time",
        });
      }
      totalUsdScaled += costUsdScaled;
      pricedComponents.push({
        name,
        pricedAs: template.pricedAs,
        quantity: String(quantity),
        unit: template.unit,
        pricingStatus: "priced",
        unitPriceUsd: template.unitPriceUsd,
        costUsd: scaledUsdString(costUsdScaled),
        priceCardId: template.priceCardId,
      });
      // Per-card cost is the exact sum of this event's integer-scaled
      // component costs; format it once instead of folding decimal strings.
      // (totalUsdScaled is proven safe above, and each card's sum is a part
      // of it.)
      cardScaled.set(
        template.priceCardId,
        (cardScaled.get(template.priceCardId) ?? 0) + costUsdScaled,
      );
      if (!priceCardBreakdown.has(template.priceCardId)) {
        priceCardBreakdown.set(template.priceCardId, {
          priceCardId: template.priceCardId,
          events: 1,
          costUsd: "0",
        });
      }
    }
    for (const [priceCardId, scaled] of cardScaled) {
      priceCardBreakdown.get(priceCardId).costUsd = scaledUsdString(scaled);
    }
    const priced = {
      totalUsd: scaledUsdString(totalUsdScaled),
      coverageStatus: "fully_priced",
      components: pricedComponents,
      selectedPriceCardIds: plan.selectedPriceCardIds,
      priceCardBreakdown: [...priceCardBreakdown.values()].sort(
        (left, right) => left.priceCardId.localeCompare(right.priceCardId),
      ),
      warnings: plan.warnings,
    };
    // Integer-scaled totals for the exact-ledger fast lane (see addExactUsd).
    // Non-enumerable: the priced shape callers see and serialize is unchanged.
    Object.defineProperty(priced, SCALED_TOTAL, {
      value: { totalUsd: totalUsdScaled, byCard: cardScaled },
      enumerable: false,
    });
    return priced;
  };
  const price = (event, components) => {
    const priced = priceObservedComponents(event, components);
    if (!event.pricingEvidenceIncomplete || priced.coverageStatus !== "fully_priced") return priced;
    return {
      ...priced,
      coverageStatus: priced.components.some(row => row.pricingStatus === "priced" && Number(row.quantity) > 0)
        ? "partially_priced" : "unpriced",
      warnings: {
        ...priced.warnings,
        coverage: [...(priced.warnings?.coverage ?? []), {
          code: "component_observation_unavailable",
          message: "Source component evidence was partial or contradictory; observed component estimates remain additive.",
        }],
      },
    };
  };
  const tierPricers = new Map();
  price.forApiTier = (tier, event, components) => {
    if (tier === apiServiceTier) return price(event, components);
    if (!tierPricers.has(tier)) tierPricers.set(tier, createAccountingPricer({ apiServiceTier: tier }));
    return tierPricers.get(tier)(event, components);
  };
  return price;
}

function eventProjection(event, price) {
  // Aggregate quantities are already summed. Weight only occurrence counters;
  // pricing, components and exact-money additions still run exactly once.
  const eventCount = event.eventCount ?? 1;
  if (!Number.isSafeInteger(eventCount) || eventCount < 1) {
    throw fixedError("accounting_usage_group_invalid");
  }
  const components = emptyComponents();
  addComponents(components, event.components);
  const separatedOutput = components.output_text_tokens
    + components.output_reasoning_tokens;
  // Prefer the more informative non-overlapping split when both the split and
  // a combined alias are present. A combined-only count is preserved for
  // display, but normalized to ordinary output solely for API pricing.
  if (components.output_combined_tokens > 0 && separatedOutput > 0) {
    components.output_combined_tokens = 0;
  }
  const totalTokens = tokenTotal(components);
  if (totalTokens === 0) return null;
  const model = safeModel(event.model);
  const combinedOnly = components.output_combined_tokens > 0;
  const pricingComponents = { ...event.components };
  const pricingAvailability = { ...event.componentAvailability };
  // An unselected aggregate alias is not a missing independent quantity.
  delete pricingComponents.output_combined_tokens;
  delete pricingAvailability.output_combined_tokens;
  if (combinedOnly) {
    pricingComponents.output_text_tokens = components.output_combined_tokens;
    pricingComponents.output_reasoning_tokens = 0;
    pricingAvailability.output_text_tokens = true;
    pricingAvailability.output_reasoning_tokens = true;
  }
  let priced;
  try {
    priced = price({
      ...event,
      model,
      componentAvailability: pricingAvailability,
    }, pricingComponents);
    if (combinedOnly) {
      priced = {
        ...priced,
        components: priced.components.map((row) => (
          row.name === "output_text_tokens"
            ? {
              ...row,
              name: "output_combined_tokens",
              pricedAs: "output_text_tokens",
            }
            : row
        )),
      };
    }
  } catch {
    priced = {
      totalUsd: "0",
      coverageStatus: "unpriced",
      components: [],
    };
  }
  const cost = Number(priced.totalUsd);
  return {
    timestamp: event.timestamp,
    eventCount,
    model,
    fastModeFamily: speedModeModelFamilyKey(model, event.tierSemantics?.codexSpeedMode, {
      eventTime: event.timestamp,
      standardPriceCardIds: priced.selectedPriceCardIds ?? [],
    }),
    modelPricingStatus: codexModelPricingStatus(event.model),
    modelAllowanceTrack: codexModelAllowanceTrack(event.model),
    modelApiPriceEquivalentApplicable:
      codexModelApiPriceEquivalentApplicable(event.model),
    isSpark: model === SPARK_MODEL,
    components,
    totalTokens,
    priced,
    speedPricingEvent: { ...event, model, componentAvailability: pricingAvailability },
    speedPricingComponents: pricingComponents,
    speedPricer: price.forApiTier,
    combinedOnly,
    apiPriceEquivalentUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
    pricingCoverageStatus: ["fully_priced", "partially_priced"].includes(
      priced.coverageStatus,
    )
      ? priced.coverageStatus
      : "unpriced",
    speed: safeEnum(event.tierSemantics?.codexSpeedMode, SPEEDS),
    apiServiceTier: safeEnum(
      event.tierSemantics?.apiServiceTier,
      API_TIERS,
    ),
    surface: safeEnum(event.surfaceClassification?.surface, SURFACES),
    agentScope: safeEnum(
      event.surfaceClassification?.agentScope,
      AGENT_SCOPES,
    ),
    lineage: safeEnum(
      event.surfaceClassification?.lineageDisposition,
      LINEAGE,
    ),
  };
}

function transitionUsageProjection(event, projection) {
  const components = COMPONENT_KEYS.map((key) => (
    Number.isSafeInteger(event.components?.[key])
      && event.components[key] >= 0
      ? event.components[key]
      : 0
  ));
  const costUsd = Number(projection.priced.totalUsd);
  const multiplier = FAST_MODE_QUOTA_MULTIPLIERS[projection.fastModeFamily] ?? null;
  // The scenario retains the owner-approved assumed ratio when Priority
  // context/date evidence is missing. The period crossing reports that
  // Standard cost separately in the explicit unsupported/assumed bucket.
  const fastWeightedEquivalentUsd =
    costUsd * (multiplier ?? FAST_MODE_ASSUMED_MULTIPLIER);
  const effectiveSpeed = ["standard", "fast", "ultrafast"].includes(projection.speed)
    ? projection.speed
    : ["standard", "fast", "ultrafast"].includes(projection.declaredSpeed)
      ? projection.declaredSpeed
      : "unknown";
  const ultrafastUsd = effectiveSpeed === "ultrafast" ? quotaWeightedApiPriceEquivalent({
    apiPriceEquivalentUsd: costUsd, model: projection.model, mode: effectiveSpeed,
    eventTime: event.timestamp, standardPriceCardIds: projection.priced.selectedPriceCardIds,
  }).usd : null;
  const quotaWeightedLowerUsd = effectiveSpeed === "ultrafast" ? ultrafastUsd
    : effectiveSpeed === "fast" ? fastWeightedEquivalentUsd : costUsd;
  const quotaWeightedUpperUsd = effectiveSpeed === "ultrafast" ? ultrafastUsd
    : effectiveSpeed === "standard" ? costUsd : fastWeightedEquivalentUsd;
  return [
    canonicalInstant(event.timestamp),
    projection.model,
    Number.isSafeInteger(event.totalInputContextTokens)
      && event.totalInputContextTokens >= 0
      ? event.totalInputContextTokens
      : 0,
    ...components,
    projection.speed,
    Number.isFinite(costUsd) ? costUsd : 0,
    projection.priced.totalUsd,
    projection.priced.coverageStatus,
    fastWeightedEquivalentUsd,
    quotaWeightedLowerUsd,
    quotaWeightedUpperUsd,
    costWarningCodes(projection.priced),
    projection.priced.warnings.coverage
      .map((warning) => warning.code)
      .sort(),
    projection.priced.selectedPriceCardIds,
    projection.priced.priceCardBreakdown ?? [],
    [
      event.planAttribution?.basis ?? "unavailable",
      event.planAttribution?.planType ?? null,
      event.usageIntervalStartedAt ?? null,
      event.usageIntervalBasis ?? "unavailable",
    ],
  ];
}

// Keep the first and last observation of a chronological same-plan run. Its
// last old/first new anchors delimit the uncertain switch interval. This is
// independent of percent, reset and token changes, so quota-only evidence
// survives the fit-oriented snapshot collapse below.
function calibrationPlanEvidence({ ordered = false, maximum = 750_000 } = {}) {
  const rows = [];
  const runs = new Map();
  let latestMs = Number.NEGATIVE_INFINITY;
  let latestPlans = new Set();
  const planTypes = new Set();
  return {
    observe(snapshot) {
      const window = snapshot?.window;
      const observedAtMs = Number.isFinite(snapshot?.timestampMs)
        ? snapshot.timestampMs : Date.parse(snapshot?.timestamp);
      if (!window || window.provider !== "openai_codex" || window.limitId !== "codex"
          || !Number.isSafeInteger(observedAtMs)) return;
      const planType = typeof window.planType === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(window.planType)
        ? window.planType : "unknown";
      if (planType !== "unknown") {
        planTypes.add(planType);
        if (observedAtMs > latestMs) { latestMs = observedAtMs; latestPlans = new Set(); }
        if (observedAtMs === latestMs) latestPlans.add(planType);
      }
      const row = {
        contextKey: planAttributionContextKey(window.provider, window.limitId),
        observedAtMs, planType, planVariant: "unknown", accountScopeId: null,
      };
      const run = runs.get(row.contextKey);
      if (ordered && run?.planType === planType && observedAtMs >= run.lastMs) {
        if (run.lastIndex === run.firstIndex) {
          run.lastIndex = rows.length;
          rows.push(row);
        } else rows[run.lastIndex] = row;
        run.lastMs = observedAtMs;
      } else {
        runs.set(row.contextKey, { planType, firstIndex: rows.length, lastIndex: rows.length, lastMs: observedAtMs });
        rows.push(row);
      }
      if (rows.length > maximum) throw fixedError("accounting_transition_snapshot_limit_exceeded");
    },
    finish() {
      const index = buildPlanAttributionIndex(rows);
      rows.length = 0;
      runs.clear();
      if (index.status !== "ready") throw fixedError("accounting_transition_derivation_limit_exceeded");
      return {
        index,
        summary: {
          planTypes: [...planTypes].sort(),
          latestPlanType: latestPlans.size === 1 ? [...latestPlans][0] : "unknown",
          singlePlanComparisonEligible: planTypes.size === 1 && index.conflicts.length === 0,
        },
      };
    },
  };
}

function weeklyRateLimitProjection(snapshot) {
  const window = snapshot.window;
  const boundedText = (value) => (
    typeof value === "string"
      && value.length > 0
      && value.length <= 64
      ? value
      : "unknown"
  );
  return [
    canonicalInstant(snapshot.timestamp),
    Number.isFinite(snapshot.timestampMs)
      ? snapshot.timestampMs
      : Date.parse(snapshot.timestamp),
    boundedText(window.provider),
    boundedText(window.planType),
    boundedText(window.limitId),
    boundedText(window.slot),
    window.windowDurationMins,
    window.resetsAt,
    window.usedPercent,
  ];
}

function quotaTimelineProjection(
  snapshot,
  { limitId = "codex", durationMinutes = WEEKLY_WINDOW_MINUTES } = {},
) {
  const observedAt = canonicalInstant(snapshot?.timestamp);
  const window = snapshot?.window;
  // Keep only the limit family the caller asked for. The high-churn
  // codex_bengalfox family never folds into the main "codex" weekly track
  // used by the UI calibration — it is the Spark allowance's real limit id
  // and is retained on the Spark series instead.
  if (observedAt === null
      || !window
      || typeof window !== "object"
      || window.provider !== "openai_codex"
      || window.limitId !== limitId
      || !QUOTA_SLOTS.has(window.slot)
      || (durationMinutes !== null
        && window.windowDurationMins !== durationMinutes)
      || !isValidQuotaWindowDuration(window.windowDurationMins)
      || typeof window.usedPercent !== "number"
      || !Number.isFinite(window.usedPercent)
      || window.usedPercent < 0
      || window.usedPercent > 100
      || !Number.isSafeInteger(window.resetsAt)
      || window.resetsAt <= 0) {
    return null;
  }
  const resetDate = new Date(window.resetsAt * 1_000);
  if (!Number.isFinite(resetDate.getTime())) return null;
  const resetAt = resetDate.toISOString();
  const usedPercent = Number(window.usedPercent.toFixed(3));
  return {
    observedAt,
    limitId,
    slot: window.slot,
    planType: QUOTA_PLANS.has(window.planType)
      ? window.planType
      : "unknown",
    usedPercent,
    remainingPercent: Number(Math.max(0, 100 - usedPercent).toFixed(3)),
    durationMinutes: window.windowDurationMins,
    resetAt,
    accountAttribution: "historical_unattributed",
  };
}

function quotaTimelineTrackBucketKey(row) {
  const observedMs = Date.parse(row.observedAt);
  // Preserve the exact observed point. Collapsing to a 15-minute bucket can
  // erase the closest points to an exact comparison endpoint and manufacture
  // an otherwise avoidable missing-bracket status.
  return `${observedMs}:${row.limitId}:${row.durationMinutes}`;
}

// Track identity is (limitId, duration). The provider's primary/secondary
// slots are server-assigned UI roles — the weekly window flipped from
// `secondary` to `primary` around 2026-07-06 — so slot stays on the row as
// display provenance but never keys a track: keying on it split one
// continuous weekly series into two tracks at the flip.
function quotaTimelineTrackKey(row) {
  return `${row.limitId}:${row.durationMinutes}`;
}

function quotaTimelineBucketKey(row) {
  const observedMs = Date.parse(row.observedAt);
  const bucketStartMs = Math.floor(observedMs / TIMELINE_BUCKET_MS)
    * TIMELINE_BUCKET_MS;
  return `${bucketStartMs}:${quotaTimelineTrackKey(row)}`;
}

function quotaTimelineStateKey(row) {
  return [
    row.planType,
    row.usedPercent.toFixed(3),
    row.resetAt,
  ].join("\0");
}

function quotaTimelineRowTieBreak(row) {
  // Percent is zero-padded so the string compare is numeric: between two
  // same-instant readings of one track the lower displayed percentage wins.
  // Slot is deliberately LAST: it is display provenance, not identity, and
  // only breaks the tie when the state is otherwise identical so retention
  // stays order-independent.
  return [
    row.planType,
    row.usedPercent.toFixed(3).padStart(7, "0"),
    row.resetAt,
    row.slot,
  ].join("\0");
}

// Retained order must satisfy validQuotaTimeline's code-unit sortKey check on
// read. localeCompare gives punctuation variable collation weight — it orders
// "codex_bengalfox" before "codex-spark" while the code-unit check orders
// them the other way — so quota-timeline ordering always compares code units,
// never collation order.
function codeUnitCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function quotaTimelineRowSort(left, right) {
  return codeUnitCompare(left.observedAt, right.observedAt)
    || codeUnitCompare(left.limitId, right.limitId)
    || codeUnitCompare(left.slot, right.slot)
    || codeUnitCompare(left.resetAt, right.resetAt)
    || codeUnitCompare(left.planType, right.planType)
    || left.usedPercent - right.usedPercent;
}

function quotaTimelineDeterministicRowSort(left, right) {
  return quotaTimelineRowSort(left, right)
    || codeUnitCompare(
      String(left.durationMinutes),
      String(right.durationMinutes),
    );
}

function retainQuotaTimeline(buckets, snapshot, options) {
  const row = quotaTimelineProjection(snapshot, options);
  if (row === null) return;
  const key = quotaTimelineTrackBucketKey(row);
  const prior = buckets.get(key);
  if (prior === undefined
      || row.observedAt > prior.observedAt
      || (row.observedAt === prior.observedAt
        && quotaTimelineRowTieBreak(row)
          < quotaTimelineRowTieBreak(prior))) {
    buckets.set(key, row);
  }
}

function addQuotaTimelineCandidate(candidates, row, transitionKeys = null) {
  const key = quotaTimelineTrackBucketKey(row);
  candidates.set(key, row);
  if (transitionKeys !== null) transitionKeys.add(key);
}

function quotaTimelineCandidates(rows) {
  const candidates = new Map();
  const transitionKeys = new Set();
  const previousByTrack = new Map();
  const bucketEdges = new Map();

  for (const row of rows) {
    const trackKey = quotaTimelineTrackKey(row);
    const previous = previousByTrack.get(trackKey);
    if (previous === undefined
        || quotaTimelineStateKey(previous) !== quotaTimelineStateKey(row)) {
      addQuotaTimelineCandidate(candidates, row, transitionKeys);
    }
    previousByTrack.set(trackKey, row);

    const bucketKey = quotaTimelineBucketKey(row);
    const edge = bucketEdges.get(bucketKey);
    if (edge === undefined) {
      bucketEdges.set(bucketKey, { first: row, last: row });
    } else {
      edge.last = row;
    }
  }

  for (const { first, last } of bucketEdges.values()) {
    addQuotaTimelineCandidate(candidates, first);
    addQuotaTimelineCandidate(candidates, last);
  }

  return { candidates, transitionKeys };
}

function selectTimeStratifiedQuotaTimelineRows(
  rows,
  maximum,
  rangeRows = rows,
) {
  if (rows.length <= maximum) return rows;
  const rangeStartMs = Date.parse(rangeRows[0].observedAt);
  const rangeEndMs = Date.parse(rangeRows.at(-1).observedAt);
  if (rangeStartMs === rangeEndMs) {
    return rows
      .slice()
      .sort(quotaTimelineDeterministicRowSort)
      .slice(0, maximum);
  }

  const spanMs = rangeEndMs - rangeStartMs;
  const groups = new Map();
  for (const row of rows) {
    const observedMs = Date.parse(row.observedAt);
    const stratum = Math.min(
      maximum - 1,
      Math.floor(((observedMs - rangeStartMs) * maximum) / spanMs),
    );
    const group = groups.get(stratum) ?? [];
    group.push(row);
    groups.set(stratum, group);
  }

  const activeGroups = [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => ({
      rows: group.sort(quotaTimelineDeterministicRowSort),
      nextIndex: 0,
    }));
  const selected = [];
  while (activeGroups.length > 0 && selected.length < maximum) {
    const nextGroups = [];
    for (const group of activeGroups) {
      if (group.nextIndex < group.rows.length) {
        selected.push(group.rows[group.nextIndex]);
        group.nextIndex += 1;
      }
      if (group.nextIndex < group.rows.length) nextGroups.push(group);
      if (selected.length >= maximum) break;
    }
    activeGroups.splice(0, activeGroups.length, ...nextGroups);
  }
  return selected;
}

// The oldest and newest observation on every track. These are pinned before
// any sampling so the retained series always reaches both ends of the covered
// window: the oldest row is what a calibration window near the start of the
// range needs to bracket against, and the newest row is the current allowance
// reading.
function quotaTimelineRangeAnchors(sortedRows) {
  const firstByTrack = new Map();
  const lastByTrack = new Map();
  for (const row of sortedRows) {
    const key = quotaTimelineTrackKey(row);
    if (!firstByTrack.has(key)) firstByTrack.set(key, row);
    lastByTrack.set(key, row);
  }
  const anchors = new Map();
  for (const row of [...firstByTrack.values(), ...lastByTrack.values()]) {
    anchors.set(quotaTimelineTrackBucketKey(row), row);
  }
  return [...anchors.values()].sort(quotaTimelineDeterministicRowSort);
}

// Time stratification alone is not enough when several tracks share the range:
// at equal timestamps one track always sorts first, so a single stratified
// pass can spend the whole budget on that track and erase the other one. Give
// every (limitId, duration) track its own stratified share and interleave
// them.
function selectTrackBalancedQuotaTimelineRows(rows, maximum, rangeRows) {
  if (rows.length <= maximum) return rows;
  const byTrack = new Map();
  for (const row of rows) {
    const key = quotaTimelineTrackKey(row);
    const group = byTrack.get(key) ?? [];
    group.push(row);
    byTrack.set(key, group);
  }
  if (byTrack.size <= 1) {
    return selectTimeStratifiedQuotaTimelineRows(rows, maximum, rangeRows);
  }
  const trackBudget = Math.ceil(maximum / byTrack.size);
  let tracks = [...byTrack.entries()]
    .sort(([left], [right]) => codeUnitCompare(left, right))
    .map(([, group]) => ({
      rows: selectTimeStratifiedQuotaTimelineRows(
        group.sort(quotaTimelineDeterministicRowSort),
        trackBudget,
        rangeRows,
      ).slice().sort(quotaTimelineDeterministicRowSort),
      nextIndex: 0,
    }));
  const selected = [];
  while (tracks.length > 0 && selected.length < maximum) {
    const nextTracks = [];
    for (const track of tracks) {
      if (selected.length < maximum && track.nextIndex < track.rows.length) {
        selected.push(track.rows[track.nextIndex]);
        track.nextIndex += 1;
      }
      if (track.nextIndex < track.rows.length) nextTracks.push(track);
    }
    tracks = nextTracks;
  }
  return selected;
}

// Fill a hard row budget from priority groups. Each group is stratified over
// time and balanced across tracks into whatever capacity is left, so a dense
// recent burst can never crowd out the earlier part of the covered window and
// the result never exceeds `maximum` — the same ceiling `validQuotaTimeline`
// enforces on read. A final pass over every candidate spends any capacity a
// short group left behind.
function retainBoundedQuotaTimelineRows(groups, maximum, rangeRows) {
  const retained = new Map();
  for (const group of [...groups, rangeRows]) {
    const capacity = maximum - retained.size;
    if (capacity <= 0) break;
    const pending = group.filter((row) => (
      !retained.has(quotaTimelineTrackBucketKey(row))
    ));
    if (pending.length === 0) continue;
    const selected = selectTrackBalancedQuotaTimelineRows(
      pending,
      capacity,
      rangeRows,
    );
    for (const row of selected) {
      if (retained.size >= maximum) break;
      retained.set(quotaTimelineTrackBucketKey(row), row);
    }
  }
  return [...retained.values()].sort(quotaTimelineDeterministicRowSort);
}

function finalizeWeeklyQuotaTimeline(buckets) {
  const rows = [...buckets.values()].sort(quotaTimelineRowSort);
  // Keep the historical path byte-for-byte/order-for-order for ordinary
  // caches. Retention only changes when the old newest-only cap would have
  // discarded the earlier covered window.
  if (rows.length <= MAX_QUOTA_TIMELINE_ROWS) return rows;

  const { candidates, transitionKeys } = quotaTimelineCandidates(rows);
  if (candidates.size <= MAX_QUOTA_TIMELINE_ROWS) {
    return [...candidates.values()].sort(quotaTimelineDeterministicRowSort);
  }

  const candidateRows = [...candidates.values()]
    .sort(quotaTimelineDeterministicRowSort);
  const transitionRows = candidateRows.filter((row) => (
    transitionKeys.has(quotaTimelineTrackBucketKey(row))
  ));
  const bucketEdgeRows = candidateRows.filter((row) => (
    !transitionKeys.has(quotaTimelineTrackBucketKey(row))
  ));
  // Retaining every state transition is not bounded: a long, busy range can
  // hold far more transitions than the cap, which is how this path used to
  // return more rows than the cache is allowed to carry. Transitions still
  // rank above plain bucket edges, but they are budgeted like everything else.
  return retainBoundedQuotaTimelineRows(
    [quotaTimelineRangeAnchors(candidateRows), transitionRows, bucketEdgeRows],
    MAX_QUOTA_TIMELINE_ROWS,
    candidateRows,
  );
}

function paceAccountTrackId(snapshot) {
  const scope = snapshot?.accountScope;
  if (scope?.status === "available"
      && (ACCOUNT_SCOPE_ID_PATTERN.test(scope.scopeId ?? "")
        || ACCOUNT_TRACK_ID_PATTERN.test(scope.scopeId ?? ""))) {
    return scope.scopeId;
  }
  // A caller that has already projected the app-server marker may supply the
  // opaque track directly. Never accept a session/source scope or an
  // arbitrary string as an account identity.
  const direct = snapshot?.accountTrackId;
  return ACCOUNT_SCOPE_ID_PATTERN.test(direct ?? "")
      || ACCOUNT_TRACK_ID_PATTERN.test(direct ?? "")
    ? direct
    : null;
}

function paceToken(value, fallback) {
  return typeof value === "string"
      && /^[a-z0-9][a-z0-9_.:-]{0,127}$/iu.test(value)
    ? value
    : fallback;
}

function weeklyPaceSnapshotProjection(snapshot) {
  const window = snapshot?.window;
  const accountTrackId = paceAccountTrackId(snapshot);
  const observedAt = canonicalInstant(
    snapshot?.observedAt ?? snapshot?.timestamp,
  );
  const receivedAt = canonicalInstant(
    snapshot?.receivedAt ?? snapshot?.timestamp,
  );
  if (accountTrackId === null
      || observedAt === null
      || receivedAt === null
      || !window
      || typeof window !== "object"
      || window.provider !== "openai_codex"
      || window.limitId !== "codex"
      || !QUOTA_SLOTS.has(window.slot)
      || window.windowDurationMins !== WEEKLY_WINDOW_MINUTES
      || !Number.isFinite(window.usedPercent)
      || window.usedPercent < 0
      || window.usedPercent > 100
      || !Number.isSafeInteger(window.resetsAt)
      || window.resetsAt <= 0
      || Date.parse(receivedAt) < Date.parse(observedAt)) {
    return null;
  }
  const resetDate = new Date(window.resetsAt * 1_000);
  if (!Number.isFinite(resetDate.getTime())) return null;
  return {
    accountTrackId,
    provider: "openai_codex",
    planType: paceToken(window.planType, "unknown"),
    // The shared quota-analysis pace contract requires a non-empty planVariant
    // track field (validateSnapshot / plainExact), so it stays on the wire even
    // though the local plan cohort is now carried by planType.
    planVariant: paceToken(
      snapshot?.planVariant ?? window.planVariant,
      "current-window",
    ),
    limitId: "codex",
    slot: window.slot,
    windowDurationMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: resetDate.toISOString(),
    observedAt,
    receivedAt,
    usedPercent: Number(window.usedPercent.toFixed(3)),
    policyEpoch: paceToken(
      snapshot?.policyEpoch ?? window.policyEpoch,
      "current-window",
    ),
  };
}

// Slot is deliberately absent: it is a server-assigned UI role, and the
// weekly window flipped secondary -> primary around 2026-07-06. Keeping it in
// the track key excluded the pre-flip observations from the pace history of
// what is one continuous (limit, duration, reset) track.
function paceTrackKey(row, includeReset = true) {
  return [
    row.accountTrackId,
    row.provider,
    row.planType,
    row.planVariant,
    row.limitId,
    row.windowDurationMinutes,
    ...(includeReset ? [row.resetsAt] : []),
    row.policyEpoch,
  ].join("\0");
}

function paceUnavailable(row, status = "unavailable") {
  return {
    status,
    currentUsedPercent: Number(row.usedPercent.toFixed(3)),
    remainingPercent: Number(Math.max(0, 100 - row.usedPercent).toFixed(3)),
    resetsAt: row.resetsAt,
    pace: {
      activePercentagePointsPerHour: null,
      overallPercentagePointsPerHour: null,
    },
    etaAt: null,
    hoursToExhaustion: null,
    hoursToReset: Number(
      Math.max(0, Date.parse(row.resetsAt) - Date.parse(row.observedAt))
        / (60 * 60 * 1_000),
    ),
  };
}

function sanitizeWeeklyPaceForecast(result) {
  if (!result || typeof result !== "object"
      || !PACE_STATUSES.has(result.status)
      || !Number.isFinite(result.currentUsedPercent)
      || result.currentUsedPercent < 0
      || result.currentUsedPercent > 100
      || !Number.isFinite(result.remainingPercent)
      || result.remainingPercent < 0
      || result.remainingPercent > 100
      || result.remainingPercent
        !== Number(Math.max(0, 100 - result.currentUsedPercent).toFixed(3))
      || canonicalInstant(result.resetsAt) === null) {
    return null;
  }
  const activeRate = result.pace?.activePercentagePointsPerHour;
  const overallRate = result.pace?.overallPercentagePointsPerHour;
  const hoursToExhaustion = result.hoursToExhaustion;
  const hoursToReset = result.hoursToReset;
  const etaAt = result.etaAt === null ? null : canonicalInstant(result.etaAt);
  const invalidRate = (rate) => rate !== null
    && (!Number.isFinite(rate) || rate < 0 || rate > 100);
  if (invalidRate(activeRate)
      || invalidRate(overallRate)
      || (hoursToExhaustion !== null
        && (!Number.isFinite(hoursToExhaustion) || hoursToExhaustion < 0))
      || (hoursToReset !== null
        && (!Number.isFinite(hoursToReset) || hoursToReset < 0))
      || (result.etaAt !== null && etaAt === null)) {
    return null;
  }
  return {
    status: result.status,
    currentUsedPercent: Number(result.currentUsedPercent.toFixed(3)),
    remainingPercent: Number(result.remainingPercent.toFixed(3)),
    resetsAt: result.resetsAt,
    pace: {
      activePercentagePointsPerHour:
        activeRate === null ? null : Number(activeRate.toFixed(6)),
      overallPercentagePointsPerHour:
        overallRate === null ? null : Number(overallRate.toFixed(6)),
    },
    etaAt,
    hoursToExhaustion: hoursToExhaustion === null
      ? null
      : Number(hoursToExhaustion.toFixed(6)),
    hoursToReset: hoursToReset === null ? null : Number(hoursToReset.toFixed(6)),
  };
}

function projectWeeklyPaceForecast(rows, endMs) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const ordered = [...rows].sort((left, right) => (
    left.observedAt.localeCompare(right.observedAt)
    || left.receivedAt.localeCompare(right.receivedAt)
    || left.usedPercent - right.usedPercent
  ));
  const latestMs = Date.parse(ordered.at(-1).observedAt);
  const latest = ordered.filter(
    (row) => Date.parse(row.observedAt) === latestMs,
  );
  const latestAccounts = new Set(latest.map((row) => row.accountTrackId));
  if (latestAccounts.size !== 1) return null;
  const latestScope = latest[0].accountTrackId;
  const latestSlots = new Set(
    latest.filter((row) => row.accountTrackId === latestScope)
      .map((row) => row.slot),
  );
  // The provider labels either slot as valid for the seven-day limit. If both
  // are present at the same instant, follow the dashboard's primary-slot
  // preference; otherwise keep the only observed slot.
  const selectedSlot = latestSlots.has("primary")
    ? "primary"
    : latestSlots.size === 1 ? [...latestSlots][0] : null;
  if (selectedSlot === null) return null;
  const currentCandidates = latest.filter((row) => (
    row.accountTrackId === latestScope && row.slot === selectedSlot
  ));
  const currentKeys = new Set(currentCandidates.map((row) => paceTrackKey(row)));
  if (currentKeys.size !== 1) return null;
  const current = currentCandidates[0];
  if (endMs - latestMs > PACE_CURRENT_MAX_AGE_MS) {
    return sanitizeWeeklyPaceForecast(paceUnavailable(current));
  }
  const currentKey = paceTrackKey(current);
  const observations = ordered.filter((row) => (
    row.accountTrackId === latestScope
    && paceTrackKey(row) === currentKey
  ));
  try {
    const result = analyzeQuotaPace({
      currentSnapshot: current,
      observations,
    });
    return sanitizeWeeklyPaceForecast(result);
  } catch {
    return sanitizeWeeklyPaceForecast(paceUnavailable(current));
  }
}

function addSpeedWeighting(crossing, event) {
  // Standard, Fast, Ultrafast and unknown are the reviewed values; anything
  // else collapses to unknown rather than being treated as Standard.
  const speed = ["standard", "fast", "ultrafast", "unknown"].includes(event.speed)
    ? event.speed : "unknown";
  const row = crossing[speed] ??= {};
  const effectiveMode = speed === "unknown" ? event.declaredSpeed : speed;
  const family = speedModeModelFamilyKey(event.model, effectiveMode, {
    eventTime: event.timestamp, standardPriceCardIds: event.priced.selectedPriceCardIds ?? [],
  });
  const cell = row[family] ??= {
    events: 0, apiPriceEquivalentUsd: 0,
  };
  cell.events += event.eventCount ?? 1;
  cell.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  addProjectedUsd(cell, "apiPriceEquivalentUsd", event.priced);
}

function addDeclaredSpeedWeighting(crossing, event) {
  // Only a declaration that resolved to a real mode is recorded, and only for
  // events the log left unobserved; everything else is left unattributed.
  if (!["standard", "fast", "ultrafast"].includes(event.declaredSpeed)) {
    return;
  }
  const row = crossing[event.declaredSpeed] ??= {};
  const family = speedModeModelFamilyKey(event.model, event.declaredSpeed, {
    eventTime: event.timestamp, standardPriceCardIds: event.priced.selectedPriceCardIds ?? [],
  });
  const cell = row[family] ??= {
    events: 0, apiPriceEquivalentUsd: 0,
  };
  cell.events += event.eventCount ?? 1;
  cell.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  addProjectedUsd(cell, "apiPriceEquivalentUsd", event.priced);
}

function finalizeSpeedWeighting(crossing) {
  return Object.fromEntries(Object.entries(crossing).map(([speed, families]) => [
    speed,
    Object.fromEntries(Object.entries(families).map(([family, cell]) => [
      family,
      { ...cell, apiPriceEquivalentUsd: roundedProjectedUsd(cell, "apiPriceEquivalentUsd") },
    ])),
  ]));
}

function compactSpeedWeighting(crossing) {
  // Timeline buckets overwhelmingly occupy one or two of the closed
  // speed/model cells. Persist only those cells; readers validate the
  // allowed sparse keys and treat absence as an exact zero.
  const compact = {};
  for (const [speed, families] of Object.entries(crossing)) {
    const selected = {};
    for (const [family, cell] of Object.entries(families)) {
      if (cell.events === 0 && cell.apiPriceEquivalentUsd === 0) continue;
      selected[family] = {
        events: cell.events,
        apiPriceEquivalentUsd: roundedProjectedUsd(cell, "apiPriceEquivalentUsd"),
      };
    }
    if (Object.keys(selected).length > 0) compact[speed] = selected;
  }
  return compact;
}

function addEvent(period, event) {
  if (event.isSpark) {
    addEvent(period.spark, { ...event, isSpark: false });
    return;
  }
  let speedPriced = speedApiPrice(event.speedPricingEvent, event.speedPricingComponents, event.priced, event.declaredSpeed, event.speedPricer);
  if (event.combinedOnly && speedPriced !== event.priced) speedPriced = { ...speedPriced, components: speedPriced.components.map(row => row.name === "output_text_tokens" ? { ...row, name: "output_combined_tokens" } : row) };
  const eventCount = event.eventCount ?? 1;
  addSpeedApiCost(period, event.components, speedPriced, eventCount);
  period.events += eventCount;
  period.totalTokens += event.totalTokens;
  period.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  const scaledTotals = event.priced?.[SCALED_TOTAL] ?? null;
  addExactUsd(
    period,
    "apiPriceEquivalentUsdExact",
    event.priced?.totalUsd ?? "0",
    scaledTotals === null ? null : scaledTotals.totalUsd,
  );
  addComponents(period.components, event.components);
  addComponentCosts(period.componentCosts, event.components, event.priced);
  for (const id of event.priced?.selectedPriceCardIds ?? []) {
    if (!period.priceCardIds.includes(id)) period.priceCardIds.push(id);
  }
  for (const item of event.priced?.priceCardBreakdown ?? []) {
    const row = period.priceCardBreakdown[item.priceCardId] ?? {
      priceCardId: item.priceCardId,
      events: 0,
      costUsd: "0",
    };
    row.events += (item.events ?? 0) * eventCount;
    const cardScaled = scaledTotals?.byCard.get(item.priceCardId);
    addExactUsd(
      row,
      "costUsd",
      item.costUsd ?? "0",
      Number.isSafeInteger(cardScaled) ? cardScaled : null,
    );
    period.priceCardBreakdown[item.priceCardId] = row;
  }
  const model = period.byModel[event.model] ??= {
    model: event.model,
    pricingStatus: event.modelPricingStatus,
    allowanceTrack: event.modelAllowanceTrack,
    apiPriceEquivalentApplicable: event.modelApiPriceEquivalentApplicable,
    events: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
    // The same two crossings the period keeps, kept per model as well. Without
    // them a reader can see that a model holds most of the tokens and most of
    // the money but not which component carries either, which is the one
    // question a model table is asked. Each cell accumulates the amount the
    // event was actually priced at, so a card revised mid-period is carried
    // rather than flattened to a single rate.
    components: emptyComponents(),
    componentCosts: emptyComponentCosts(),
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
  };
  model.events += eventCount;
  model.totalTokens += event.totalTokens;
  model.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  addProjectedUsd(model, "apiPriceEquivalentUsd", event.priced);
  addComponents(model.components, event.components);
  addComponentCosts(model.componentCosts, event.components, event.priced);
  addSpeedApiCost(model, event.components, speedPriced, eventCount);
  model.pricingCoverage[
    event.pricingCoverageStatus === "fully_priced"
      ? "fullyPricedEvents"
      : event.pricingCoverageStatus === "partially_priced"
        ? "partiallyPricedEvents"
        : "unpricedEvents"
  ] += eventCount;
  addDimension(period.bySpeed, event.speed, event);
  addSpeedWeighting(period.speedWeighting, event);
  addDeclaredSpeedWeighting(period.declaredSpeedWeighting, event);
  addDimension(period.byApiServiceTier, event.apiServiceTier, event);
  addDimension(period.bySurface, event.surface, event);
  addDimension(period.byAgentScope, event.agentScope, event);
  addDimension(period.byLineage, event.lineage, event);
  if (event.pricingCoverageStatus === "fully_priced") {
    period.pricingCoverage.fullyPricedEvents += eventCount;
  } else if (event.pricingCoverageStatus === "partially_priced") {
    period.pricingCoverage.partiallyPricedEvents += eventCount;
  } else {
    period.pricingCoverage.unpricedEvents += eventCount;
  }
}

function roundedMoney(value) {
  return Number(value.toFixed(6));
}

// The period's numeric total is a display projection of the exact decimal
// ledger, not an independently accumulated binary-float sum. Round the
// decimal string at six places with decimal half-up semantics before converting
// it to the bounded numeric projection. This keeps a large aggregation stable
// at the exact half boundary (and avoids Number#toFixed's representation
// dependent result for values such as 0.0000005).
function roundedExactMoney(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/u.test(value)) {
    return Number.NaN;
  }
  const [whole, fraction = ""] = value.split(".");
  const retainedFraction = fraction.padEnd(6, "0").slice(0, 6);
  let scaled = BigInt(`${whole}${retainedFraction}`);
  if ((fraction[6] ?? "0") >= "5") scaled += 1n;
  const integerPart = scaled / 1_000_000n;
  const fractionalPart = String(scaled % 1_000_000n).padStart(6, "0");
  const numeric = Number(`${integerPart}.${fractionalPart}`);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function finalizeDimension(dimension) {
  return Object.fromEntries(Object.entries(dimension).map(([key, row]) => [
    key,
    {
      ...row,
      apiPriceEquivalentUsd: roundedProjectedUsd(row, "apiPriceEquivalentUsd"),
    },
  ]));
}

function modelUsageRowSort(left, right) {
  return right.apiPriceEquivalentUsd - left.apiPriceEquivalentUsd
    || right.totalTokens - left.totalTokens
    || left.model.localeCompare(right.model);
}

// One row per model identity across every allowance track, for surfaces that
// render a single "model usage" table. `byModel` deliberately covers only the
// primary allowance, because the period's own event/token/cost totals exclude
// the separately metered Spark track and the two must stay reconcilable. A
// renderer that wants every model on one list needs this instead, and each
// row states which track it belongs to and whether an API-price equivalent is
// a meaningful figure for it at all.
function combinedModelUsage(finalized) {
  return [
    ...finalized.byModel,
    ...(finalized.spark?.byModel ?? []),
  ].sort(modelUsageRowSort);
}

function finalizePeriod(period) {
  const priced = period.pricingCoverage.fullyPricedEvents
    + period.pricingCoverage.partiallyPricedEvents;
  // Settle the exact-ledger fast lane before anything reads the strings.
  flushExactUsd(period, "apiPriceEquivalentUsdExact");
  for (const row of Object.values(period.priceCardBreakdown)) {
    flushExactUsd(row, "costUsd");
  }
  const finalized = {
    ...period,
    ...speedApiCostSummary(period),
    apiPriceEquivalentUsd: roundedExactMoney(
      period.apiPriceEquivalentUsdExact,
    ),
    priceCardIds: [...period.priceCardIds].sort(),
    priceCardBreakdown: Object.values(period.priceCardBreakdown).sort(
      (left, right) => left.priceCardId.localeCompare(right.priceCardId),
    ),
    pricedEventFraction: period.events === 0
      ? null
      : Number((priced / period.events).toFixed(6)),
    componentCosts: Object.fromEntries(
      Object.entries(period.componentCosts).map(([key, row]) => [
        key,
        { ...row, costUsd: roundedProjectedUsd(row, "costUsd") },
      ]),
    ),
    byModel: Object.values(period.byModel)
      .map((row) => ({
        ...row,
        ...speedApiCostSummary(row),
        apiPriceEquivalentUsd: roundedProjectedUsd(row, "apiPriceEquivalentUsd"),
        componentCosts: Object.fromEntries(
          Object.entries(row.componentCosts).map(([key, cost]) => [
            key,
            { ...cost, costUsd: roundedProjectedUsd(cost, "costUsd") },
          ]),
        ),
      }))
      .sort(modelUsageRowSort),
    bySpeed: finalizeDimension(period.bySpeed),
    byApiServiceTier: finalizeDimension(period.byApiServiceTier),
    bySurface: finalizeDimension(period.bySurface),
    byAgentScope: finalizeDimension(period.byAgentScope),
    byLineage: finalizeDimension(period.byLineage),
    speedWeighting: finalizeSpeedWeighting(period.speedWeighting),
    declaredSpeedWeighting: finalizeSpeedWeighting(
      period.declaredSpeedWeighting,
    ),
  };
  if (period.spark) finalized.spark = finalizePeriod(period.spark);
  finalized.modelUsage = combinedModelUsage(finalized);
  return finalized;
}

// Build one constant-memory accounting total from an already indexed event
// stream. Unlike the recent replay cache, this deliberately retains no raw
// transition inputs, quota timeline, or chart buckets: its only contract is a
// content-free aggregate whose price cards are selected at each event's own
// timestamp. This is what lets the archive grow beyond the 31-day interactive
// cache without turning an old Mac's history into an unbounded heap.
export async function buildReplaySafeAccountingPeriod({
  id = "history",
  label = "Indexed history",
  startAt,
  endAt,
  scan,
  signal = null,
  declaredSpeedBaselines = [],
  rss = () => process.memoryUsage().rss,
  // null is "the caller does not name a ceiling", which is the ARCHIVE case:
  // resolve one off this pass's own baseline from the archive policy. The
  // rebuild names its own and is unaffected. Inheriting the rebuild's number
  // here is exactly the defect MAX_ARCHIVE_ACCOUNTING_RSS_BYTES documents.
  maximumRssBytes = null,
} = {}) {
  const canonicalStart = canonicalInstant(startAt);
  const canonicalEnd = canonicalInstant(endAt);
  if (typeof id !== "string"
      || !/^[a-z][a-z0-9_-]{0,31}$/u.test(id)
      || typeof label !== "string"
      || label.length < 1
      || label.length > 96
      || canonicalStart === null
      || canonicalEnd === null
      || Date.parse(canonicalStart) > Date.parse(canonicalEnd)
      || typeof scan !== "function"
      || !validAbortSignal(signal)
      || typeof rss !== "function"
      || (maximumRssBytes !== null
        && (!Number.isSafeInteger(maximumRssBytes) || maximumRssBytes < 1))) {
    throw new TypeError("Replay-safe accounting period options are invalid");
  }
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  const startMs = Date.parse(canonicalStart);
  const endMs = Date.parse(canonicalEnd);
  const period = newPeriod(id, label);
  const price = createAccountingPricer();
  let acceptedEvents = 0;
  // A named ceiling is taken verbatim and costs no extra reading, so the
  // rebuild's sub-build samples rss() exactly as often as it always has.
  // Only the unnamed archive case measures a baseline and derives from it.
  let effectiveMaximumRssBytes = maximumRssBytes;
  if (effectiveMaximumRssBytes === null) {
    const baselineRss = rss();
    if (!Number.isSafeInteger(baselineRss) || baselineRss < 0) {
      throw fixedError("accounting_archive_rss_measurement_invalid");
    }
    effectiveMaximumRssBytes = Math.min(
      MAX_ARCHIVE_ACCOUNTING_RSS_BYTES,
      baselineRss + ARCHIVE_ACCOUNTING_RSS_DELTA_BUDGET_BYTES,
    );
  }
  const checkRuntimeMemory = () => {
    const currentRss = rss();
    if (!Number.isSafeInteger(currentRss) || currentRss < 0) {
      throw fixedError("accounting_archive_rss_measurement_invalid");
    }
    if (currentRss > effectiveMaximumRssBytes) {
      throw fixedError("accounting_archive_rss_limit_exceeded");
    }
  };
  checkRuntimeMemory();
  await scan({
    startAt: canonicalStart,
    endAt: canonicalEnd,
    signal,
    // A period total never reads plan attribution or usage intervals; declare
    // that so a unified reader can skip deriving them for every row.
    usageAttribution: "none",
    onUsage: (rawEvent) => {
      throwIfAborted(signal);
      const observedAt = canonicalInstant(rawEvent?.timestamp);
      if (observedAt === null) return;
      const observedMs = Date.parse(observedAt);
      if (observedMs < startMs || observedMs > endMs) return;
      const event = eventProjection(rawEvent, price);
      if (event === null) return;
      event.declaredSpeed = event.speed === "unknown"
        ? declaredSpeedModeAt(baselines, observedMs) ?? "unknown"
        : "unknown";
      addEvent(period, event);
      acceptedEvents += 1;
      if (acceptedEvents % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
        checkRuntimeMemory();
      }
    },
  });
  throwIfAborted(signal);
  checkRuntimeMemory();
  return {
    generatedAt: canonicalEnd,
    coveredAt: {
      startAt: canonicalStart,
      endAt: canonicalEnd,
    },
    priceEpochBasis: HISTORICAL_PRICE_EPOCH_BASIS,
    priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    priceRegistryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
    period: finalizePeriod(period),
  };
}

function newTimelineBucket(startMs) {
  return {
    startMs,
    usageEvents: 0,
    totalTokens: 0,
    apiPriceEquivalentUsd: 0,
    speedWeighting: {},
    declaredSpeedWeighting: {},
    components: emptyComponents(),
    pricingCoverage: {
      fullyPricedEvents: 0,
      partiallyPricedEvents: 0,
      unpricedEvents: 0,
    },
  };
}

function addTimelineEvent(buckets, event) {
  const observedMs = Date.parse(event.timestamp);
  if (!Number.isFinite(observedMs)) return;
  const startMs = Math.floor(observedMs / TIMELINE_BUCKET_MS)
    * TIMELINE_BUCKET_MS;
  const bucket = buckets.get(startMs) ?? newTimelineBucket(startMs);
  const eventCount = event.eventCount ?? 1;
  bucket.usageEvents += eventCount;
  bucket.totalTokens += event.totalTokens;
  bucket.apiPriceEquivalentUsd += event.apiPriceEquivalentUsd;
  addProjectedUsd(bucket, "apiPriceEquivalentUsd", event.priced);
  addSpeedWeighting(bucket.speedWeighting, event);
  addDeclaredSpeedWeighting(bucket.declaredSpeedWeighting, event);
  addComponents(bucket.components, event.components);
  bucket.pricingCoverage[
    event.pricingCoverageStatus === "fully_priced"
      ? "fullyPricedEvents"
      : event.pricingCoverageStatus === "partially_priced"
        ? "partiallyPricedEvents"
        : "unpricedEvents"
  ] += eventCount;
  buckets.set(startMs, bucket);
}

function finalizeTimeline(buckets) {
  return [...buckets.values()]
    .sort((left, right) => left.startMs - right.startMs)
    .map((bucket) => ({
      startAt: new Date(bucket.startMs).toISOString(),
      endAt: new Date(bucket.startMs + TIMELINE_BUCKET_MS).toISOString(),
      usageEvents: bucket.usageEvents,
      totalTokens: bucket.totalTokens,
      apiPriceEquivalentUsd: roundedProjectedUsd(bucket, "apiPriceEquivalentUsd"),
      speedWeighting: compactSpeedWeighting(bucket.speedWeighting),
      declaredSpeedWeighting: compactSpeedWeighting(
        bucket.declaredSpeedWeighting,
      ),
      components: bucket.components,
      pricingCoverage: bucket.pricingCoverage,
    }));
}

function compactPlanScopedTimelineEvent(row, declaredSpeedBaselines) {
  if (!Array.isArray(row) || row.length !== 21
      || !Array.isArray(row[20]) || row[20].length !== 4) return null;
  const timestamp = canonicalInstant(row[0]);
  const components = Object.fromEntries(COMPONENT_KEYS.map((key, index) => [
    key,
    Number.isSafeInteger(row[index + 3]) && row[index + 3] >= 0
      ? row[index + 3] : null,
  ]));
  const standardUsd = Number(row[10]);
  const standardScenarioUsd = row[14];
  const fastScenarioUsd = row[15];
  if (timestamp === null || Object.values(components).includes(null)
      || !Number.isFinite(standardUsd) || standardUsd < 0
      || !Number.isFinite(standardScenarioUsd) || standardScenarioUsd < 0
      || !Number.isFinite(fastScenarioUsd) || fastScenarioUsd < 0
      || !["fully_priced", "partially_priced", "unpriced"].includes(row[12])) {
    return null;
  }
  const speed = ["standard", "fast", "ultrafast"].includes(row[9]) ? row[9] : "unknown";
  // Re-run the same timestamped declaration lookup used when the compact row
  // was constructed. Dollar equality is not provenance: it can also arise for
  // a zero-cost event (or a future 1x rate), so inferring a declaration from
  // equal scenario totals would silently relabel unknown evidence.
  const declarationResolved = speed === "unknown"
    && ["standard", "fast", "ultrafast"].includes(
      declaredSpeedModeAt(declaredSpeedBaselines, Date.parse(timestamp)),
    );
  return {
    timestamp,
    components,
    totalTokens: tokenTotal(components),
    standardUsd,
    standardScenarioUsd,
    fastScenarioUsd,
    pricingCoverageStatus: row[12],
    observedSpeed: speed !== "unknown",
    declarationResolved,
  };
}

function addCompactPlanScopedTimelineEvent(buckets, event) {
  const observedMs = Date.parse(event.timestamp);
  const startMs = Math.floor(observedMs / TIMELINE_BUCKET_MS)
    * TIMELINE_BUCKET_MS;
  const bucket = buckets.get(startMs) ?? {
    ...newTimelineBucket(startMs),
    scenarioWeighting: {
      unresolved_as_standard: 0,
      unresolved_as_fast: 0,
      unresolved_as_custom: 0,
    },
    weightingCoverage: {
      observedEvents: 0,
      declaredFromConfigEvents: 0,
      assumedEvents: 0,
    },
  };
  bucket.usageEvents += 1;
  bucket.totalTokens += event.totalTokens;
  bucket.apiPriceEquivalentUsd += event.standardUsd;
  bucket.scenarioWeighting.unresolved_as_standard +=
    event.standardScenarioUsd;
  bucket.scenarioWeighting.unresolved_as_fast += event.fastScenarioUsd;
  // Mix aggregate endpoint costs once, when the bucket is finalized.
  addComponents(bucket.components, event.components);
  bucket.pricingCoverage[
    event.pricingCoverageStatus === "fully_priced"
      ? "fullyPricedEvents"
      : event.pricingCoverageStatus === "partially_priced"
        ? "partiallyPricedEvents"
        : "unpricedEvents"
  ] += 1;
  if (event.observedSpeed) bucket.weightingCoverage.observedEvents += 1;
  else if (event.declarationResolved) {
    bucket.weightingCoverage.declaredFromConfigEvents += 1;
  } else {
    bucket.weightingCoverage.assumedEvents += 1;
  }
  buckets.set(startMs, bucket);
  return startMs;
}

function finalizePlanScopedTimelineDraft({
  unknownSpeedPolicy,
  buckets,
  invalidBuckets,
  attributionIndex,
  contextKey,
  planType,
  diagnostics,
  endMs,
  resourceLimited,
  quota,
}) {
  let invalidatedCandidateEvents = 0;
  let invalidatedBuckets = 0;
  const rows = [];
  for (const bucket of [...buckets.values()].sort((left, right) => (
    left.startMs - right.startMs
  ))) {
    const lookup = planEraForInterval(attributionIndex, {
      contextKey,
      intervalStartMs: bucket.startMs,
      observedAtMs: bucket.startMs + TIMELINE_BUCKET_MS - 1,
    });
    if (invalidBuckets.has(bucket.startMs)
        || lookup.status !== "matched"
        || lookup.era.planType !== planType) {
      invalidatedBuckets += 1;
      invalidatedCandidateEvents += bucket.usageEvents;
      invalidBuckets.add(bucket.startMs);
      continue;
    }
    bucket.scenarioWeighting.unresolved_as_custom = mixUnknownSpeedUsd(
      roundedMoney(bucket.scenarioWeighting.unresolved_as_standard),
      roundedMoney(bucket.scenarioWeighting.unresolved_as_fast), unknownSpeedPolicy);
    rows.push({
      startAt: new Date(bucket.startMs).toISOString(),
      endAt: new Date(bucket.startMs + TIMELINE_BUCKET_MS).toISOString(),
      usageEvents: bucket.usageEvents,
      totalTokens: bucket.totalTokens,
      apiPriceEquivalentUsd: roundedMoney(bucket.apiPriceEquivalentUsd),
      scenarioWeighting: Object.fromEntries(
        Object.entries(bucket.scenarioWeighting).map(([scenario, value]) => [
          scenario,
          roundedMoney(value),
        ]),
      ),
      weightingCoverage: { ...bucket.weightingCoverage },
      components: bucket.components,
      pricingCoverage: bucket.pricingCoverage,
    });
  }
  // Publish explicit comparable intervals, including quiet buckets, so a
  // consumer cannot bridge an omitted ambiguous bucket or another plan era.
  // Bounds come from the same attribution index, not the fit's training resets.
  const comparisonIntervals = [];
  const currentStart = Math.floor(endMs / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS;
  const firstStart = Math.min(rows.length ? Date.parse(rows[0].startAt) : currentStart,
    quota.length ? Math.floor(quota[0][0] / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS : currentStart);
  const lastEnd = (Math.floor(endMs / TIMELINE_BUCKET_MS) + 1) * TIMELINE_BUCKET_MS;
  const invalid = [...invalidBuckets].sort((a, b) => a - b);
  let invalidAt = 0;
  for (const era of attributionIndex?.eras ?? []) {
    if (era.contextKey !== contextKey || era.accountScopeId !== null
        || era.planType !== planType) continue;
    let start = Math.max(firstStart, era.lowerBoundMs === null ? firstStart
      : Math.ceil(era.lowerBoundMs / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS);
    const end = Math.min(lastEnd, era.upperBoundMs === null ? lastEnd
      : Math.floor((era.upperBoundMs + 1) / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS);
    while (invalidAt < invalid.length && invalid[invalidAt] < start) invalidAt += 1;
    while (invalidAt < invalid.length && invalid[invalidAt] < end) {
      const gapStart = invalid[invalidAt++];
      if (gapStart > start) comparisonIntervals.push([start, gapStart]);
      start = gapStart + TIMELINE_BUCKET_MS;
    }
    if (start < end) comparisonIntervals.push([start, end]);
  }
  const comparableQuota = [];
  let quotaIntervalAt = 0;
  for (const row of quota) {
    while (quotaIntervalAt < comparisonIntervals.length
        && comparisonIntervals[quotaIntervalAt][1] <= row[0]) quotaIntervalAt += 1;
    const interval = comparisonIntervals[quotaIntervalAt];
    if (interval && row[0] >= interval[0] && row[0] < interval[1]) comparableQuota.push(row);
  }
  const excluded = new Map();
  for (const era of attributionIndex?.eras ?? []) {
    if (era.contextKey !== contextKey || era.accountScopeId !== null || era.planType !== planType) continue;
    for (const boundary of [era.lowerBoundMs, era.upperBoundMs]) {
      if (boundary === null) continue;
      const start = Math.floor(boundary / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS;
      if (start >= firstStart && start < lastEnd) excluded.set(start, "plan_transition_interval");
    }
    const lower = Math.max(firstStart, era.firstObservedAtMs - TIMELINE_BUCKET_MS);
    const upper = Math.min(lastEnd - 1, era.lastObservedAtMs);
    for (let i = firstIndexAtLeast(invalid, lower); i < invalid.length && invalid[i] <= upper; i += 1) {
      if (!excluded.has(invalid[i])) excluded.set(invalid[i], "usage_attribution_unresolved");
    }
  }
  const excludedIntervals = [];
  let comparableAt = 0;
  for (const [start, reason] of [...excluded].sort((a, b) => a[0] - b[0])) {
    // A boundary exactly on the grain can be fully covered. Never call a
    // positively comparable bucket missing just because it borders an era.
    while (comparableAt < comparisonIntervals.length && comparisonIntervals[comparableAt][1] <= start) comparableAt += 1;
    const covered = comparisonIntervals[comparableAt];
    if (covered && start >= covered[0] && start + TIMELINE_BUCKET_MS <= covered[1]) continue;
    const prior = excludedIntervals.at(-1);
    if (prior && prior[1] === start && prior[2] === reason) prior[1] += TIMELINE_BUCKET_MS;
    else excludedIntervals.push([start, start + TIMELINE_BUCKET_MS, reason]);
  }
  return {
    planType,
    rows,
    comparisonIntervals,
    excludedIntervals,
    resourceLimited,
    attributionReady: attributionIndex?.status === "ready",
    quota: comparableQuota,
    observedQuota: quota,
    diagnostics: {
      ...diagnostics,
      admittedEvents: rows.reduce((sum, row) => sum + row.usageEvents, 0),
      invalidatedBuckets,
      invalidatedCandidateEvents,
    },
  };
}

// Closed compact form avoids duplicating full object keys for every historical
// bucket. Keep the event-summed token total: combined-output and split-output
// events can coexist in one bucket. Only coverage complements are derived.
function encodePlanScopedTimelineRow(row) {
  return [Date.parse(row.startAt), row.usageEvents,
    ...COMPONENT_KEYS.map((key) => row.components[key]),
    row.apiPriceEquivalentUsd,
    row.scenarioWeighting.unresolved_as_standard,
    row.scenarioWeighting.unresolved_as_fast,
    row.weightingCoverage.observedEvents,
    row.weightingCoverage.declaredFromConfigEvents,
    row.pricingCoverage.fullyPricedEvents,
    row.pricingCoverage.partiallyPricedEvents, row.totalTokens,
    row.scenarioWeighting.unresolved_as_custom];
}

export function decodePlanScopedTimelineRow(row) {
  if (!Array.isArray(row) || row.length !== 17
      || row.some((value) => typeof value !== "number" || !Number.isFinite(value))
      || !Number.isSafeInteger(row[0]) || row[0] % TIMELINE_BUCKET_MS !== 0
      || !Number.isFinite(new Date(row[0] + TIMELINE_BUCKET_MS).getTime())
      || row.slice(1).some((value) => value < 0)
      || [1, 2, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15].some((i) => !Number.isSafeInteger(row[i]))
      || row[1] < 1 || row[11] + row[12] > row[1]
      || row[13] + row[14] > row[1]) return null;
  const components = Object.fromEntries(COMPONENT_KEYS.map((key, i) => [key, row[i + 2]]));
  return {
    startAt: new Date(row[0]).toISOString(),
    endAt: new Date(row[0] + TIMELINE_BUCKET_MS).toISOString(),
    usageEvents: row[1], totalTokens: row[15], components,
    apiPriceEquivalentUsd: row[8],
    scenarioWeighting: { unresolved_as_standard: row[9], unresolved_as_fast: row[10], unresolved_as_custom: row[16] },
    weightingCoverage: { observedEvents: row[11], declaredFromConfigEvents: row[12],
      assumedEvents: row[1] - row[11] - row[12] },
    pricingCoverage: { fullyPricedEvents: row[13], partiallyPricedEvents: row[14],
      unpricedEvents: row[1] - row[13] - row[14] },
  };
}

function unavailablePlanTimeline(reason) {
  return {
    schemaVersion: PLAN_SCOPED_TIMELINE_SCHEMA_VERSION,
    encoding: PLAN_TIMELINE_ENCODING,
    status: "unavailable", reason, planScope: null, usage: [], quota: [], observedQuota: [], comparisonIntervals: [], excludedIntervals: [],
    diagnostics: { consideredEvents: 0, admittedEvents: 0, incompatibleEvents: 0,
      unresolvedEvents: 0, conflictedEvents: 0, malformedEvents: 0,
      invalidatedBuckets: 0, invalidatedCandidateEvents: 0 },
  };
}

function calibrationCohortId(calibration) {
  if (calibration?.status !== "estimated"
      || !Array.isArray(calibration.recentResets)
      || calibration.recentResets.length === 0) return null;
  const cohort = calibration.recentResets.map((row) => row?.resetIdentity);
  if (cohort.some((value) => canonicalInstant(value) === null)) return null;
  return createHash("sha256").update(JSON.stringify(cohort)).digest("hex");
}

function planScopedTimelineReceipt({
  draft,
  sourceMode,
  generation,
  generationFingerprint,
  capacityPlanScope,
}) {
  const unavailable = unavailablePlanTimeline;
  if (sourceMode !== "unified"
      || generation === null || generation === undefined
      || generationFingerprint === null
      || generationFingerprint === undefined) {
    return unavailable("plan_scoped_generation_unavailable");
  }
  if (!draft || draft.attributionReady !== true || draft.planType === "unknown"
      || draft.diagnostics?.malformedEvents !== 0
      || capacityPlanScope?.planType !== draft.planType
      || capacityPlanScope?.methodVersion
        !== PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION) {
    return unavailable("plan_scoped_attribution_unavailable");
  }
  if (draft.resourceLimited || draft.rows.length > MAX_PLAN_TIMELINE_ROWS
      || draft.comparisonIntervals.length > MAX_PLAN_TIMELINE_ROWS
      || draft.excludedIntervals.length > MAX_PLAN_TIMELINE_ROWS
      || draft.observedQuota.length > MAX_PLAN_TIMELINE_ROWS
      || draft.quota.length > MAX_PLAN_TIMELINE_ROWS) return unavailable("plan_scoped_resource_limit");
  const receipt = {
    schemaVersion: PLAN_SCOPED_TIMELINE_SCHEMA_VERSION,
    encoding: PLAN_TIMELINE_ENCODING,
    status: "available",
    reason: null,
    planScope: {
      ...capacityPlanScope,
      sourceGeneration: generation,
      sourceGenerationFingerprint: generationFingerprint,
    },
    usage: draft.rows.map(encodePlanScopedTimelineRow),
    comparisonIntervals: draft.comparisonIntervals,
    excludedIntervals: draft.excludedIntervals,
    quota: draft.quota,
    observedQuota: draft.observedQuota,
    diagnostics: draft.diagnostics,
  };
  return Buffer.byteLength(stableJson(receipt)) <= MAX_PLAN_TIMELINE_BYTES
    ? receipt : unavailable("plan_scoped_resource_limit");
}

// Select an existing fit, never pool plans or refit a history lane using the
// current plan's capacity. This is a projection, not an additional ledger.
function allowanceCapacityForPlan(container, planType) {
  const scenarios = {};
  for (const [scenario, row] of Object.entries(container.scenarios)) {
    const calibration = row.calibration;
    const population = calibration.planPopulations.find((p) => p.planType === planType);
    if (!population) return null;
    scenarios[scenario] = { ...row, calibration: {
      ...population, selectedPlanType: planType, planPopulations: calibration.planPopulations,
    } };
  }
  return { ...container, scenarios, planScope: {
    ...container.planScope, planType,
    cohortId: calibrationCohortId(scenarios[container.selectedScenario].calibration),
  } };
}

async function fitHistoricalPlanTimelines(options, planTypes, currentPlanType) {
  if (!Array.isArray(planTypes) || planTypes.length > 16) {
    throw fixedError("accounting_transition_derivation_limit_exceeded");
  }
  const results = [];
  for (const planType of [...new Set(planTypes)].sort()) {
    if (planType === currentPlanType || planType === "unknown") continue;
    throwIfAborted(options.signal);
    try {
      const fit = await fitCompositionFromCorpusStream({ ...options, selectedPlanType: planType });
      results.push({ planType, draft: fit.planScopedTimeline, failure: null });
    } catch (error) {
      throwIfAborted(options.signal);
      results.push({ planType, draft: null, failure: compositionFitFailureReason(error) });
    }
  }
  return results;
}

function historicalPlanComparisonReceipts(drafts, capacity, provenance) {
  let retainedBytes = 0;
  return drafts.map(({ planType, draft, failure }) => {
    const allowanceCapacityByScenario = allowanceCapacityForPlan(capacity, planType);
    const row = { planType, failure, allowanceCapacityByScenario,
      planScopedTimeline: planScopedTimelineReceipt({
        ...provenance, draft, capacityPlanScope: allowanceCapacityByScenario?.planScope,
      }),
    };
    const bytes = Buffer.byteLength(stableJson(row));
    if (retainedBytes + bytes > MAX_PLAN_TIMELINE_BYTES) {
      row.planScopedTimeline = unavailablePlanTimeline("plan_scoped_resource_limit");
      row.failure = "accounting_plan_timeline_resource_limit";
    } else retainedBytes += bytes;
    return row;
  });
}

function publicDiagnostics(value) {
  return {
    filesScanned: Number.isSafeInteger(value?.filesScanned)
      ? value.filesScanned
      : 0,
    forkReplayEventsExcluded: Number.isSafeInteger(value?.forkReplayEventsSkipped)
      ? value.forkReplayEventsSkipped
      : 0,
    unattributedForkReplayEventsExcluded:
      Number.isSafeInteger(value?.unattributedForkReplayEventsSkipped)
        ? value.unattributedForkReplayEventsSkipped
        : 0,
    duplicateSnapshotsExcluded:
      Number.isSafeInteger(value?.duplicateSnapshotsSkipped)
        ? value.duplicateSnapshotsSkipped
        : 0,
    contradictedLeadingSnapshotsExcluded:
      Number.isSafeInteger(value?.contradictedLeadingSnapshotsSkipped)
        ? value.contradictedLeadingSnapshotsSkipped
        : 0,
    missingLineageParents: Number.isSafeInteger(value?.lineageParentsMissing)
      ? value.lineageParentsMissing
      : 0,
  };
}

export function defaultReplaySafeAccountingCachePath(
  root = process.cwd(),
) {
  return defaultLocalCollectorStatePath(root);
}

function cooperativeYield() {
  return new Promise((resolve) => setImmediate(resolve));
}

function firstIndexAtLeast(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstIndexAbove(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Mirror of the transition miner's windowKey over the compact snapshot
// encoding [timestamp, timestampMs, provider, planType, limitId, slot,
// windowDurationMins, resetsAt, usedPercent]. Transitions are derived from
// consecutive snapshots WITHIN one of these groups, never across groups,
// which is what makes the batched derivation below exact. Window identity is
// slot-agnostic (v0.6), exactly like the miner's windowKey: slot is a UI
// role, so grouping on it here would split one window's rows across batches
// wherever the server-side slot flipped mid-history and silently drop the
// transition that crosses the flip.
function compactSnapshotGroupKey(row) {
  return [row[2], row[3], row[4], row[6], row[7]].join("|");
}

// The transition miner refuses more than 10,000 derived rows per call — a
// structural memory-safety ceiling owned by codex-transition-miner.js, not a
// data-window policy. A full unbounded history legitimately holds more (the
// real corpus measured 18,176 weekly transitions over its first 82 days), so
// the derivation is partitioned by reset-window group and each batch stays
// under the ceiling with headroom. Cumulative aggregations are
// difference-based over each window's own span, so deriving disjoint group
// batches against a usage slice that covers every window start in the batch
// reproduces the unbatched result exactly.
const CALIBRATION_BATCH_TRANSITION_BUDGET = 8_000;
// The transition ceiling alone is not a useful memory bound: a few quota
// changes spread across many high-volume days can still make one batch decode
// hundreds of thousands of compact usage rows at once. Partition on the
// actual contiguous usage slice too. This is a working-set bound only; every
// row remains in exactly one derivation slice (apart from the intentional
// overlap required by overlapping reset windows), so it does not shorten the
// calibration history or discard evidence.
const CALIBRATION_BATCH_USAGE_BUDGET = 50_000;

async function deriveBoundedWeeklyCalibrationSeries({
  startAt,
  endAt,
  // The streaming corpus handle, so at most one batch slice of priced rows is
  // ever resident at a time.
  usageCorpus,
  rateLimitSnapshots,
  diagnostics,
  signal,
  resourceCheck,
  planAttributionIndex,
  limits = DEFAULT_TRANSITION_RESOURCE_LIMITS,
}) {
  if (usageCorpus === null || typeof usageCorpus !== "object") {
    throw new TypeError("deriveBoundedWeeklyCalibrationSeries requires a usage corpus");
  }
  const usageEventCount = usageCorpus.count;
  const readUsageSlice = async (low, high) => (
    low >= high
      ? []
      : usageCorpus.readSlice(low, high)
  );
  const batchUsageBudget = Math.min(CALIBRATION_BATCH_USAGE_BUDGET, limits.usageEvents);
  const derive = (usage, snapshots) => {
    if (usage.length > limits.usageEvents
        || snapshots.length > limits.weeklySnapshots
        || usage.length + snapshots.length > limits.combinedInputs) {
      throw fixedError("accounting_transition_derivation_limit_exceeded");
    }
    return deriveCodexTransitionSeriesCooperatively({
      startAt,
      endAt,
      rawUsageEvents: usage,
      rateLimitSnapshots: snapshots,
      diagnostics,
      includeSnapshotIntervals: false,
      // The retained corpus is already limited to the two reviewed main
      // allowance durations. Derive both in the same bounded usage pass so
      // five-hour history does not require a second raw-log scan.
      windowDurationMins: null,
      signal,
      consumeInputs: true,
      includeNormalizedInputs: false,
      inputEncoding: "accounting_prepriced_compact_v3",
      planAttributionIndex,
      resourceCheck,
    });
  };

  // Group the compact snapshots exactly as the miner will, and count the
  // transitions each group will derive: within a group the miner walks
  // deduplicated snapshots in (time, percent) order and emits one transition
  // per consecutive percent change, so this count is exact, not an estimate.
  const groups = new Map();
  for (let index = 0; index < rateLimitSnapshots.length; index += 1) {
    if (index % 8_192 === 0) {
      throwIfAborted(signal);
      resourceCheck?.();
      await cooperativeYield();
    }
    const row = rateLimitSnapshots[index];
    if (!Array.isArray(row) || row.length !== 9) continue;
    const key = compactSnapshotGroupKey(row);
    let group = groups.get(key);
    if (group === undefined) {
      group = { rows: [], dedupe: new Set(), deduped: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
    const dedupeKey = `${row[0]}|${row[8]}`;
    if (!group.dedupe.has(dedupeKey)) {
      group.dedupe.add(dedupeKey);
      group.deduped.push(row);
    }
  }
  let totalTransitions = 0;
  const deduplicatedSnapshotCountByWindow = {};
  for (const group of groups.values()) {
    const ordered = [...group.deduped].sort(
      (left, right) => left[1] - right[1] || left[8] - right[8],
    );
    let transitions = 0;
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index][8] !== ordered[index - 1][8]) transitions += 1;
    }
    const durationMins = Number(ordered[0]?.[6]);
    if (Number.isSafeInteger(durationMins)) {
      deduplicatedSnapshotCountByWindow[durationMins] =
        (deduplicatedSnapshotCountByWindow[durationMins] ?? 0)
        + ordered.length;
    }
    const resetsAt = Number(ordered[0]?.[7]);
    const windowStartMs = (resetsAt - durationMins * 60) * 1_000;
    group.transitions = transitions;
    const firstMs = Number(ordered[0]?.[1] ?? 0);
    // A group whose reset window cannot be computed must still be BOUNDED.
    // This previously fell back to NEGATIVE_INFINITY, which the batch loop
    // turned into `low = 0` — so one group with an unparseable duration or
    // reset stamp took a usage slice running from the very first row of the
    // corpus to its own last observation. On a large history that is the
    // entire corpus in a single derivation, which defeats
    // CALIBRATION_BATCH_USAGE_BUDGET completely and is why a rebuild with a
    // multi-gigabyte ceiling still deferred with
    // accounting_transition_rss_limit_exceeded: the working set was never
    // bounded at all, so no ceiling could have been large enough.
    //
    // The honest bound is the group's own first observation less one window:
    // a group's transitions cannot be attributed to usage older than the
    // window containing its earliest snapshot. Prefer the group's declared
    // duration, fall back to the weekly window this series derives.
    const boundedDurationMins = Number.isFinite(durationMins) && durationMins > 0
      ? durationMins
      : WEEKLY_WINDOW_MINUTES;
    const fallbackStartMs = Number.isFinite(firstMs)
      ? firstMs - boundedDurationMins * 60_000
      : Number.NEGATIVE_INFINITY;
    group.sliceStartMs = Number.isFinite(windowStartMs)
      ? windowStartMs
      : fallbackStartMs;
    group.firstMs = firstMs;
    group.lastMs = Number(ordered.at(-1)?.[1] ?? 0);
    totalTransitions += transitions;
    // `dedupe` and `deduped` exist only to derive the four scalars above. They
    // are never read again, but without this they stay reachable for the whole
    // pass — a Set of one interned key string per unique (observedAt, percent)
    // plus a second array of row references, per group, held alongside the
    // rows themselves and alongside the caller's `rateLimitSnapshots`. Release
    // them at the point of last use so the batch loop runs against one copy of
    // the snapshots rather than three views of them.
    group.dedupe = null;
    group.deduped = null;
  }
  throwIfAborted(signal);
  resourceCheck?.();

  if (totalTransitions <= CALIBRATION_BATCH_TRANSITION_BUDGET
      && usageEventCount <= batchUsageBudget) {
    const usage = await readUsageSlice(0, usageEventCount);
    const series = await derive(usage, rateLimitSnapshots);
    return {
      transitions: series.transitions,
      deduplicatedSnapshotCount: series.deduplicatedSnapshotCount,
      deduplicatedSnapshotCountByWindow,
    };
  }

  // Sort the compact usage rows once so every batch can take the contiguous
  // slice that covers its groups' windows. Rows without a parseable timestamp
  // would be dropped by the miner's own normalization, so excluding them here
  // changes nothing. The streaming corpus arrives already ordered and stamped,
  // so it supplies the timestamp list directly and each batch's rows are read
  // off the index on demand instead of being sliced out of a resident copy.
  const sortedMs = usageCorpus.usageMs;

  const orderedGroups = [...groups.values()].sort((left, right) => (
    left.sliceStartMs - right.sliceStartMs
    || left.firstMs - right.firstMs
    || left.lastMs - right.lastMs
  ));
  const batches = [];
  let current = null;
  for (const group of orderedGroups) {
    const nextSliceStartMs = Math.min(
      current?.sliceStartMs ?? Number.POSITIVE_INFINITY,
      group.sliceStartMs,
    );
    const nextSliceEndMs = Math.max(
      current?.sliceEndMs ?? Number.NEGATIVE_INFINITY,
      group.lastMs,
    );
    const nextUsageRows = firstIndexAbove(sortedMs, nextSliceEndMs)
      - (nextSliceStartMs === Number.NEGATIVE_INFINITY
        ? 0
        : firstIndexAtLeast(sortedMs, nextSliceStartMs));
    if (current === null
        || (current.groups.length > 0
          && (current.transitions + group.transitions
              > CALIBRATION_BATCH_TRANSITION_BUDGET
            || nextUsageRows > batchUsageBudget))) {
      current = {
        groups: [],
        transitions: 0,
        sliceStartMs: Number.POSITIVE_INFINITY,
        sliceEndMs: Number.NEGATIVE_INFINITY,
      };
      batches.push(current);
    }
    current.groups.push(group);
    current.transitions += group.transitions;
    current.sliceStartMs = Math.min(current.sliceStartMs, group.sliceStartMs);
    current.sliceEndMs = Math.max(current.sliceEndMs, group.lastMs);
  }

  const transitions = [];
  let deduplicatedSnapshotCount = 0;
  for (const batch of batches) {
    throwIfAborted(signal);
    resourceCheck?.();
    const low = batch.sliceStartMs === Number.NEGATIVE_INFINITY
      ? 0
      : firstIndexAtLeast(sortedMs, batch.sliceStartMs);
    const high = firstIndexAbove(sortedMs, batch.sliceEndMs);
    const usageSlice = await readUsageSlice(low, high);
    const snapshotSlice = [];
    for (const group of batch.groups) snapshotSlice.push(...group.rows);
    const series = await derive(usageSlice, snapshotSlice);
    transitions.push(...series.transitions);
    deduplicatedSnapshotCount += series.deduplicatedSnapshotCount;
  }
  rateLimitSnapshots.length = 0;
  transitions.sort((left, right) => left.eventTime.localeCompare(right.eventTime)
    || left.resetIdentity.localeCompare(right.resetIdentity)
    || left.windowDurationMins - right.windowDurationMins
    || left.slot.localeCompare(right.slot));
  return {
    transitions,
    deduplicatedSnapshotCount,
    deduplicatedSnapshotCountByWindow,
  };
}

const UNIFIED_CALIBRATION_READ_BATCH_ROWS = 20_000;
const COMPOSITION_RECENT_MIX_DAYS = 14;
const COMPOSITION_FIT_FAILURE_REASON_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;

// A bounded, machine-safe reason for a failed composition fit: the typed
// error code when one exists, the error name otherwise. Never free-form
// message text — messages can carry paths.
function compositionFitFailureReason(error) {
  const candidate = typeof error?.code === "string" && error.code.length > 0
    ? error.code
    : typeof error?.name === "string" && error.name.length > 0
      ? error.name
      : "unknown";
  return COMPOSITION_FIT_FAILURE_REASON_PATTERN.test(candidate)
    ? candidate
    : "unknown";
}

// The composition fit, taking the usage corpus as a row visitor so the corpus
// is never resident. It folds rows in the same order with the same cadence as
// the per-event fold it replaced.
function createCompositionFitConsumer({
  onTiming = null, monotonicClock = undefined,
  weeklyRateLimitSnapshots,
  endMs,
  signal = null,
  checkRuntimeMemory = () => {},
  planAttributionIndex = null,
  selectedPlanType = null,
  declaredSpeedBaselines = [],
  unknownSpeedPolicy = DEFAULT_UNKNOWN_SPEED_POLICY,
}) {
  const fitTiming = createLocalRefreshTimer({ onTiming, clock: monotonicClock });
  const grainMs = MODEL_COMPOSITION_POLICY.grainMs;
  const contextKey = planAttributionContextKey("openai_codex", "codex");
  const attributionIndex = planAttributionIndex ?? buildPlanAttributionIndex(
    weeklyRateLimitSnapshots.filter(Array.isArray)
      .map((row) => ({ contextKey, observedAtMs: row[1], planType: row[3] })),
  );
  const planType = selectedPlanType ?? weeklyRateLimitSnapshots.filter((row) => (
    Array.isArray(row) && Number.isSafeInteger(row[1])
  ))
    .sort((left, right) => left[1] - right[1]).at(-1)?.[3] ?? "unknown";
  const excludedBins = new Set();
  const planScopedBuckets = new Map();
  const invalidPlanScopedBuckets = new Set();
  let planTimelineResourceLimited = false;
  const checkPlanTimelineSize = () => {
    if (planScopedBuckets.size + invalidPlanScopedBuckets.size > MAX_PLAN_TIMELINE_ROWS) {
      planTimelineResourceLimited = true;
      planScopedBuckets.clear();
      invalidPlanScopedBuckets.clear();
    }
  };
  const planScopedDiagnostics = {
    consideredEvents: 0,
    incompatibleEvents: 0,
    unresolvedEvents: 0,
    conflictedEvents: 0,
    malformedEvents: 0,
  };
  const recentStartMs = endMs - COMPOSITION_RECENT_MIX_DAYS * 24 * 60 * 60 * 1_000;
  // binStartMs -> Map(model -> summed costUsd), Maps kept in first-encounter
  // order so the kernel accumulates in the same order the per-event path did
  // and the fit stays bit-identical.
  const binCosts = new Map();
  const recentMix = {};
  const recentCostsByBin = new Map();
  let processed = 0;
  const consumeCore = async (row) => {
    processed += 1;
    if (processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      throwIfAborted(signal);
      checkRuntimeMemory();
      await cooperativeYield();
    }
    if (!Array.isArray(row)) return;
    const observedAtMs = Date.parse(row[0]);
    const costUsd = Number(row[10]);
    if (!Number.isFinite(observedAtMs)
        || typeof row[1] !== "string"
        || !Number.isFinite(costUsd)
        || costUsd < 0) return;
    const model = row[1];
    const binStartMs = Math.floor(observedAtMs / grainMs) * grainMs;
    const intervalStartMs = Date.parse(row[20]?.[2] ?? "");
    const association = fitTiming.measureSync("fit_attribution",()=>classifyUsageAttribution(attributionIndex, {
      contextKey, observedAtMs,
      ...(Number.isSafeInteger(intervalStartMs) ? { intervalStartMs } : {}),
      observedPlanType: row[20]?.[0] === "same_record" ? row[20][1] : null,
    }, { planType }),{aggregate:true});
    const planTimelineEvent = fitTiming.measureSync("fit_event_projection",()=>compactPlanScopedTimelineEvent(
      row,
      declaredSpeedBaselines,
    ),{aggregate:true});
    if (planTimelineEvent === null) {
      planScopedDiagnostics.malformedEvents += 1;
    } else {
      planScopedDiagnostics.consideredEvents += 1;
    }
    if (association.disposition === "incompatible") {
      if (planTimelineEvent !== null) {
        planScopedDiagnostics.incompatibleEvents += 1;
      }
      return;
    }
    if (row[20]?.[0] === "conflicted"
        || association.disposition === "unresolved") {
      excludedBins.add(binStartMs);
      if (planTimelineEvent !== null) {
        if (!planTimelineResourceLimited) invalidPlanScopedBuckets.add(
          Math.floor(observedAtMs / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS,
        );
        checkPlanTimelineSize();
        if (row[20]?.[0] === "conflicted") {
          planScopedDiagnostics.conflictedEvents += 1;
        } else {
          planScopedDiagnostics.unresolvedEvents += 1;
        }
      }
      return;
    }
    if (planTimelineEvent !== null && !planTimelineResourceLimited) {
      addCompactPlanScopedTimelineEvent(planScopedBuckets, planTimelineEvent);
    }
    checkPlanTimelineSize();
    // The kernel's own binning refuses empty model names; the recent mix
    // mirrors the historical per-event behavior and keeps them.
    if (model.length > 0) {
      let costs = binCosts.get(binStartMs);
      if (costs === undefined) {
        costs = new Map();
        binCosts.set(binStartMs, costs);
      }
      costs.set(model, (costs.get(model) ?? 0) + costUsd);
    }
    if (observedAtMs >= recentStartMs) {
      let recentCosts = recentCostsByBin.get(binStartMs);
      if (recentCosts === undefined) {
        recentCosts = new Map();
        recentCostsByBin.set(binStartMs, recentCosts);
      }
      recentCosts.set(model, (recentCosts.get(model) ?? 0) + costUsd);
    }
  };
  const consume = row => fitTiming.measure("fit_row_processing",()=>consumeCore(row),{aggregate:true});
  const finish = async () => {
    fitTiming.flush();
    const quotaRows = [];
    // Use admitted plan-preserving snapshots, not the generic timeline whose
    // same-instant collapse may already have chosen a different plan's row.
    const scopedQuota = new Map();
    for (const row of weeklyRateLimitSnapshots) {
      processed += 1;
      if (processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
        throwIfAborted(signal);
        checkRuntimeMemory();
        await cooperativeYield();
      }
      if (!Array.isArray(row)) continue;
      const observedAtMs = Number(row[1]);
      const resetsAtSeconds = Number(row[7]);
      const usedPercent = Number(row[8]);
      if (!Number.isFinite(observedAtMs)
          || !Number.isFinite(resetsAtSeconds)
          || !Number.isFinite(usedPercent)) continue;
      if (row[3] !== planType) continue;
      const sevenDay = row[6] === WEEKLY_WINDOW_MINUTES;
      if (!planTimelineResourceLimited && row[2] === "openai_codex"
          && row[4] === "codex" && sevenDay
          && usedPercent >= 0 && usedPercent <= 100) {
        const match = planEraForInterval(attributionIndex, { contextKey, observedAtMs });
        if (match.status === "matched" && match.era.planType === planType) {
          const prior = scopedQuota.get(observedAtMs);
          if (prior === null) {
            // Once contradictory, later repeated rows cannot restore a winner.
          } else if (prior && (prior[1] !== resetsAtSeconds || prior[2] !== usedPercent)) {
            scopedQuota.set(observedAtMs, null);
            invalidPlanScopedBuckets.add(Math.floor(observedAtMs / TIMELINE_BUCKET_MS) * TIMELINE_BUCKET_MS);
            checkPlanTimelineSize();
          } else scopedQuota.set(observedAtMs, [observedAtMs, resetsAtSeconds, usedPercent]);
          if (scopedQuota.size > MAX_PLAN_TIMELINE_ROWS || planTimelineResourceLimited) {
            planTimelineResourceLimited = true;
            scopedQuota.clear();
          }
        }
      }
      // Composition and the selected-plan comparison remain seven-day
      // contracts. The five-hour observations share the attribution index and
      // calibration pass, but must not become duplicate quota points in the
      // seven-day capacity fit.
      if (!sevenDay) continue;
      quotaRows.push({
        observedAtMs,
        planType: typeof row[3] === "string" ? row[3] : "unknown",
        resetsAtMs: resetsAtSeconds * 1_000,
        usedPercent,
      });
    }
    // One aggregated row per (bin, model): O(bins x models), not O(events).
    const usageRows = [];
    for (const binStartMs of new Set([...binCosts.keys(), ...recentCostsByBin.keys()])) {
      const lookup = planEraForInterval(attributionIndex, {
        contextKey, observedAtMs: binStartMs + grainMs - 1, intervalStartMs: binStartMs,
      });
      if (lookup.status !== "matched" || lookup.era.planType !== planType) excludedBins.add(binStartMs);
      if (excludedBins.has(binStartMs)) continue;
      for (const [model, costUsd] of binCosts.get(binStartMs) ?? []) {
        usageRows.push({ observedAtMs: binStartMs, model, costUsd });
      }
      // Later conflicting rows can invalidate a whole bin. The recent model mix
      // must use the same eligible bins as the fit, not an already-added subtotal.
      for (const [model, costUsd] of recentCostsByBin.get(binStartMs) ?? []) {
        recentMix[model] = (recentMix[model] ?? 0) + costUsd;
      }
    }
    binCosts.clear();
    recentCostsByBin.clear();
    const { observations, voidedBinCount, poolCount } =
      fitTiming.measureSync("accounting_fit_observations",()=>buildCompositionObservations({ usageRows, quotaRows: quotaRows.filter((row) => (
        !excludedBins.has(Math.floor(row.observedAtMs / grainMs) * grainMs)
      )) }));
    const fit = fitTiming.measureSync("accounting_fit_solver",()=>calibrateCompositionCapacities(observations));
    const blendedRecentMixUsd = fit.status === "fitted"
      ? blendedCompositionCapacityUsd(recentMix, {
        capacityUsdByModel: fit.capacityUsdByModel,
        fallbackCapacityUsd: fit.singleConstantUsd,
      })
      : null;
    const planScopedTimeline = fitTiming.measureSync("accounting_fit_timeline",()=>finalizePlanScopedTimelineDraft({
      unknownSpeedPolicy,
      buckets: planScopedBuckets,
      invalidBuckets: invalidPlanScopedBuckets,
      attributionIndex,
      contextKey,
      planType,
      diagnostics: planScopedDiagnostics,
      endMs,
      resourceLimited: planTimelineResourceLimited,
      quota: [...scopedQuota.values()].filter((row) => row !== null).sort((a, b) => a[0] - b[0]),
    }));
    return {
      planType,
      attributionExcludedBins: excludedBins.size,
      status: fit.status,
      grainHours: MODEL_COMPOSITION_POLICY.grainMs / 3_600_000,
      observationCount: fit.observationCount,
      voidedBinCount,
      poolCount,
      capacityUsdByModel: fit.capacityUsdByModel,
      modelCostShares: fit.modelCostShares,
      r2: fit.r2,
      singleConstantUsd: fit.singleConstantUsd,
      singleConstantR2: fit.singleConstantR2,
      // Why a fit was ACCEPTED or REJECTED. Without this a fallback_blended
      // reaches the dashboard with no recoverable reason, and recovering it costs
      // a full re-run of the kernel against the corpus (2026-08-20). The gate at
      // model-composition.js reads these exact fields, so persisting them is what
      // makes the decision auditable after the fact.
      identification: fit.identification ?? null,
      blendedRecentMixUsd: Number.isFinite(blendedRecentMixUsd)
        ? Number(blendedRecentMixUsd.toFixed(2))
        : null,
      recentMixDays: COMPOSITION_RECENT_MIX_DAYS,
      planScopedTimeline,
    };
  };
  return { consume, finish };
}

async function fitCompositionFromCorpusStream(options) {
  const consumer = createCompositionFitConsumer(options);
  await options.forEachUsageRow(consumer.consume);
  return consumer.finish();
}

// Fit every admitted plan over one ordered corpus traversal. Each consumer
// retains only its bounded aggregates, never another full event collection.
// Per-plan failures remain optional enrichment failures; a failed shared read
// invalidates all unfinished fits, and cancellation always escapes.
async function fitPlanCompositionsFromCorpus(options, planTypes, currentPlanType) {
  const fitTiming = createLocalRefreshTimer({ onTiming: options.onTiming, clock: options.monotonicClock });
  if (!Array.isArray(planTypes) || planTypes.length > 16) {
    throw fixedError("accounting_transition_derivation_limit_exceeded");
  }
  const historical = [...new Set(planTypes)].sort()
    .filter(plan => plan !== currentPlanType && plan !== "unknown");
  const lanes = [currentPlanType, ...historical].map(planType => {
    try {
      return { planType, consumer: createCompositionFitConsumer({ ...options, selectedPlanType: planType }), failure: null };
    } catch (error) {
      throwIfAborted(options.signal);
      if (error?.name === "AbortError") throw error;
      return { planType, consumer: null, failure: compositionFitFailureReason(error) };
    }
  });
  const failed = (lane, error) => {
    throwIfAborted(options.signal);
    if (error?.name === "AbortError") throw error;
    lane.failure = compositionFitFailureReason(error);
    lane.consumer = null;
  };
  throwIfAborted(options.signal);
  options.checkRuntimeMemory?.();
  try {
    await fitTiming.measure("accounting_fit_stream",()=>options.forEachUsageRow(async row => {
      for (const lane of lanes) {
        if (lane.consumer === null) continue;
        try { await lane.consumer.consume(row); }
        catch (error) { failed(lane, error); }
      }
    }));
  } catch (error) {
    for (const lane of lanes) if (lane.consumer !== null) failed(lane, error);
    throwIfAborted(options.signal);
    if (error?.name === "AbortError") throw error;
  }
  for (const lane of lanes) {
    throwIfAborted(options.signal);
    options.checkRuntimeMemory?.();
    if (lane.consumer === null) continue;
    try { lane.result = await fitTiming.measure(lane === lanes[0] ? "accounting_fit_current_finish" : "accounting_fit_historical_finish",()=>lane.consumer.finish()); }
    catch (error) { failed(lane, error); }
    finally { lane.consumer = null; }
  }
  const current = lanes[0];
  return {
    compositionResult: current.result ?? null,
    compositionFitFailure: current.failure === null ? null : { status: "fit_failed", reason: current.failure },
    historicalPlanDrafts: lanes.slice(1).map(lane => ({
      planType: lane.planType, draft: lane.result?.planScopedTimeline ?? null, failure: lane.failure,
    })),
  };
}

export async function buildReplaySafeAccountingCache({
  codexHome = join(homedir(), ".codex"),
  now = () => Date.now(),
  windowDays = DEFAULT_WINDOW_DAYS,
  // The store's committed facts, as a scan with the contract of the unified
  // accounting reader (see src/local-index-accounting-cache.js).
  scan = null,
  // The full-history calibration corpus source. Only `open` is consumed here;
  // its null result fails the build closed.
  calibrationSource = null,
  sourceMode = null,
  expectedGeneration = null,
  contextBehavior = DEFAULT_ACCOUNTING_CONTEXT_BEHAVIOR,
  signal = null,
  // Timestamped Codex `service_tier` readings. Each covers only the interval
  // it was actually observed over, so a reading can never reach back before it
  // happened. An absent or unreadable ledger is simply no coverage.
  declaredSpeedBaselines = [],
  unknownSpeedPolicy = DEFAULT_UNKNOWN_SPEED_POLICY,
  transitionResourceLimits: requestedTransitionResourceLimits = null,
  rss = () => process.memoryUsage().rss,
  maximumRssBytes = MAX_ACCOUNTING_RSS_BYTES,
  // In-process characterization seam: receives the calibration corpus's
  // content-free work counters (row and attribution-read counts) once the
  // corpus has been fully consumed.
  onCalibrationCorpusMetrics = null,
  onTiming = null,
  monotonicClock = undefined,
} = {}) {
  const timing = createLocalRefreshTimer({ onTiming, clock: monotonicClock });
  if (typeof scan !== "function") {
    throw fixedError("accounting_source_required");
  }
  if (calibrationSource === null
      || typeof calibrationSource !== "object"
      || typeof calibrationSource.open !== "function") {
    throw fixedError("accounting_calibration_source_required");
  }
  if (onCalibrationCorpusMetrics !== null
      && typeof onCalibrationCorpusMetrics !== "function") {
    throw new TypeError("onCalibrationCorpusMetrics must be a function or null");
  }
  unknownSpeedPolicy = validateUnknownSpeedPolicy(unknownSpeedPolicy);
  const selectedSourceMode = normalizeAccountingSourceMode(sourceMode);
  const selectedContextBehavior = normalizeContextBehavior(contextBehavior);
  if (expectedGeneration === null || expectedGeneration === undefined) {
    throw fixedError("accounting_unified_generation_required");
  }
  if (expectedGeneration !== null
      && expectedGeneration !== undefined
      && expectedGenerationTokens(expectedGeneration).length === 0) {
    throw new TypeError("expectedGeneration is invalid");
  }
  const endMs = now();
  if (!Number.isFinite(endMs)
      || !Number.isSafeInteger(windowDays)
      || windowDays < MINIMUM_WINDOW_DAYS
      || windowDays > MAXIMUM_WINDOW_DAYS
      || !validAbortSignal(signal)
      || typeof rss !== "function"
      || !Number.isSafeInteger(maximumRssBytes)
      || maximumRssBytes < 1) {
    throw new TypeError("Replay-safe accounting options are invalid");
  }
  const baselines = Array.isArray(declaredSpeedBaselines)
    ? declaredSpeedBaselines
    : [];
  // Budget-relative guard: the pass is charged for its OWN growth over the
  // RSS captured here at build start, so a large companion baseline no longer
  // silently spends the budget before the pass begins — and a small baseline
  // no longer grants the pass an accidental gigabyte. The absolute ceiling is
  // retained as the hard backstop, so the effective limit is whichever of
  // (baseline + delta budget, absolute ceiling) is LOWER.
  const baselineRss = rss();
  if (!Number.isSafeInteger(baselineRss) || baselineRss < 0) {
    throw fixedError("accounting_transition_rss_measurement_invalid");
  }
  const effectiveMaximumRssBytes = Math.min(
    maximumRssBytes,
    baselineRss + ACCOUNTING_RSS_DELTA_BUDGET_BYTES,
  );
  const checkRuntimeMemory = (additionalBytes = 0) => {
    const currentRss = rss();
    if (!Number.isSafeInteger(currentRss) || currentRss < 0) {
      throw fixedError("accounting_transition_rss_measurement_invalid");
    }
    if (currentRss > effectiveMaximumRssBytes) {
      throw attachBudgetMissMeasurements(
        fixedError("accounting_transition_rss_limit_exceeded"),
        {
          baselineRssBytes: baselineRss,
          observedRssBytes: currentRss,
          ceilingRssBytes: effectiveMaximumRssBytes,
        },
      );
    }
    // Allocation reservations are not measured RSS: fail before allocation
    // using the retained-memory budget code, never fabricate an RSS sample.
    if (additionalBytes > effectiveMaximumRssBytes - currentRss) {
      throw fixedError("accounting_transition_memory_budget_exceeded");
    }
  };
  checkRuntimeMemory();
  // The deep-scan guard reuses the shared, frozen export resource policy, whose
  // compatibility-bound candidate ceiling caps maximumRssBytes at 1.5 GiB. The
  // accounting build's authoritative ceiling is the effective target computed
  // above (checkRuntimeMemory), so pass the guard the LOWER of the two: it can
  // only tighten the transition-path target, never contradict it. Which side
  // wins depends on the baseline and is deliberately not assumed. Since the
  // 2026-08-20 raise the export policy's 1.5 GiB is the lower one for every
  // baseline under 1.5 GiB — a clean rebuild baseline included — so
  // the scan phase is now clamped by the export policy while the transition
  // path runs at the full ~5.31 GiB effective ceiling. That asymmetry is
  // intentional rather than overlooked: every observed deferral, build 1020's
  // included, was on the transition path, and a scan-phase trip is likewise a
  // soft budget miss (accounting_scan_rss_limit_exceeded) that retains and
  // serves the prior cache rather than failing the refresh. In practice the
  // heavy growth is the post-scan transition mining that checkRuntimeMemory
  // polices at the full effective target, while the scan phase stays within
  // either bound.
  const scanResourceGuardMaximumRssBytes = Math.min(
    effectiveMaximumRssBytes,
    DEFAULT_EXPORT_RESOURCE_LIMITS.maximumRssBytes,
  );
  const scanResourceGuard = createExportResourceGuard({
    limits: { maximumRssBytes: scanResourceGuardMaximumRssBytes },
    clock: now,
    rss,
  });
  const limits = transitionResourceLimits(
    requestedTransitionResourceLimits,
  );
  throwIfAborted(signal);
  throwIfAborted(signal);
  const startMs = endMs - windowDays * 24 * 60 * 60 * 1_000;
  const starts = {
    "24h": endMs - 24 * 60 * 60 * 1_000,
    "7d": endMs - 7 * 24 * 60 * 60 * 1_000,
    "30d": endMs - 30 * 24 * 60 * 60 * 1_000,
    all: startMs,
  };
  const periods = new Map([
    ["24h", newPeriod("24h", "Last 24 hours")],
    ["7d", newPeriod("7d", "Last 7 days")],
    ["30d", newPeriod("30d", "Last 30 days")],
    ["all", newPeriod("all", `Cached ${windowDays}-day window`)],
  ]);
  const timeline = new Map();
  const sparkTimeline = new Map();
  const weeklyQuotaTimelineBuckets = new Map();
  const sparkQuotaTimelineBuckets = new Map();
  const weeklyPaceSnapshots = [];
  const price = createAccountingPricer();
  // The scan retains no transition inputs: the full-history calibration corpus
  // is streamed from calibrationSource after the scan. This counter preserves
  // the periodic RSS check cadence over the scanned rows.
  let scannedRows = 0;
  const observeScannedRow = () => {
    scannedRows += 1;
    if (scannedRows % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      checkRuntimeMemory();
    }
  };
  // Unified authority: the full-history period total is folded in the SAME
  // physical read as the windowed scan. A unified reader that supports the
  // fused read delivers every usage row of the generation's covered range to
  // this consumer (rows inside the window arrive after the windowed consumer
  // has projected them, so the projection is shared); a scanner that does
  // not report `indexedHistory` falls back to the separate full-history read
  // below. The accumulation mirrors buildReplaySafeAccountingPeriod exactly,
  // metered at the same ceiling with the archive's HARD failure policy.
  const historyPeriod = newPeriod("history", "Indexed history");
  let historyAcceptedEvents = 0;
  let historyStarted = false;
  const checkHistoryRuntimeMemory = () => {
    const currentRss = rss();
    if (!Number.isSafeInteger(currentRss) || currentRss < 0) {
      throw fixedError("accounting_archive_rss_measurement_invalid");
    }
    if (currentRss > effectiveMaximumRssBytes) {
      throw fixedError("accounting_archive_rss_limit_exceeded");
    }
  };
  const historyOnUsage = (rawEvent) => {
    throwIfAborted(signal);
    if (!historyStarted) {
      checkHistoryRuntimeMemory();
      historyStarted = true;
    }
    const observedAt = canonicalInstant(rawEvent?.timestamp);
    if (observedAt === null) return;
    let event = rawEvent[PROJECTED_EVENT];
    if (event === undefined) {
      event = eventProjection(rawEvent, price);
      if (event === null) return;
      const observedMs = Date.parse(observedAt);
      event.declaredSpeed = event.speed === "unknown"
        ? declaredSpeedModeAt(baselines, observedMs) ?? "unknown"
        : "unknown";
    }
    addEvent(historyPeriod, event);
    historyAcceptedEvents += 1;
    if (historyAcceptedEvents % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
      checkHistoryRuntimeMemory();
    }
  };
  let scanned;
  let unifiedCoverage = null;
  try {
    const scanOptions = {
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      codexHome,
      resourceGuard: scanResourceGuard,
      signal,
      indexedHistory: { onUsage: historyOnUsage, onUsageGroup: historyOnUsage },
      usageBoundaryMs: Object.values(starts),
      declaredSpeedBaselines: baselines,
        unknownSpeedPolicy,
      onUsage: (rawEvent) => {
        throwIfAborted(signal);
        const observedAt = canonicalInstant(rawEvent?.timestamp);
        if (observedAt === null) return;
        const observedMs = Date.parse(observedAt);
        if (observedMs < startMs || observedMs > endMs + 5 * 60_000) return;
        const event = eventProjection(rawEvent, price);
        if (event === null) return;
        // An observed tier always wins, so a declaration is only ever looked
        // up for the turns the rollout log left unobserved.
        event.declaredSpeed = event.speed === "unknown"
          ? declaredSpeedModeAt(baselines, observedMs) ?? "unknown"
          : "unknown";
        if (Object.isExtensible(rawEvent)) {
          Object.defineProperty(rawEvent, PROJECTED_EVENT, {
            value: event,
            enumerable: false,
            configurable: true,
          });
        }
        observeScannedRow();
        if (event.isSpark) {
          for (const [id, period] of periods) {
            if (observedMs >= starts[id]) addEvent(period, event);
          }
          addTimelineEvent(sparkTimeline, event);
          return;
        }
        for (const [id, period] of periods) {
          if (observedMs >= starts[id]) addEvent(period, event);
        }
        addTimelineEvent(timeline, event);
      },
      onRateLimitSnapshot: (snapshot) => {
        throwIfAborted(signal);
        const window = snapshot?.window;
        const observedAt = canonicalInstant(snapshot?.timestamp);
        const observedMs = observedAt === null
          ? Number.NaN
          : Date.parse(observedAt);
        if (!Number.isFinite(observedMs)
            || observedMs < startMs
            || observedMs > endMs) return;
        // Rows keep the observed limit id: consumers filter the series with
        // SPARK_QUOTA_LIMIT_IDS.includes(row.limitId), same as the unified
        // and collector paths.
        if (SPARK_QUOTA_LIMIT_IDS.includes(window?.limitId)
            && window.provider === "openai_codex"
            && isValidQuotaWindowDuration(window.windowDurationMins)) {
          observeScannedRow();
          retainQuotaTimeline(
            sparkQuotaTimelineBuckets,
            snapshot,
            { limitId: window.limitId, durationMinutes: null },
          );
          return;
        }
        if (window?.limitId === "codex"
            && ALLOWANCE_HISTORY_WINDOW_MINUTES.has(
              window.windowDurationMins,
            )) {
          observeScannedRow();
          // The existing quota timeline and pace forecast remain seven-day
          // contracts. Five-hour rows feed only the duration-keyed history.
          if (window.windowDurationMins === WEEKLY_WINDOW_MINUTES) {
            retainQuotaTimeline(
              weeklyQuotaTimelineBuckets,
              snapshot,
              { limitId: "codex", durationMinutes: WEEKLY_WINDOW_MINUTES },
            );
            const paceSnapshot = weeklyPaceSnapshotProjection(snapshot);
            if (paceSnapshot !== null) weeklyPaceSnapshots.push(paceSnapshot);
          }
        }
      },
    };
    scanOptions.onUsageGroup = scanOptions.onUsage;
    scanned = await timing.measure("accounting_scan", () => scan(scanOptions));
    unifiedCoverage = normalizeUnifiedCoverage(scanned, expectedGeneration);
  } catch (error) {
    const bounded = accountingScanResourceError(error);
    if (bounded !== null) throw bounded;
    if (error?.name === "AbortError"
        || error?.code === "accounting_refresh_aborted") {
      throw fixedError("accounting_refresh_aborted", "AbortError");
    }
    throw mapUnifiedReaderError(error) ?? error;
  }
  throwIfAborted(signal);
  // Do not let the subsequent windowed/transition check convert an archive
  // end-of-pass overflow into a soft, indefinitely deferred accounting miss.
  if (scanned?.indexedHistory?.status === "available") checkHistoryRuntimeMemory();
  checkRuntimeMemory();
  let history = historyUnavailable(
    "accounting_unified_history_unavailable",
    unifiedCoverage?.coveredAt ?? null,
    unifiedCoverage?.generation ?? null,
    unifiedCoverage?.generationFingerprint ?? null,
  );
  if (unifiedCoverage !== null) {
    const fusedHistory = scanned?.indexedHistory;
    let historyScanned = null;
    const historyScan = async (scanOptions) => {
      historyScanned = await scan(scanOptions);
      return historyScanned;
    };
    try {
      let historyValue;
      if (fusedHistory !== undefined) {
        // The reader proved the covered range in the fused read; an
        // unavailable outcome carries the same reader code a separate read
        // of that range would have thrown, and takes the same path below.
        if (fusedHistory?.status !== "available") {
          throw fixedError(
            typeof fusedHistory?.errorCode === "string"
              ? fusedHistory.errorCode
              : "local_unified_index_read_failed",
          );
        }
        historyScanned = {
          ...scanned,
          coverage: fusedHistory.coverage,
          capabilities: fusedHistory.capabilities,
          diagnosticsAvailable: fusedHistory.diagnosticsAvailable,
        };
        historyValue = {
          generatedAt: unifiedCoverage.coveredAt.endAt,
          coveredAt: {
            startAt: unifiedCoverage.coveredAt.startAt,
            endAt: unifiedCoverage.coveredAt.endAt,
          },
          priceEpochBasis: HISTORICAL_PRICE_EPOCH_BASIS,
          priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
          priceRegistryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
          period: finalizePeriod(historyPeriod),
        };
      } else {
        historyValue = await buildReplaySafeAccountingPeriod({
          id: "history",
          label: "Indexed history",
          startAt: unifiedCoverage.coveredAt.startAt,
          endAt: unifiedCoverage.coveredAt.endAt,
          scan: historyScan,
          signal,
          declaredSpeedBaselines: baselines,
        unknownSpeedPolicy,
          rss,
          maximumRssBytes: effectiveMaximumRssBytes,
        });
      }
      const historyCoverage = normalizeUnifiedCoverage(
        historyScanned,
        expectedGeneration,
      );
      if (historyCoverage.generation !== unifiedCoverage.generation
          || historyCoverage.generationFingerprint
            !== unifiedCoverage.generationFingerprint
          || historyCoverage.coveredAt.startAt
            !== unifiedCoverage.coveredAt.startAt
          || historyCoverage.coveredAt.endAt
            !== unifiedCoverage.coveredAt.endAt) {
        throw fixedError("accounting_unified_generation_mismatch");
      }
      history = historyProjection(
        historyValue,
        historyCoverage,
        historyCoverage.generation,
        historyCoverage.generationFingerprint,
      );
    } catch (error) {
      if (error?.name === "AbortError"
          || error?.code === "accounting_refresh_aborted") {
        throw fixedError("accounting_refresh_aborted", "AbortError");
      }
      const mapped = mapUnifiedReaderError(error) ?? error;
      if (mapped?.code === "accounting_unified_generation_mismatch"
          || mapped?.name === "AbortError"
          || isAccountingBudgetMiss(mapped)
          || mapped?.code === "accounting_archive_rss_limit_exceeded"
          || (typeof mapped?.code === "string"
            && !mapped.code.startsWith("accounting_unified_"))) {
        throw mapped;
      }
      history = historyUnavailable(
        mapped?.code ?? "accounting_unified_history_unavailable",
        unifiedCoverage.coveredAt,
        unifiedCoverage.generation,
        unifiedCoverage.generationFingerprint,
      );
    }
  }
  // The full-history calibration corpus. Without it the only honest outputs
  // are a typed failure or a calibration falsely labelled complete-but-empty;
  // fail closed, and the next refresh reopens it from scratch.
  const calibrationCorpus = await timing.measure("accounting_corpus_open", () => calibrationSource.open({
    onTiming, monotonicClock,
    endMs,
    limits,
    declaredSpeedBaselines: baselines,
        unknownSpeedPolicy,
    signal,
    checkRuntimeMemory,
    expectedGeneration: unifiedCoverage?.generation ?? null,
  }));
  if (calibrationCorpus === null) {
    throw fixedError("accounting_calibration_corpus_unavailable");
  }
  let composition = null;
  let planScopedTimelineDraft = null;
  let historicalPlanDrafts = [];
  let compositionFitFailure = null;
  let transitionSeries;
  let weeklyApiIntervals = unavailableWeeklyApiIntervals();
  const retainedUsageEvents = calibrationCorpus.retainedUsageEvents;
  const retainedWeeklySnapshots = calibrationCorpus.weeklyRateLimitSnapshots.length;
  const calibrationRetainedBytes = calibrationCorpus.usageMetadataBytes
    + retainedWeeklySnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES;
  const calibrationCoveredAt = {
    startAt: calibrationCorpus.coveredAt.startAt,
    endAt: new Date(endMs).toISOString(),
  };
  const calibrationAttribution = calibrationCorpus.planAttribution;
    if (!Array.isArray(calibrationAttribution.summary.planTypes)
        || calibrationAttribution.summary.planTypes.length > 16) {
      throw fixedError("accounting_transition_derivation_limit_exceeded");
    }
  try {
    // The composition fit reads the same compact corpus the derivation below
    // will consume, so it must run first. It is strictly optional enrichment:
    // any throw out of it (resource ceiling, abort, numerical surprise) must
    // not cost the whole build. The cache completes with `composition: null` —
    // the dashboard then falls back to the across-reset median headline — and
    // the failure is recorded on the calibration block, because a refresh that
    // dies here re-runs the same doomed pass on every scheduler tick while the
    // on-disk cache stays a rejected older artifact.
    try {
      const fits = await timing.measure("accounting_fit", () => fitPlanCompositionsFromCorpus({
        onTiming, monotonicClock,
        forEachUsageRow: calibrationCorpus.forEachRetainedUsage,
        weeklyRateLimitSnapshots: calibrationCorpus.weeklyRateLimitSnapshots,
        endMs,
        signal,
        checkRuntimeMemory,
        planAttributionIndex: calibrationAttribution.index,
        declaredSpeedBaselines: baselines,
        unknownSpeedPolicy,
      }, calibrationAttribution.summary.planTypes, calibrationAttribution.summary.latestPlanType));
      historicalPlanDrafts = fits.historicalPlanDrafts;
      compositionFitFailure = fits.compositionFitFailure;
      if (fits.compositionResult !== null) {
        ({ planScopedTimeline: planScopedTimelineDraft, ...composition } = fits.compositionResult);
      }
    } catch (error) {
      compositionFitFailure = {
        status: "fit_failed",
        reason: compositionFitFailureReason(error),
      };
    }
    throwIfAborted(signal);
    checkRuntimeMemory();
    // Transition derivation consumes and releases the snapshot array. Project
    // exact intervals before that ownership transfer, not from an emptied list.
    if (selectedSourceMode === "unified") {
      try {
        await timing.measure("accounting_weekly_origins", () => calibrationCorpus.loadWeeklyApiOrigins?.(codexHome));
        weeklyApiIntervals = await timing.measure("accounting_weekly_intervals", () => buildWeeklyApiIntervals({ corpus: calibrationCorpus, endMs,
          generation: unifiedCoverage?.generation, fingerprint: unifiedCoverage?.generationFingerprint, signal }));
      } catch (error) {
        throwIfAborted(signal);
        if (error?.name === "AbortError") throw error;
        weeklyApiIntervals = unavailableWeeklyApiIntervals(
          /^weekly_api_[a-z_]{1,64}$/.test(error?.code ?? "") ? error.code : "weekly_api_projection_failed");
      }
    }
    try {
      transitionSeries = await timing.measure("accounting_transitions", () => deriveBoundedWeeklyCalibrationSeries({
        startAt: calibrationCoveredAt.startAt,
        endAt: calibrationCoveredAt.endAt,
        usageCorpus: {
          count: calibrationCorpus.retainedUsageEvents,
          usageMs: calibrationCorpus.usageMs,
          readSlice: calibrationCorpus.readUsageSlice,
        },
        rateLimitSnapshots: calibrationCorpus.weeklyRateLimitSnapshots,
        // The calibration corpus was fork-replay-suppressed at ingest, so its
        // transitions do not restate scan-level counts as their own.
        diagnostics: {},
        signal,
        resourceCheck: checkRuntimeMemory,
        planAttributionIndex: calibrationAttribution.index,
        limits,
      }));
    } catch (error) {
      if (error?.name === "AbortError"
          || error?.code === "transition_derivation_aborted") {
        const aborted = fixedError("accounting_refresh_aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      if ([
        "transition_derivation_input_limit_exceeded",
        "transition_derivation_row_limit_exceeded",
        "transition_derivation_work_limit_exceeded",
      ].includes(error?.code)) {
        throw fixedError("accounting_transition_derivation_limit_exceeded");
      }
      throw error;
    }
    // The streamed corpus is fully consumed; re-verify that the index the
    // slices were read off is still the generation the build is bound to, and
    // release the read handle. The one-shot reader ran the same checks at its
    // end; streaming widens the window they cover, not their meaning.
    const corpusMetrics = calibrationCorpus.metrics();
    await timing.measure("accounting_corpus_finish", () => calibrationCorpus.finish());
    if (onCalibrationCorpusMetrics !== null) {
      onCalibrationCorpusMetrics(corpusMetrics);
    }
  } catch (error) {
    calibrationCorpus.dispose();
    throw error;
  }
  return timing.measureSync("accounting_finalize", () => {
  const weeklyCalibrationDataset = {
    attribution: calibrationAttribution.summary,
    parserVersion: PARSER_VERSION,
    scope: {
      startAt: calibrationCoveredAt.startAt,
      endAt: calibrationCoveredAt.endAt,
      snapshotIntervalsIncluded: false,
    },
    pricing: {
      basis: "standard_openai_api_prices_not_codex_subscription_credits",
    },
    summary: {
      deduplicatedRateLimitSnapshots:
        transitionSeries.deduplicatedSnapshotCount,
      deduplicatedRateLimitSnapshotsByWindow:
        transitionSeries.deduplicatedSnapshotCountByWindow,
    },
    transitions: transitionSeries.transitions,
  };
  const weeklyCalibration = projectBoundedWeeklyCalibrationSummary(
    weeklyCalibrationDataset,
    { composition, ...unknownSpeedCalibrationOptions(unknownSpeedPolicy) },
  );
  if (compositionFitFailure !== null) {
    // Additive v0.7 field, present only when the fit itself threw: a blank
    // composition caused by a failure must be distinguishable against a
    // corpus that simply never supported a fit — five hours of silent
    // refresh loops is what an unrecorded failure cost the last time.
    // (Comment deliberately avoids a quoted phrase after the keyword-like
    // word f-r-o-m: the release gate's ESM lexer reads that shape in
    // comments as an import specifier.)
    weeklyCalibration.compositionStatus = compositionFitFailure;
  }
  const allowanceCapacityDataset = {
    ...weeklyCalibrationDataset,
    pricing: {
      basis: "quota_weighted_api_equivalent_by_unresolved_speed_scenario",
    },
  };
  const selectedScenario = unknownSpeedScenario(unknownSpeedPolicy);
  const calibrationOptions = unknownSpeedCalibrationOptions(unknownSpeedPolicy);
  const allowanceScenarios = {
    [selectedScenario]: {
      basis: codexPrimaryAllowanceBasis(selectedScenario, unknownSpeedPolicy),
      calibration: projectBoundedWeeklyCalibrationSummary(allowanceCapacityDataset, calibrationOptions),
    },
  };
  const selectedAllowanceCalibration = allowanceScenarios[selectedScenario].calibration;
  const fiveHourAllowanceCalibration = projectBoundedWeeklyCalibrationSummary(
    allowanceCapacityDataset, { ...calibrationOptions, windowDurationMinutes: FIVE_HOUR_WINDOW_MINUTES },
  );
  const capacityPlanScope = {
    methodVersion: PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION,
    basisId: allowanceScenarios[selectedScenario].basis.basisId,
    planType: selectedAllowanceCalibration.selectedPlanType,
    basisFamilyId:
      allowanceScenarios[selectedScenario].basis.basisFamilyId,
    cohortId: calibrationCohortId(selectedAllowanceCalibration),
  };
  const allowanceCapacityByScenario = {
    schemaVersion: ALLOWANCE_CAPACITY_SCHEMA_VERSION,
    basisFamilyId:
      allowanceScenarios[selectedScenario].basis.basisFamilyId,
    planScope: capacityPlanScope,
    unknownSpeedPolicy,
    selectedScenario,
    scenarios: allowanceScenarios,
  };
  const planScopedTimeline = planScopedTimelineReceipt({
    draft: planScopedTimelineDraft,
    sourceMode: selectedSourceMode,
    generation: unifiedCoverage?.generation ?? null,
    generationFingerprint: unifiedCoverage?.generationFingerprint ?? null,
    capacityPlanScope,
  });
  const historicalPlanComparisons = historicalPlanComparisonReceipts(
    historicalPlanDrafts, allowanceCapacityByScenario, {
      sourceMode: selectedSourceMode, generation: unifiedCoverage?.generation ?? null,
      generationFingerprint: unifiedCoverage?.generationFingerprint ?? null,
    },
  );
  const paceForecast = projectWeeklyPaceForecast(weeklyPaceSnapshots, endMs);
  throwIfAborted(signal);
  const cache = {
    schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
    unknownSpeedPolicy,
    generatedAt: new Date(endMs).toISOString(),
    coveredAt: {
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
    },
    bucketMinutes: TIMELINE_BUCKET_MS / 60_000,
    accountingMethod:
      "lineage_aware_cumulative_snapshot_replay_exclusion",
    priceBasis: "official_api_price_equivalent_not_subscription_allowance",
    pricingMethodVersion: LOCAL_API_PRICING_METHOD_VERSION,
    priceEpochBasis: HISTORICAL_PRICE_EPOCH_BASIS,
    priceRegistryVersion: APP_PRICE_REGISTRY_MANIFEST.version,
    priceRegistryObservedAt: APP_PRICE_REGISTRY_MANIFEST.observedAt,
    sourceDescriptor: sourceDescriptor({
      mode: selectedSourceMode,
      contextBehavior: selectedContextBehavior,
      scanned,
      coverage: unifiedCoverage?.coverage ?? null,
      generation: unifiedCoverage?.generation ?? null,
      generationMatched: expectedGeneration !== null
        && expectedGeneration !== undefined,
    }),
    history,
    periods: [...periods.values()].map(finalizePeriod),
    timeline: finalizeTimeline(timeline),
    planScopedTimeline,
    historicalPlanComparisons,
    weeklyApiIntervals,
    sparkUsageTimeline: finalizeTimeline(sparkTimeline),
    quotaTimeline: finalizeWeeklyQuotaTimeline(
      weeklyQuotaTimelineBuckets,
    ),
    sparkQuotaTimeline: finalizeWeeklyQuotaTimeline(
      sparkQuotaTimelineBuckets,
    ),
    ...(paceForecast === null
      ? {}
      : { weekly: { paceForecast } }),
    weeklyCalibration,
    allowanceCapacityByScenario,
    fiveHourAllowanceCalibration,
    weeklyCalibrationInput: {
      status: "complete",
      encoding: "accounting_streamed_v1",
      usageMetadataCapacity: calibrationCorpus.usageMetadataCapacity,
      usageMetadataBytes: calibrationCorpus.usageMetadataBytes,
      // Which corpus fed the calibration: the whole indexed history.
      // `coveredAt` states the span that corpus actually reaches.
      source: "unified_index",
      coveredAt: calibrationCoveredAt,
      retainedUsageEvents,
      retainedWeeklySnapshots,
      estimatedRetainedBytes: calibrationRetainedBytes,
      limits,
    },
    diagnostics: publicDiagnostics(scanned?.diagnostics),
  };
  if (cache.planScopedTimeline.status === "available"
      && Buffer.byteLength(serializeLocalCollectorAccountingCache(cache)) > MAX_CACHE_BYTES) {
    cache.planScopedTimeline = unavailablePlanTimeline("plan_scoped_resource_limit");
  }
  return cache;
  });
}

/** Re-evaluate only moving windows from a proven historical result.
 * generatedAt and all historical calculation clocks remain unchanged;
 * coveredAt is the window evaluation boundary, not a claim of new evidence.
 */
export async function projectReplaySafeAccountingTime({ cache, scan, calibrationSource,
  expectedGeneration, now = () => Date.now(), declaredSpeedBaselines = [], signal = null,
  windowDays = 365, onTiming = null, monotonicClock = undefined,
  rss = () => process.memoryUsage().rss, maximumRssBytes = MAX_ACCOUNTING_RSS_BYTES,
} = {}) {
  assertReplaySafeAccountingCache(cache);
  const endMs = now(), previousEnd = Date.parse(cache.coveredAt.endAt);
  if (!Number.isSafeInteger(endMs) || endMs < previousEnd
      || !Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > MAXIMUM_WINDOW_DAYS) {
    throw fixedError("accounting_time_projection_invalid");
  }
  if (endMs === previousEnd) return structuredClone(cache);
  const baselineRss = rss();
  if (!Number.isSafeInteger(baselineRss) || baselineRss < 0
      || !Number.isSafeInteger(maximumRssBytes) || maximumRssBytes < 1) {
    throw fixedError("accounting_transition_rss_measurement_invalid");
  }
  const ceiling = Math.min(maximumRssBytes, baselineRss + ACCOUNTING_RSS_DELTA_BUDGET_BYTES);
  const checkRuntimeMemory = (additionalBytes = 0) => {
    const current = rss();
    if (!Number.isSafeInteger(current) || current < 0) throw fixedError("accounting_transition_rss_measurement_invalid");
    if (current > ceiling) throw fixedError("accounting_transition_rss_limit_exceeded");
    if (additionalBytes > ceiling - current) throw fixedError("accounting_transition_memory_budget_exceeded");
  };
  checkRuntimeMemory();
  const result = structuredClone(cache);
  const startMs = endMs - windowDays * 86_400_000;
  const starts = { "24h": endMs - 86_400_000, "7d": endMs - 7 * 86_400_000,
    "30d": endMs - 30 * 86_400_000, all: startMs };
  const periods = new Map(cache.periods.map(period => [period.id, newPeriod(period.id, period.label)]));
  const timeline = new Map(), sparkTimeline = new Map(), quota = new Map(), sparkQuota = new Map();
  const pace = [], price = createAccountingPricer();
  let processed = 0;
  const onUsage = raw => {
    throwIfAborted(signal);
    if (++processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) checkRuntimeMemory();
    const observedMs = Date.parse(raw?.timestamp);
    if (!Number.isFinite(observedMs) || observedMs < startMs || observedMs > endMs) return;
    const event = eventProjection(raw, price);
    if (event === null) return;
    event.declaredSpeed = event.speed === "unknown"
      ? declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown" : "unknown";
    for (const [id, period] of periods) if (observedMs >= starts[id]) addEvent(period, event);
    addTimelineEvent(event.isSpark ? sparkTimeline : timeline, event);
  };
  const scanned = await scan({ startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(),
    usageBoundaryMs: Object.values(starts), declaredSpeedBaselines, signal,
    onUsage, onUsageGroup: onUsage, onRateLimitSnapshot: snapshot => {
      throwIfAborted(signal);
      if (++processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) checkRuntimeMemory();
      const at = Date.parse(snapshot?.timestamp), window = snapshot?.window;
      if (!Number.isFinite(at) || at < startMs || at > endMs) return;
      if (SPARK_QUOTA_LIMIT_IDS.includes(window?.limitId) && window.provider === "openai_codex"
          && isValidQuotaWindowDuration(window.windowDurationMins)) {
        retainQuotaTimeline(sparkQuota, snapshot, { limitId: window.limitId, durationMinutes: null });
      } else if (window?.limitId === "codex" && window.windowDurationMins === WEEKLY_WINDOW_MINUTES) {
        retainQuotaTimeline(quota, snapshot, { limitId: "codex", durationMinutes: WEEKLY_WINDOW_MINUTES });
        const projected = weeklyPaceSnapshotProjection(snapshot);
        if (projected !== null) pace.push(projected);
      }
    },
  });
  const coverage = normalizeUnifiedCoverage(scanned, expectedGeneration);
  if (String(coverage.generation) !== String(cache.sourceDescriptor.generation)
      || coverage.generationFingerprint !== cache.sourceDescriptor.generationFingerprint) {
    throw fixedError("accounting_unified_generation_mismatch");
  }
  result.periods = [...periods.values()].map(finalizePeriod);
  result.timeline = finalizeTimeline(timeline);
  result.sparkUsageTimeline = finalizeTimeline(sparkTimeline);
  result.quotaTimeline = finalizeWeeklyQuotaTimeline(quota);
  result.sparkQuotaTimeline = finalizeWeeklyQuotaTimeline(sparkQuota);
  result.coveredAt = { startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString() };
  const forecast = projectWeeklyPaceForecast(pace, endMs);
  if (forecast === null) delete result.weekly;
  else result.weekly = { paceForecast: forecast };

  // Read attribution evidence once and project only the recent usage range.
  // No fit, transition derivation, weekly interval rebuild or origin reads.
  const corpus = await calibrationSource.open({ expectedGeneration: coverage.generation, endMs,
    limits: transitionResourceLimits(null), declaredSpeedBaselines, signal, checkRuntimeMemory, onTiming, monotonicClock });
  if (corpus === null) throw fixedError("accounting_calibration_corpus_unavailable");
  try {
    const compositions = [];
    const summaries = [result.weeklyCalibration, result.fiveHourAllowanceCalibration,
      ...Object.values(result.allowanceCapacityByScenario.scenarios).map(row => row.calibration),
      ...result.historicalPlanComparisons.flatMap(row => Object.values(row.allowanceCapacityByScenario?.scenarios ?? {}).map(scenario => scenario.calibration))];
    for (const summary of summaries) {
      if (summary?.composition) compositions.push(summary.composition);
      for (const population of summary?.planPopulations ?? []) if (population.composition) compositions.push(population.composition);
    }
    const plans = new Map();
    for (const composition of compositions) if (composition.status === "fitted") {
      if (!plans.has(composition.planType)) plans.set(composition.planType, { bins: new Map(), invalid: new Set() });
    }
    const recentStart = endMs - COMPOSITION_RECENT_MIX_DAYS * 86_400_000;
    const binStart = Math.floor(recentStart / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs;
    let low = 0, high = corpus.retainedUsageEvents;
    while (low < high) { const mid = (low + high) >>> 1; if (corpus.usageMs[mid] < binStart) low = mid + 1; else high = mid; }
    for (let from = low; from < corpus.retainedUsageEvents; from += UNIFIED_CALIBRATION_READ_BATCH_ROWS) {
      const rows = await corpus.readUsageSlice(from, Math.min(from + UNIFIED_CALIBRATION_READ_BATCH_ROWS, corpus.retainedUsageEvents));
      for (const row of rows) {
        const at = Date.parse(row[0]), bin = Math.floor(at / MODEL_COMPOSITION_POLICY.grainMs) * MODEL_COMPOSITION_POLICY.grainMs;
        for (const [planType, state] of plans) {
          const intervalStartMs = Date.parse(row[20]?.[2] ?? "");
          const association = classifyUsageAttribution(corpus.planAttribution.index, {
            contextKey: planAttributionContextKey("openai_codex", "codex"), observedAtMs: at,
            ...(Number.isSafeInteger(intervalStartMs) ? { intervalStartMs } : {}),
            observedPlanType: row[20]?.[0] === "same_record" ? row[20][1] : null,
          }, { planType });
          if (association.disposition === "incompatible") continue;
          if (association.disposition === "unresolved" || row[20]?.[0] === "conflicted") { state.invalid.add(bin); continue; }
          if (at < recentStart) continue;
          const costs = state.bins.get(bin) ?? new Map();
          costs.set(row[1], (costs.get(row[1]) ?? 0) + Number(row[10])); state.bins.set(bin, costs);
        }
      }
    }
    for (const composition of compositions) {
      const mix = {}, state = plans.get(composition.planType);
      for (const [bin, costs] of state?.bins ?? []) {
        const lookup = planEraForInterval(corpus.planAttribution.index, {
          contextKey: planAttributionContextKey("openai_codex", "codex"),
          intervalStartMs: bin, observedAtMs: bin + MODEL_COMPOSITION_POLICY.grainMs - 1,
        });
        if (state.invalid.has(bin) || lookup.status !== "matched" || lookup.era.planType !== composition.planType) continue;
        for (const [model, cost] of costs) mix[model] = (mix[model] ?? 0) + cost;
      }
      const blended = composition.status === "fitted" ? blendedCompositionCapacityUsd(mix, {
        capacityUsdByModel: composition.capacityUsdByModel, fallbackCapacityUsd: composition.singleConstantUsd,
      }) : null;
      composition.blendedRecentMixUsd = Number.isFinite(blended) ? Number(blended.toFixed(2)) : null;
    }
    // Comparison geometry follows the proven plan eras, including quiet time.
    for (const receipt of [result.planScopedTimeline, ...result.historicalPlanComparisons.map(row => row.planScopedTimeline)]) {
      if (receipt.status !== "available") continue;
      const invalid = new Set();
      for (const [from, to, reason] of receipt.excludedIntervals) if (reason === "usage_attribution_unresolved") {
        for (let at = from; at < to; at += TIMELINE_BUCKET_MS) invalid.add(at);
      }
      const draft = finalizePlanScopedTimelineDraft({ unknownSpeedPolicy: cache.unknownSpeedPolicy,
        buckets: new Map(receipt.usage.map(row => { const value = decodePlanScopedTimelineRow(row); return [row[0], { ...value, startMs: row[0] }]; })),
        invalidBuckets: invalid, attributionIndex: corpus.planAttribution.index,
        contextKey: planAttributionContextKey("openai_codex", "codex"), planType: receipt.planScope.planType,
        diagnostics: receipt.diagnostics, endMs, resourceLimited: false, quota: receipt.observedQuota,
      });
      receipt.comparisonIntervals = draft.comparisonIntervals;
      receipt.excludedIntervals = draft.excludedIntervals;
      receipt.quota = draft.quota;
    }
  } finally { corpus.dispose(); }
  throwIfAborted(signal);
  checkRuntimeMemory();
  assertReplaySafeAccountingCache(result);
  return result;
}

export async function refreshReplaySafeAccountingCache({
  stateFile = null,
  // A JSON cache is no longer a supported durable target. Keeping this
  // explicit catch prevents a stale caller from silently writing SQLite bytes
  // to a misleading .json path.
  cacheFile = undefined,
  sourceMode = null,
  expectedGeneration = null,
  contextBehavior = null,
  // Optional, layer-local hook fired when a rebuild misses its memory budget
  // and is DEFERRED rather than failed. Receives only a bounded descriptor
  // ({ reason, retained }); its own errors never affect the refresh. The
  // deferred outcome is ALSO reported in the return value, and production wires
  // the diagnostics note off that (runner -> controller.onDegradedOutcome), so
  // this hook is a convenience for a caller that wants the signal inline
  // without inspecting the return shape.
  onAccountingRebuildDeferred = null,
  // Builds the cache in process in place of buildReplaySafeAccountingCache,
  // with the options that builder would have received (scan, calibrationSource,
  // windowDays, ...). The refresh around it — deferral on a budget miss,
  // validation, size ceiling, atomic publication — is unchanged.
  buildCache = null,
  ...options
} = {}) {
  if (cacheFile !== undefined) {
    throw new TypeError("cacheFile was retired; use stateFile");
  }
  if (onAccountingRebuildDeferred !== null
      && typeof onAccountingRebuildDeferred !== "function") {
    throw new TypeError("onAccountingRebuildDeferred must be a function or null");
  }
  if (buildCache !== null && typeof buildCache !== "function") {
    throw new TypeError("buildCache must be a function or null");
  }
  const selectedStateFile = stateFile ?? defaultReplaySafeAccountingCachePath();
  const timing = createLocalRefreshTimer({ onTiming: options.onTiming, clock: options.monotonicClock });
  const selectedSourceMode = normalizeAccountingSourceMode(sourceMode);
  const selectedContextBehavior = normalizeContextBehavior(contextBehavior);
  if (expectedGeneration !== null
      && expectedGeneration !== undefined
      && expectedGenerationTokens(expectedGeneration).length === 0) {
    throw new TypeError("expectedGeneration is invalid");
  }
  if (expectedGeneration === null || expectedGeneration === undefined) {
    throw fixedError("accounting_unified_generation_required");
  }
  if (typeof selectedStateFile !== "string" || selectedStateFile.length < 1) {
    throw new TypeError("Replay-safe SQLite state path is invalid");
  }
  // Converge legacy state before spending a potentially substantial index
  // read. A live old JSON collector or an unverified parity mismatch must
  // fail before we derive a cache that cannot be committed safely.
  await timing.measure("accounting_prepare_state", () => prepareLocalCollectorState({ stateFile: selectedStateFile }));
  let cache;
  try {
    cache = await (buildCache ?? buildReplaySafeAccountingCache)({
      ...options,
      sourceMode: selectedSourceMode,
      contextBehavior: selectedContextBehavior,
      expectedGeneration,
    });
  } catch (error) {
    // The rebuild missed its memory budget. Per owner directive the budget is
    // a TARGET, never a hard dashboard-blanker: the whole refresh must NOT
    // fail and the last good on-disk cache must survive untouched. Control
    // never reaches the write below, so the prior cache is retained verbatim;
    // the fuller rebuild is DEFERRED and the recent collector pass + quota
    // card that already ran stay authoritative. This mirrors the
    // composition-fit fail-soft (composition:null -> median fallback), widened
    // from one sub-artifact to the whole accounting artifact.
    if (!isAccountingBudgetMiss(error)) throw error;
    let retainedCache = null;
    try {
      const stored = await readReplaySafeAccountingCache({
        stateFile: selectedStateFile,
      });
      if (stored.status === "available") retainedCache = stored.cache;
    } catch {
      // A prior cache that cannot be read is treated as absent: the surface
      // then shows honest insufficient-evidence rather than a stale estimate,
      // and this read failure never turns the soft-fail back into a hard one.
      retainedCache = null;
    }
    // Carry the guard's own numbers when it recorded them. Without these the
    // deferral says only WHICH ceiling was crossed, never by how much or from
    // what baseline — and a miss that reports no quantities cannot be told
    // apart from any other explanation of itself.
    const measurements = error?.measurements ?? null;
    const deferred = Object.freeze({
      status: "accounting_rebuild_deferred",
      reason: error.code,
      retained: retainedCache !== null,
      generatedAt: retainedCache?.generatedAt ?? null,
      coveredAt: retainedCache?.coveredAt ?? null,
      measurements,
    });
    if (onAccountingRebuildDeferred !== null) {
      try {
        await onAccountingRebuildDeferred({
          reason: deferred.reason,
          retained: deferred.retained,
          measurements,
        });
      } catch {
        // The degraded-event trail must never affect the refresh outcome.
      }
    }
    return deferred;
  }
  // Validate the complete derived artifact before publication. The write is
  // atomic, but atomicity alone would preserve a newly-created invalid cache;
  // fail closed here so a bad build leaves the prior valid state untouched.
  timing.measureSync("accounting_validate", () => {
    assertReplaySafeAccountingCache(cache);
    if (Buffer.byteLength(serializeLocalCollectorAccountingCache(cache)) > MAX_CACHE_BYTES) throw fixedError("cache_invalid_size");
  });
  // A timeout/cancel can arrive after the build has returned a valid artifact
  // but before its atomic publication. Recheck at the final durable boundary
  // so a run already reported as stopped cannot replace the retained cache
  // behind that terminal state.
  throwIfAborted(options.signal ?? null);
  await timing.measure("accounting_publish", () => writeLocalCollectorAccountingCache({
    stateFile: selectedStateFile,
    cache,
    signal: options.signal ?? null,
  }));
  return cache;
}

function validWeeklyCalibrationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.status !== "complete"
      || !["accounting_compact_v3", "accounting_streamed_v1"].includes(value.encoding)
      || !["unified_index", "windowed_scan"].includes(value.source)
      || canonicalInstant(value.coveredAt?.startAt) === null
      || canonicalInstant(value.coveredAt?.endAt) === null
      || Date.parse(value.coveredAt.startAt)
        > Date.parse(value.coveredAt.endAt)
      || !Number.isSafeInteger(value.retainedUsageEvents)
      || value.retainedUsageEvents < 0
      || !Number.isSafeInteger(value.retainedWeeklySnapshots)
      || value.retainedWeeklySnapshots < 0
      || !Number.isSafeInteger(value.estimatedRetainedBytes)
      || value.estimatedRetainedBytes < 0
      || !value.limits
      || typeof value.limits !== "object"
      || Array.isArray(value.limits)) return false;
  let limits;
  try {
    limits = transitionResourceLimits(value.limits);
  } catch {
    return false;
  }
  if (value.encoding === "accounting_streamed_v1") {
    return value.source === "unified_index"
      && Number.isSafeInteger(value.usageMetadataCapacity)
      && value.usageMetadataCapacity >= value.retainedUsageEvents
      && Number.isSafeInteger(value.usageMetadataBytes)
      && value.usageMetadataBytes === value.usageMetadataCapacity * STREAMED_USAGE_STAMP_BYTES
        + value.retainedUsageEvents * STREAMED_USAGE_MEMO_BYTES
      && value.retainedWeeklySnapshots <= limits.weeklySnapshots
      && value.estimatedRetainedBytes === value.usageMetadataBytes
        + value.retainedWeeklySnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES
      && value.estimatedRetainedBytes <= limits.retainedBytes;
  }
  return value.retainedUsageEvents <= limits.usageEvents
    && value.retainedWeeklySnapshots <= limits.weeklySnapshots
    && value.retainedUsageEvents + value.retainedWeeklySnapshots
      <= limits.combinedInputs
    && value.estimatedRetainedBytes
      === value.retainedUsageEvents * COMPACT_USAGE_RETAINED_BYTES
        + value.retainedWeeklySnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES
    && value.estimatedRetainedBytes <= limits.retainedBytes;
}

function validQuotaTimeline(
  value,
  coveredAt,
  { limitIds = ["codex"], durationMinutes = WEEKLY_WINDOW_MINUTES } = {},
) {
  if (!Array.isArray(value) || value.length > MAX_QUOTA_TIMELINE_ROWS) {
    return false;
  }
  const expectedKeys = [
    "accountAttribution",
    "durationMinutes",
    "limitId",
    "observedAt",
    "planType",
    "remainingPercent",
    "resetAt",
    "slot",
    "usedPercent",
  ].sort().join("\0");
  const coverageStartMs = Date.parse(coveredAt.startAt);
  const coverageEndMs = Date.parse(coveredAt.endAt);
  const seenBuckets = new Set();
  let priorSortKey = null;
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row)
        || Object.keys(row).sort().join("\0") !== expectedKeys
        || canonicalInstant(row.observedAt) === null
        || canonicalInstant(row.resetAt) === null
        || !limitIds.includes(row.limitId)
        || !QUOTA_SLOTS.has(row.slot)
        || !(QUOTA_PLANS.has(row.planType) || row.planType === "unknown")
        || typeof row.usedPercent !== "number"
        || !Number.isFinite(row.usedPercent)
        || row.usedPercent < 0
        || row.usedPercent > 100
        || typeof row.remainingPercent !== "number"
        || !Number.isFinite(row.remainingPercent)
        || row.remainingPercent < 0
        || row.remainingPercent > 100
        || row.remainingPercent
          !== Number(Math.max(0, 100 - row.usedPercent).toFixed(3))
        || !isValidQuotaWindowDuration(row.durationMinutes)
        || (durationMinutes !== null && row.durationMinutes !== durationMinutes)
        || row.accountAttribution !== "historical_unattributed") {
      return false;
    }
    const observedMs = Date.parse(row.observedAt);
    if (observedMs < coverageStartMs || observedMs > coverageEndMs) {
      return false;
    }
    const bucketKey = quotaTimelineTrackBucketKey(row);
    if (seenBuckets.has(bucketKey)) return false;
    seenBuckets.add(bucketKey);
    // Percent is zero-padded so the string compare is numeric, matching the
    // writer's ascending numeric sort ("9.000" must not sort after "19.000").
    const sortKey = [
      row.observedAt,
      row.limitId,
      row.slot,
      row.resetAt,
      row.planType,
      row.usedPercent.toFixed(3).padStart(7, "0"),
    ].join("\0");
    if (priorSortKey !== null && sortKey < priorSortKey) return false;
    priorSortKey = sortKey;
  }
  return true;
}

function validRetainedPaceRate(rate) {
  return rate === null
    || (Number.isFinite(rate) && rate >= 0 && rate <= 100);
}

function validWeeklyPaceForecast(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== [
        "currentUsedPercent",
        "etaAt",
        "hoursToExhaustion",
        "hoursToReset",
        "pace",
        "remainingPercent",
        "resetsAt",
        "status",
      ].sort().join("\0")
      || !PACE_STATUSES.has(value.status)
      || !Number.isFinite(value.currentUsedPercent)
      || value.currentUsedPercent < 0
      || value.currentUsedPercent > 100
      || !Number.isFinite(value.remainingPercent)
      || value.remainingPercent < 0
      || value.remainingPercent > 100
      || value.remainingPercent
        !== Number(Math.max(0, 100 - value.currentUsedPercent).toFixed(3))
      || canonicalInstant(value.resetsAt) === null
      || !value.pace
      || typeof value.pace !== "object"
      || Array.isArray(value.pace)
      || Object.keys(value.pace).sort().join("\0")
        !== [
          "activePercentagePointsPerHour",
          "overallPercentagePointsPerHour",
        ].sort().join("\0")
      || !validRetainedPaceRate(value.pace.activePercentagePointsPerHour)
      || !validRetainedPaceRate(value.pace.overallPercentagePointsPerHour)
      || (value.etaAt !== null && canonicalInstant(value.etaAt) === null)
      || (value.hoursToExhaustion !== null
        && (!Number.isFinite(value.hoursToExhaustion)
          || value.hoursToExhaustion < 0))
      || (value.hoursToReset !== null
        && (!Number.isFinite(value.hoursToReset) || value.hoursToReset < 0))) {
    return false;
  }
  return true;
}

function validWeeklyPaceContainer(value) {
  return value !== undefined
    && value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, "paceForecast")
    && validWeeklyPaceForecast(value.paceForecast);
}

function validPriceCardProvenance(row) {
  if (!Array.isArray(row?.priceCardIds)
      || row.priceCardIds.length > 32
      || !row.priceCardIds.every((id) => (
        typeof id === "string" && id.length > 0 && id.length <= 128
      ))
      || !Array.isArray(row?.priceCardBreakdown)
      || row.priceCardBreakdown.length > 32) return false;
  if (typeof row.apiPriceEquivalentUsdExact !== "string"
      || !/^\d+(?:\.\d+)?$/u.test(row.apiPriceEquivalentUsdExact)) {
    return false;
  }
  const ids = row.priceCardIds;
  if (new Set(ids).size !== ids.length || [...ids].sort().some((id, index) => id !== ids[index])) {
    return false;
  }
  let priorId = null;
  let breakdownEvents = 0;
  let breakdownCost = "0";
  for (const item of row.priceCardBreakdown) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.priceCardId !== "string"
        || !ids.includes(item.priceCardId)
        || (priorId !== null && item.priceCardId <= priorId)
        || !Number.isSafeInteger(item.events)
        || item.events < 0
        || typeof item.costUsd !== "string"
        || !/^\d+(?:\.\d+)?$/u.test(item.costUsd)) return false;
    breakdownEvents += item.events;
    try {
      breakdownCost = addUsdStrings(breakdownCost, item.costUsd);
    } catch {
      return false;
    }
    priorId = item.priceCardId;
  }
  const coverage = row.pricingCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)
      || !Number.isSafeInteger(coverage.fullyPricedEvents)
      || !Number.isSafeInteger(coverage.partiallyPricedEvents)
      || !Number.isSafeInteger(coverage.unpricedEvents)
      || coverage.fullyPricedEvents < 0
      || coverage.partiallyPricedEvents < 0
      || coverage.unpricedEvents < 0
      || coverage.fullyPricedEvents
        + coverage.partiallyPricedEvents
        + coverage.unpricedEvents !== row.events
      || breakdownEvents !== coverage.fullyPricedEvents
        + coverage.partiallyPricedEvents
      || breakdownCost !== row.apiPriceEquivalentUsdExact) {
    return false;
  }
  const exactNumber = Number(row.apiPriceEquivalentUsdExact);
  const expectedRounded = roundedExactMoney(row.apiPriceEquivalentUsdExact);
  return Number.isFinite(exactNumber)
    && Number.isFinite(expectedRounded)
    && row.apiPriceEquivalentUsd === expectedRounded;
}

function validSourceDescriptor(value) {
  const expectedKeys = [
    "contextBehavior",
    "contractVersion",
    "coverageStatus",
    "coverage",
    "diagnosticsAvailable",
    "fallbackCount",
    "generation",
    "generationFingerprint",
    "generationMatched",
    "mode",
    "parserVersion",
    "readerVersion",
    "schemaVersion",
    "schemaVersionUsed",
    "capabilities",
  ].sort().join("\0");
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== expectedKeys
      || value.schemaVersion !== SOURCE_DESCRIPTOR_VERSION
      || !REPLAY_SAFE_ACCOUNTING_SOURCE_MODES.includes(value.mode)
      || !REPLAY_SAFE_ACCOUNTING_CONTEXT_BEHAVIORS.includes(
        value.contextBehavior,
      )) return false;
  const optionalText = [
    "contractVersion",
    "parserVersion",
    "readerVersion",
    "schemaVersionUsed",
  ];
  if (!optionalText.every((key) => (
    value[key] === null || boundedDescriptorText(value[key]) !== null
  ))) return false;
  if (!Number.isSafeInteger(value.fallbackCount)
      || value.fallbackCount < 0
      || typeof value.generationMatched !== "boolean") {
    return false;
  }
  if (value.mode === "unified") {
    if (value.fallbackCount !== 0
        || value.generationMatched !== true
        || generationToken(value.generationFingerprint) === null) {
      return false;
    }
    const coverage = value.coverage;
    const coverageKeys = [
      "admittedQuotaOccurrences",
      "blockReason",
      "coveredAt",
      "generatedAt",
      "generationProof",
      "quotaObservations",
      "quotaOccurrences",
      "sourceBytes",
      "sourceCount",
      "skippedSourceBytes",
      "skippedSourceCount",
      "skippedThreadCount",
      "status",
      "usageEvents",
    ].sort().join("\0");
    const capabilityKeys = [
      "crashSafeGenerationPublication",
      "deterministicCanonicalOrder",
      "durableDiagnostics",
      "readsRawSources",
      "sourceOffsetProvenance",
      "sourceOrderingProvenance",
      "sourceScopedQuotaOccurrences",
    ].sort().join("\0");
    const validCoveredAt = coverage?.coveredAt === null
      || (coverage?.coveredAt
        && canonicalInstant(coverage.coveredAt.startAt) !== null
        && canonicalInstant(coverage.coveredAt.endAt) !== null
        && Date.parse(coverage.coveredAt.startAt)
          <= Date.parse(coverage.coveredAt.endAt));
    const validCount = (candidate) => (
      candidate === null
      || (Number.isSafeInteger(candidate) && candidate >= 0)
    );
    const capabilities = value.capabilities;
    if (value.generationFingerprint !== null
        && boundedDescriptorText(value.generationFingerprint) === null) {
      return false;
    }
    const complete = value.coverageStatus === "complete"
      && coverage?.status === "complete"
      && coverage?.blockReason === null
      && coverage?.skippedSourceCount === 0
      && coverage?.skippedSourceBytes === 0
      && coverage?.skippedThreadCount === 0;
    const attestedGap = value.coverageStatus === "partial"
      && coverage?.status === "partial"
      && coverage?.blockReason === "codex_rollout_sources_quarantined"
      && Number.isSafeInteger(coverage?.skippedSourceCount)
      && coverage.skippedSourceCount > 0
      && Number.isSafeInteger(coverage?.skippedSourceBytes)
      && coverage.skippedSourceBytes >= 0
      && Number.isSafeInteger(coverage?.skippedThreadCount)
      && coverage.skippedThreadCount > 0;
    return (complete || attestedGap)
      && value.diagnosticsAvailable === true
      && value.generationMatched === true
      && coverage
      && typeof coverage === "object"
      && !Array.isArray(coverage)
      && Object.keys(coverage).sort().join("\0") === coverageKeys
      && (coverage.generatedAt === null
        || canonicalInstant(coverage.generatedAt) !== null)
      && validCoveredAt
      && [
        coverage.sourceCount,
        coverage.sourceBytes,
        coverage.skippedSourceCount,
        coverage.skippedSourceBytes,
        coverage.skippedThreadCount,
        coverage.usageEvents,
        coverage.quotaObservations,
        coverage.quotaOccurrences,
        coverage.admittedQuotaOccurrences,
      ].every(validCount)
      && coverage.generationProof === true
      && capabilities
      && typeof capabilities === "object"
      && !Array.isArray(capabilities)
      && Object.keys(capabilities).sort().join("\0") === capabilityKeys
      && capabilities.readsRawSources === false
      && capabilities.deterministicCanonicalOrder === true
      && capabilities.sourceOrderingProvenance === true
      && capabilities.sourceOffsetProvenance === true
      && capabilities.sourceScopedQuotaOccurrences === true
      && capabilities.durableDiagnostics === true
      && capabilities.crashSafeGenerationPublication === true
      && generationToken(value.generation) !== null;
  }
  return value.coverageStatus === null
    && value.generation === null
    && value.generationFingerprint === null
    && value.coverage === null
    && value.diagnosticsAvailable === null
    && value.generationMatched === false
    && value.capabilities === null;
}

function validHistoryPeriod(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.id === "history"
    && typeof value.label === "string"
    && value.label.length > 0
    && value.label.length <= 96
    && Number.isSafeInteger(value.events)
    && value.events >= 0
    && Number.isSafeInteger(value.totalTokens)
    && value.totalTokens >= 0
    && typeof value.apiPriceEquivalentUsd === "number"
    && Number.isFinite(value.apiPriceEquivalentUsd)
    && value.apiPriceEquivalentUsd >= 0
    && validPriceCardProvenance(value);
}

function validHistory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !["available", "unavailable"].includes(value.status)
      || (value.errorCode !== null
        && (typeof value.errorCode !== "string"
          || !/^[a-z][a-z0-9_.-]{0,95}$/u.test(value.errorCode)))
      || !value.coverage
      || typeof value.coverage !== "object"
      || Array.isArray(value.coverage)
      || !["complete", "partial", "unavailable"].includes(value.coverage.status)
      || (value.generation !== null
        && generationToken(value.generation) === null)
      || (value.generationFingerprint !== null
        && generationToken(value.generationFingerprint) === null)
      || value.coverage.generation !== value.generation
      || value.coverage.generationFingerprint
        !== value.generationFingerprint) return false;
  const coveredAt = value.coverage.coveredAt;
  if (!coveredAt || typeof coveredAt !== "object" || Array.isArray(coveredAt)) {
    return false;
  }
  const validCoveredAt = value.coverage.status === "unavailable"
    ? ((coveredAt.startAt === null && coveredAt.endAt === null)
      || (canonicalInstant(coveredAt.startAt) !== null
        && canonicalInstant(coveredAt.endAt) !== null
        && Date.parse(coveredAt.startAt) <= Date.parse(coveredAt.endAt)))
    : canonicalInstant(coveredAt.startAt) !== null
      && canonicalInstant(coveredAt.endAt) !== null
      && Date.parse(coveredAt.startAt) <= Date.parse(coveredAt.endAt)
      && canonicalInstant(value.coverage.generatedAt) !== null;
  if (!validCoveredAt) return false;
  if (value.status === "available") {
    return value.errorCode === null
      && ["complete", "partial"].includes(value.coverage.status)
      && value.generation !== null
      && validHistoryPeriod(value.period);
  }
  return value.errorCode !== null
    && value.period === null
    && value.coverage.status === "unavailable";
}

function speedWeightingTotals(value) {
  const shape = emptySpeedWeightingCrossing();
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((speed) => !Object.hasOwn(shape, speed))) {
    return null;
  }
  let events = 0;
  let apiPriceEquivalentUsd = 0;
  const bySpeed = {};
  for (const [speed, families] of Object.entries(shape)) {
    const selected = value[speed] ?? {};
    if (!selected || typeof selected !== "object" || Array.isArray(selected)
        || Object.keys(selected).some(
          (family) => !Object.hasOwn(families, family),
        )) return null;
    let speedEvents = 0;
    let speedUsd = 0;
    for (const family of Object.keys(families)) {
      const cell = selected[family];
      if (cell === undefined) continue;
      if (!cell || typeof cell !== "object" || Array.isArray(cell)
          || Object.keys(cell).sort().join(",")
            !== "apiPriceEquivalentUsd,events"
          || !Number.isSafeInteger(cell.events) || cell.events < 0
          || typeof cell.apiPriceEquivalentUsd !== "number"
          || !Number.isFinite(cell.apiPriceEquivalentUsd)
          || cell.apiPriceEquivalentUsd < 0) return null;
      speedEvents += cell.events;
      speedUsd += cell.apiPriceEquivalentUsd;
    }
    bySpeed[speed] = { events: speedEvents, usd: speedUsd };
    events += speedEvents;
    apiPriceEquivalentUsd += speedUsd;
  }
  return { events, apiPriceEquivalentUsd, bySpeed };
}

function validTimelineSpeedWeighting(row) {
  const observed = speedWeightingTotals(row?.speedWeighting);
  const declared = speedWeightingTotals(row?.declaredSpeedWeighting);
  if (observed === null || declared === null
      || observed.events !== row.usageEvents
      || Math.abs(observed.apiPriceEquivalentUsd - row.apiPriceEquivalentUsd)
        > 0.00002
      || declared.events > (observed.bySpeed.unknown?.events ?? 0)
      || declared.apiPriceEquivalentUsd
        > (observed.bySpeed.unknown?.usd ?? 0) + 0.00002) return false;
  return true;
}

function validAllowanceCalibrationSummary(
  value,
  forcedCandidateId,
  { windowDurationMinutes = SEVEN_DAY_WINDOW_MINUTES, customFastRatioBps = null } = {},
) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== "weekly-calibration-summary-v0.1"
      || value.windowDurationMinutes !== windowDurationMinutes
      || !["estimated", "insufficient_evidence"].includes(value.status)
      || canonicalInstant(value.generatedAt) === null
      || value.accountAttribution?.status !== "historical_unattributed"
      || value.accountAttribution?.maySpanMultipleAccounts !== true
      || value.validation?.selectedCostBasis !== forcedCandidateId
      || (forcedCandidateId === "speed_custom" && value.customFastRatioBps !== customFastRatioBps)
      || !Array.isArray(value.recentResets)
      || value.recentResets.length > BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT) {
    return false;
  }
  if (value.status === "insufficient_evidence") return value.estimate === null;
  const estimate = value.estimate;
  return estimate && typeof estimate === "object" && !Array.isArray(estimate)
    && Number.isSafeInteger(estimate.qualifyingResets)
    && estimate.qualifyingResets > 0
    && Number.isFinite(estimate.medianApiPriceEquivalentUsd)
    && estimate.medianApiPriceEquivalentUsd > 0
    && Number.isFinite(estimate.plausibleRangeUsd?.lower)
    && estimate.plausibleRangeUsd.lower > 0
    && Number.isFinite(estimate.plausibleRangeUsd?.upper)
    && estimate.plausibleRangeUsd.upper >= estimate.plausibleRangeUsd.lower;
}

function validAllowanceCapacityByScenario(value) {
  let selected;
  try { selected = unknownSpeedScenario(value?.unknownSpeedPolicy); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== ALLOWANCE_CAPACITY_SCHEMA_VERSION
      || value.planScope?.methodVersion
        !== PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION
      || typeof value.planScope?.planType !== "string"
      || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value.planScope.planType)
      || value.planScope.basisFamilyId !== value.basisFamilyId
      || value.planScope.basisId !== codexPrimaryAllowanceBasis(selected, value.unknownSpeedPolicy).basisId
      || !(value.planScope.cohortId === null
        || (typeof value.planScope.cohortId === "string"
          && /^[a-f0-9]{64}$/u.test(value.planScope.cohortId)))
      || !value.scenarios || typeof value.scenarios !== "object"
      || Array.isArray(value.scenarios)
      || Object.keys(value.scenarios).sort().join(",")
        !== selected || value.selectedScenario !== selected) {
    return false;
  }
  for (const [scenario, forcedCandidateId] of Object.entries(
    { [selected]: ALLOWANCE_SCENARIO_CANDIDATES[selected] },
  )) {
    const row = value.scenarios[scenario];
    if (selected === "unresolved_as_custom" && row?.calibration?.customFastRatioBps !== value.unknownSpeedPolicy.customFastRatioBps) return false;
    const expectedBasis = codexPrimaryAllowanceBasis(scenario, value.unknownSpeedPolicy);
    if (!row || typeof row !== "object" || Array.isArray(row)
        || stableJson(row.basis) !== stableJson(expectedBasis)
        || value.basisFamilyId !== expectedBasis.basisFamilyId
        || row.calibration?.selectedPlanType !== value.planScope.planType
        || !validAllowanceCalibrationSummary(
          row.calibration,
          forcedCandidateId,
          { customFastRatioBps: value.unknownSpeedPolicy.customFastRatioBps },
        ) || !validWeeklyPlanPopulations(row.calibration, (population) => (
          validAllowanceCalibrationSummary(population, forcedCandidateId, { customFastRatioBps: value.unknownSpeedPolicy.customFastRatioBps })
        ))) return false;
  }
  const selectedCalibration = value.scenarios[selected].calibration;
  return value.planScope.cohortId === calibrationCohortId(selectedCalibration);
}

function validFiveHourAllowanceCalibration(value, policy) {
  const selectedBasis =
    unknownSpeedCalibrationOptions(policy).forcedCandidateId;
  const options = { windowDurationMinutes: FIVE_HOUR_WINDOW_MINUTES, customFastRatioBps: policy.customFastRatioBps };
  if (policy.mode === "custom" && value?.customFastRatioBps !== policy.customFastRatioBps) return false;
  return validAllowanceCalibrationSummary(value, selectedBasis, options)
    && validWeeklyPlanPopulations(value, (population) => (
      validAllowanceCalibrationSummary(population, selectedBasis, options)
    ));
}

function validPlanScopedTimeline(value, sourceDescriptor, capacity) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== PLAN_SCOPED_TIMELINE_SCHEMA_VERSION
      || value.encoding !== PLAN_TIMELINE_ENCODING
      || !["available", "unavailable"].includes(value.status)
      || !Array.isArray(value.usage)
      || value.usage.length > MAX_PLAN_TIMELINE_ROWS
      || !Array.isArray(value.comparisonIntervals)
      || value.comparisonIntervals.length > MAX_PLAN_TIMELINE_ROWS
      || !Array.isArray(value.excludedIntervals) || value.excludedIntervals.length > MAX_PLAN_TIMELINE_ROWS
      || !Array.isArray(value.quota) || value.quota.length > MAX_PLAN_TIMELINE_ROWS
      || !Array.isArray(value.observedQuota) || value.observedQuota.length > MAX_PLAN_TIMELINE_ROWS
      || !value.diagnostics || typeof value.diagnostics !== "object"
      || Array.isArray(value.diagnostics)) return false;
  const diagnosticKeys = [
    "consideredEvents",
    "admittedEvents",
    "incompatibleEvents",
    "unresolvedEvents",
    "conflictedEvents",
    "malformedEvents",
    "invalidatedBuckets",
    "invalidatedCandidateEvents",
  ];
  if (!diagnosticKeys.every((key) => (
    Number.isSafeInteger(value.diagnostics[key])
      && value.diagnostics[key] >= 0
  ))) return false;
  if (value.status === "unavailable") {
    return value.planScope === null && value.usage.length === 0
      && value.comparisonIntervals.length === 0 && value.quota.length === 0 && value.observedQuota.length === 0 && value.excludedIntervals.length === 0
      && [
        "plan_scoped_generation_unavailable",
        "plan_scoped_attribution_unavailable",
        "plan_scoped_resource_limit",
      ].includes(value.reason);
  }
  const scope = value.planScope;
  if (value.reason !== null || !scope || typeof scope !== "object"
      || Array.isArray(scope)
      || scope.methodVersion !== PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION
      || typeof scope.planType !== "string"
      || !/^[a-z][a-z0-9_-]{0,31}$/u.test(scope.planType)
      || scope.basisFamilyId !== capacity?.basisFamilyId
      || scope.basisId !== capacity?.planScope?.basisId
      || scope.planType !== capacity?.planScope?.planType
      || scope.cohortId !== capacity?.planScope?.cohortId
      || scope.sourceGeneration !== sourceDescriptor?.generation
      || scope.sourceGenerationFingerprint
        !== sourceDescriptor?.generationFingerprint) return false;
  let admittedEvents = 0;
  let priorEndMs = Number.NEGATIVE_INFINITY;
  const observedQuotaByTime = new Map();
  for (const row of value.observedQuota) {
    if (!Array.isArray(row) || row.length !== 3
        || !row.every((n) => typeof n === "number" && Number.isFinite(n))
        || !Number.isSafeInteger(row[0]) || row[0] <= priorEndMs
        || !Number.isFinite(new Date(row[0]).getTime())
        || !Number.isFinite(new Date(row[1] * 1000).getTime())
        || row[2] < 0 || row[2] > 100) return false;
    observedQuotaByTime.set(row[0], row);
    priorEndMs = row[0];
  }
  priorEndMs = Number.NEGATIVE_INFINITY;
  for (const interval of value.comparisonIntervals) {
    if (!Array.isArray(interval) || interval.length !== 2
        || !interval.every((ms) => Number.isSafeInteger(ms)
          && ms % TIMELINE_BUCKET_MS === 0 && Number.isFinite(new Date(ms).getTime()))
        || interval[0] < priorEndMs || interval[1] <= interval[0]) return false;
    priorEndMs = interval[1];
  }
  priorEndMs = Number.NEGATIVE_INFINITY;
  let comparableAt = 0;
  for (const row of value.excludedIntervals) {
    if (!Array.isArray(row) || row.length !== 3
        || !row.slice(0, 2).every((ms) => Number.isSafeInteger(ms)
          && ms % TIMELINE_BUCKET_MS === 0 && Number.isFinite(new Date(ms).getTime()))
        || row[0] < priorEndMs || row[1] <= row[0]
        || !["plan_transition_interval", "usage_attribution_unresolved"].includes(row[2])) return false;
    while (comparableAt < value.comparisonIntervals.length && value.comparisonIntervals[comparableAt][1] <= row[0]) comparableAt += 1;
    if (value.comparisonIntervals[comparableAt]?.[0] < row[1]) return false;
    priorEndMs = row[1];
  }
  priorEndMs = Number.NEGATIVE_INFINITY;
  let quotaIntervalAt = 0;
  for (const row of value.quota) {
    if (!Array.isArray(row) || row.length !== 3
        || !row.every((n) => typeof n === "number" && Number.isFinite(n))
        || !Number.isSafeInteger(row[0]) || row[0] <= priorEndMs
        || !Number.isFinite(new Date(row[0]).getTime())
        || !Number.isFinite(new Date(row[1] * 1000).getTime())
        || row[2] < 0 || row[2] > 100) return false;
    while (quotaIntervalAt < value.comparisonIntervals.length
        && value.comparisonIntervals[quotaIntervalAt][1] <= row[0]) quotaIntervalAt += 1;
    const interval = value.comparisonIntervals[quotaIntervalAt];
    if (!interval || row[0] < interval[0] || row[0] >= interval[1]) return false;
    const observed = observedQuotaByTime.get(row[0]);
    if (!observed || observed[1] !== row[1] || observed[2] !== row[2]) return false;
    priorEndMs = row[0];
  }
  priorEndMs = Number.NEGATIVE_INFINITY;
  let intervalAt = 0;
  for (const compact of value.usage) {
    const row = decodePlanScopedTimelineRow(compact);
    if (row === null) return false;
    const startMs = Date.parse(row?.startAt ?? "");
    const endMs = Date.parse(row?.endAt ?? "");
    while (intervalAt < value.comparisonIntervals.length
        && value.comparisonIntervals[intervalAt][1] <= startMs) intervalAt += 1;
    const interval = value.comparisonIntervals[intervalAt];
    if (!interval || interval[0] > startMs || interval[1] < endMs) return false;
    const scenarios = row?.scenarioWeighting;
    const mixed = mixUnknownSpeedUsd(scenarios?.unresolved_as_standard, scenarios?.unresolved_as_fast, capacity.unknownSpeedPolicy);
    if (mixed === null || Math.abs(mixed - scenarios?.unresolved_as_custom) > 0.00002) return false;
    const coverage = row?.weightingCoverage;
    const pricing = row?.pricingCoverage;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)
        || endMs - startMs !== TIMELINE_BUCKET_MS
        || startMs < priorEndMs
        || !Number.isSafeInteger(row.usageEvents) || row.usageEvents < 1
        || !Number.isSafeInteger(row.totalTokens) || row.totalTokens < 0
        || !Number.isFinite(row.apiPriceEquivalentUsd)
        || row.apiPriceEquivalentUsd < 0
        || !scenarios || typeof scenarios !== "object"
        || Array.isArray(scenarios)
        || Object.keys(scenarios).sort().join(",")
          !== Object.keys(ALLOWANCE_SCENARIO_CANDIDATES).sort().join(",")
        || !Object.values(scenarios).every((amount) => (
          Number.isFinite(amount) && amount >= 0
        ))
        || !coverage || !["observedEvents", "declaredFromConfigEvents", "assumedEvents"]
          .every((key) => Number.isSafeInteger(coverage[key]) && coverage[key] >= 0)
        || coverage.observedEvents + coverage.declaredFromConfigEvents
          + coverage.assumedEvents !== row.usageEvents
        || !pricing || !["fullyPricedEvents", "partiallyPricedEvents", "unpricedEvents"]
          .every((key) => Number.isSafeInteger(pricing[key]) && pricing[key] >= 0)
        || pricing.fullyPricedEvents + pricing.partiallyPricedEvents
          + pricing.unpricedEvents !== row.usageEvents
        || !row.components || COMPONENT_KEYS.some((key) => (
          !Number.isSafeInteger(row.components[key]) || row.components[key] < 0
        ))) return false;
    priorEndMs = endMs;
    admittedEvents += row.usageEvents;
  }
  return admittedEvents === value.diagnostics.admittedEvents;
}

function validHistoricalPlanComparisons(value) {
  if (!Array.isArray(value.historicalPlanComparisons) || value.historicalPlanComparisons.length > 15) return false;
  const seen = new Set([value.allowanceCapacityByScenario?.planScope?.planType]);
  const intervals = [...(value.planScopedTimeline?.comparisonIntervals ?? [])];
  for (const row of value.historicalPlanComparisons) {
    if (!row || Object.keys(row).sort().join(",") !== "allowanceCapacityByScenario,failure,planScopedTimeline,planType"
        || typeof row.planType !== "string" || row.planType === "unknown" || seen.has(row.planType)
        || !(row.failure === null || (typeof row.failure === "string" && COMPOSITION_FIT_FAILURE_REASON_PATTERN.test(row.failure)))
        || (row.failure !== null && row.planScopedTimeline?.status !== "unavailable")
        || !validAllowanceCapacityByScenario(row.allowanceCapacityByScenario)
        || stableJson(row.allowanceCapacityByScenario) !== stableJson(allowanceCapacityForPlan(value.allowanceCapacityByScenario, row.planType))
        || !validPlanScopedTimeline(row.planScopedTimeline, value.sourceDescriptor, row.allowanceCapacityByScenario)) return false;
    seen.add(row.planType);
    intervals.push(...row.planScopedTimeline.comparisonIntervals);
  }
  const expectedPlans = value.allowanceCapacityByScenario.scenarios[value.allowanceCapacityByScenario.selectedScenario].calibration.planPopulations
    .map((row) => row.planType).filter((plan) => plan !== "unknown");
  if (expectedPlans.some((plan) => !seen.has(plan))) return false;
  intervals.sort((a, b) => a[0] - b[0]);
  return intervals.every((row, i) => i === 0 || intervals[i - 1][1] <= row[0]);
}

const COMPOSITION_CACHE_STATUSES = new Set([
  "fitted",
  "fallback_blended",
  "insufficient_observations",
]);

// The composition block a v0.7 cache carries on weeklyCalibration. `null` is
// a valid value (the reporting projection stores null for a malformed or
// absent input); a present block must be internally coherent — in particular
// a vector may exist only under the "fitted" status.
function validWeeklyCalibrationComposition(value) {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !COMPOSITION_CACHE_STATUSES.has(value.status)) return false;
  const finiteOrNull = (candidate, minimum = Number.NEGATIVE_INFINITY) => (
    candidate === null
    || (typeof candidate === "number"
      && Number.isFinite(candidate)
      && candidate >= minimum)
  );
  if (!finiteOrNull(value.r2)
      || !finiteOrNull(value.singleConstantR2)
      || !finiteOrNull(value.singleConstantUsd, 0)
      || !finiteOrNull(value.blendedRecentMixUsd, 0)
      || !finiteOrNull(value.grainHours, 0)
      || !finiteOrNull(value.recentMixDays, 0)
      || !Number.isSafeInteger(value.observationCount)
      || value.observationCount < 0) return false;
  // The fitted mix, held to the same shape rule as the capacity vector: it is
  // the only record of a model that consumed the allowance without earning a
  // column of its own, and the dashboard names those models from it.
  const shares = value.modelCostShares;
  if (shares !== null && shares !== undefined) {
    if (typeof shares !== "object" || Array.isArray(shares)) return false;
    if (!Object.entries(shares).every(([model, share]) => (
      typeof model === "string"
      && model.length > 0
      && model.length <= 64
      && (share === null
        || (typeof share === "number"
          && Number.isFinite(share)
          && share >= 0
          && share <= 1))
    ))) return false;
  }
  const vector = value.capacityUsdByModel;
  if (vector === null) return true;
  if (value.status !== "fitted"
      || !vector || typeof vector !== "object" || Array.isArray(vector)) {
    return false;
  }
  return Object.entries(vector).every(([model, capacity]) => (
    typeof model === "string"
    && model.length > 0
    && model.length <= 64
    && (capacity === null
      || (typeof capacity === "number"
        && Number.isFinite(capacity)
        && capacity > 0))
  ));
}

// Additive v0.7 field, present only when the composition fit itself threw
// (resource ceiling, abort, numerical failure): the build completed with
// `composition: null` and this bounded record says why, so a blank
// composition caused by a failure stays distinguishable against a corpus that
// simply never supported a fit.
// Absent on caches whose fit ran to completion.
function validWeeklyCalibrationCompositionStatus(value, composition) {
  if (value === undefined) return true;
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === "reason\0status"
    && value.status === "fit_failed"
    && typeof value.reason === "string"
    && COMPOSITION_FIT_FAILURE_REASON_PATTERN.test(value.reason)
    // A failed fit can never have produced a composition block.
    && (composition === null || composition === undefined);
}

function validCache(value) {
  try { validateUnknownSpeedPolicy(value?.unknownSpeedPolicy); validateUnknownSpeedPolicy(value?.allowanceCapacityByScenario?.unknownSpeedPolicy); } catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
      || canonicalInstant(value.generatedAt) === null
      || canonicalInstant(value.coveredAt?.startAt) === null
      || canonicalInstant(value.coveredAt?.endAt) === null
      || value.accountingMethod
        !== "lineage_aware_cumulative_snapshot_replay_exclusion"
      || value.pricingMethodVersion !== LOCAL_API_PRICING_METHOD_VERSION
      || value.priceEpochBasis !== HISTORICAL_PRICE_EPOCH_BASIS
      // A replay-safe total is meaningful only under the exact price registry
      // that produced it. Never let an older, higher price card silently
      // survive a registry correction just because its JSON shape is valid.
      || value.priceRegistryVersion !== APP_PRICE_REGISTRY_MANIFEST.version
      || value.priceRegistryObservedAt !== APP_PRICE_REGISTRY_MANIFEST.observedAt
      || unknownSpeedCalculationIdentity(value.unknownSpeedPolicy) !== unknownSpeedCalculationIdentity(value.allowanceCapacityByScenario?.unknownSpeedPolicy)
      || !validSourceDescriptor(value.sourceDescriptor)
      || !validHistory(value.history)
      || value.history.generation !== value.sourceDescriptor.generation
      || value.history.generationFingerprint
        !== value.sourceDescriptor.generationFingerprint
      || !Array.isArray(value.periods)
      || !Array.isArray(value.timeline)
      || !validQuotaTimeline(value.quotaTimeline, value.coveredAt)
      || !validQuotaTimeline(
        value.sparkQuotaTimeline,
        value.coveredAt,
        { limitIds: SPARK_QUOTA_LIMIT_IDS, durationMinutes: null },
      )
      || (value.weekly !== undefined && !validWeeklyPaceContainer(value.weekly))
      || !validWeeklyCalibrationInput(value.weeklyCalibrationInput)
      || !validAllowanceCapacityByScenario(
        value.allowanceCapacityByScenario,
      )
      || !validFiveHourAllowanceCalibration(
        value.fiveHourAllowanceCalibration, value.unknownSpeedPolicy,
      )
      || !validPlanScopedTimeline(
        value.planScopedTimeline,
        value.sourceDescriptor,
        value.allowanceCapacityByScenario,
      )
      || !validHistoricalPlanComparisons(value)
      || (value.weeklyApiIntervals !== undefined && (!validWeeklyApiIntervals(value.weeklyApiIntervals)
        || (value.weeklyApiIntervals.status === "available" && (
          value.weeklyApiIntervals.sourceGeneration !== String(value.sourceDescriptor.generation)
          || value.weeklyApiIntervals.sourceFingerprint !== value.sourceDescriptor.generationFingerprint))))
      || value.weeklyCalibration?.validation?.selectedCostBasis !== unknownSpeedCalibrationOptions(value.unknownSpeedPolicy).forcedCandidateId
      || (value.unknownSpeedPolicy.mode === "custom" && value.weeklyCalibration?.customFastRatioBps !== value.unknownSpeedPolicy.customFastRatioBps)
      || value.weeklyCalibration?.schemaVersion
        !== "weekly-calibration-summary-v0.1"
      || value.weeklyCalibration.windowDurationMinutes
        !== SEVEN_DAY_WINDOW_MINUTES
      || !validWeeklyPlanPopulations(value.weeklyCalibration, (population) => (
        validAllowanceCalibrationSummary(population, unknownSpeedCalibrationOptions(value.unknownSpeedPolicy).forcedCandidateId, { customFastRatioBps: value.unknownSpeedPolicy.customFastRatioBps })
          && validWeeklyCalibrationComposition(population.composition)
      ))
      || canonicalInstant(value.weeklyCalibration.generatedAt) === null
      || !["estimated", "insufficient_evidence"].includes(
        value.weeklyCalibration.status,
      )
      || value.weeklyCalibration.accountAttribution?.status
        !== "historical_unattributed"
      || value.weeklyCalibration.accountAttribution?.maySpanMultipleAccounts
        !== true
      || !Array.isArray(value.weeklyCalibration.recentResets)
      || value.weeklyCalibration.recentResets.length
        > BOUNDED_WEEKLY_CALIBRATION_RESET_LIMIT
      || !validWeeklyCalibrationComposition(
        value.weeklyCalibration.composition,
      )
      || !validWeeklyCalibrationCompositionStatus(
        value.weeklyCalibration.compositionStatus,
        value.weeklyCalibration.composition,
      )
      || value.periods.length !== 4
      || !Number.isSafeInteger(value.bucketMinutes)
      || value.bucketMinutes !== 15) return false;
  const ids = value.periods.map((row) => row?.id).sort().join(",");
  return ids === "24h,30d,7d,all"
    && value.periods.every((row) => (
      Number.isSafeInteger(row.events)
      && row.events >= 0
      && Number.isSafeInteger(row.totalTokens)
      && row.totalTokens >= 0
      && typeof row.apiPriceEquivalentUsd === "number"
      && Number.isFinite(row.apiPriceEquivalentUsd)
      && row.apiPriceEquivalentUsd >= 0
      && validPriceCardProvenance(row)
    ))
    && value.timeline.every((row) => (
      canonicalInstant(row?.startAt) !== null
      && canonicalInstant(row?.endAt) !== null
      && Number.isSafeInteger(row?.usageEvents)
      && row.usageEvents >= 0
      && Number.isSafeInteger(row?.totalTokens)
      && row.totalTokens >= 0
      && typeof row?.apiPriceEquivalentUsd === "number"
      && Number.isFinite(row.apiPriceEquivalentUsd)
      && row.apiPriceEquivalentUsd >= 0
      && validTimelineSpeedWeighting(row)
    ))
    && Array.isArray(value.sparkUsageTimeline)
    && value.sparkUsageTimeline.every((row) => (
      canonicalInstant(row?.startAt) !== null
      && canonicalInstant(row?.endAt) !== null
      && Number.isSafeInteger(row?.usageEvents)
      && row.usageEvents >= 0
      && Number.isSafeInteger(row?.totalTokens)
      && row.totalTokens >= 0
      && typeof row?.apiPriceEquivalentUsd === "number"
      && Number.isFinite(row.apiPriceEquivalentUsd)
      && row.apiPriceEquivalentUsd >= 0
      && validTimelineSpeedWeighting(row)
    ));
}

export async function readReplaySafeAccountingCache({
  stateFile = null,
  cacheFile = undefined,
  now = null,
  maximumAgeMs = null,
  sourceMode = null,
  expectedGeneration = null,
  contextBehavior = null,
  includeStaleGeneration = false,
} = {}) {
  if (cacheFile !== undefined) {
    throw new TypeError("cacheFile was retired; use stateFile");
  }
  const selectedStateFile = stateFile ?? defaultReplaySafeAccountingCachePath();
  if (typeof selectedStateFile !== "string" || selectedStateFile.length < 1) {
    throw new TypeError("Replay-safe SQLite state path is invalid");
  }
  if (now !== null && typeof now !== "function") {
    throw new TypeError("now must be a function or null");
  }
  if (typeof includeStaleGeneration !== "boolean") {
    throw new TypeError("includeStaleGeneration must be a boolean");
  }
  if (maximumAgeMs !== null
      && (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 0)) {
    throw new TypeError("maximumAgeMs must be a non-negative safe integer or null");
  }
  if (sourceMode !== null && sourceMode !== undefined) {
    normalizeAccountingSourceMode(sourceMode);
  }
  if (sourceMode === "unified"
      && (expectedGeneration === null || expectedGeneration === undefined)) {
    throw fixedError("accounting_unified_generation_required");
  }
  if (contextBehavior !== null && contextBehavior !== undefined) {
    normalizeContextBehavior(contextBehavior);
  }
  if (expectedGeneration !== null
      && expectedGeneration !== undefined
      && expectedGenerationTokens(expectedGeneration).length === 0) {
    throw new TypeError("expectedGeneration is invalid");
  }
  let unavailableErrorCode = null;
  let parsed = null;
  try {
    await prepareLocalCollectorState({ stateFile: selectedStateFile });
    const stored = await readLocalCollectorAccountingCache({ stateFile: selectedStateFile });
    if (stored.status === "missing" || stored.cache === null) {
      unavailableErrorCode = "cache_missing";
    } else {
      parsed = stored.cache;
    }
  } catch (error) {
    unavailableErrorCode = error?.code === "local_collector_state_missing"
      ? "cache_missing"
      : "cache_unavailable";
  }
  let staleCache = null;
  if (parsed !== null && !validCache(parsed)) {
    const registryOutdated = (
      parsed?.priceRegistryVersion !== undefined
      || parsed?.priceRegistryObservedAt !== undefined
    ) && (
      parsed?.priceRegistryVersion !== APP_PRICE_REGISTRY_MANIFEST.version
      || parsed?.priceRegistryObservedAt
        !== APP_PRICE_REGISTRY_MANIFEST.observedAt
    );
    unavailableErrorCode = parsed?.schemaVersion !== REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
      ? "cache_migration_required"
      : registryOutdated
      ? "cache_price_registry_outdated"
      : parsed?.schemaVersion !== REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION
        || parsed?.pricingMethodVersion !== LOCAL_API_PRICING_METHOD_VERSION
        || parsed?.priceEpochBasis !== HISTORICAL_PRICE_EPOCH_BASIS
        ? "cache_accounting_semantics_outdated"
        : "cache_invalid";
    parsed = null;
  }
  if (parsed === null) {
    let preservedHistory = null;
    try { preservedHistory = await readLocalCollectorPreservedAccountingHistory({ stateFile: selectedStateFile }); }
    catch { /* Invalid preservation evidence stays withheld, never rewritten. */ }
    return {
      status: "unavailable",
      errorCode: unavailableErrorCode ?? "cache_unavailable",
      cache: null,
      ...(preservedHistory === null ? {} : { preservedHistory }),
      ...(staleCache === null ? {} : { staleCache }),
    };
  }
  const descriptor = parsed.sourceDescriptor;
  if (descriptor.mode !== "unified") {
    return {
      status: "unavailable",
      errorCode: "cache_source_mode_mismatch",
      cache: null,
    };
  }
  if (sourceMode !== null
      && sourceMode !== undefined
      && descriptor.mode !== sourceMode) {
    return {
      status: "unavailable",
      errorCode: "cache_source_mode_mismatch",
      cache: null,
    };
  }
  if (contextBehavior !== null
      && contextBehavior !== undefined
      && descriptor.contextBehavior !== contextBehavior) {
    return {
      status: "unavailable",
      errorCode: "cache_context_behavior_mismatch",
      cache: null,
    };
  }
  if (expectedGeneration !== null && expectedGeneration !== undefined) {
    const expectedTokens = expectedGenerationTokens(expectedGeneration);
    const storedGenerations = [
      generationToken(descriptor.generation),
      generationToken(descriptor.generationFingerprint),
    ].filter((value) => value !== null);
    if (storedGenerations.length === 0
        || expectedTokens.length === 0
        || !generationMatchesExpected(expectedGeneration, storedGenerations)) {
      // A retained result never satisfies the current-generation contract.
      // Only a fully validated, zero-fallback artifact with a checked clock
      // may additionally travel on the explicitly stale channel.
      let retained = null;
      if (includeStaleGeneration && now !== null && descriptor.fallbackCount === 0) {
        const nowMs = now();
        if (!Number.isFinite(nowMs)) throw new TypeError("now must return a finite epoch timestamp");
        if (Date.parse(parsed.coveredAt.endAt) <= nowMs) {
          retained = {
            stale: true,
            reason: "cache_generation_mismatch",
            schemaVersion: parsed.schemaVersion,
            computedAt: parsed.generatedAt,
            coveredAt: { ...parsed.coveredAt },
            sourceGeneration: descriptor.generation,
            sourceGenerationFingerprint: descriptor.generationFingerprint,
            cache: parsed,
          };
        }
      }
      return {
        status: "unavailable",
        errorCode: "cache_generation_mismatch",
        cache: null,
        ...(retained === null ? {} : { staleCache: retained }),
      };
    }
  }
  if (now !== null) {
    const nowMs = now();
    if (!Number.isFinite(nowMs)) throw new TypeError("now must return a finite epoch timestamp");
    const coverageEndMs = Date.parse(parsed.coveredAt.endAt);
    if (coverageEndMs > nowMs) {
      return {
        status: "unavailable",
        errorCode: "cache_from_future",
        cache: null,
      };
    }
    const ageMs = Math.max(0, nowMs - coverageEndMs);
    if (maximumAgeMs !== null && ageMs > maximumAgeMs) {
      return {
        status: "stale",
        errorCode: "cache_stale",
        ageSeconds: Math.round(ageMs / 1_000),
        cache: parsed,
      };
    }
    return {
      status: "available",
      errorCode: null,
      ageSeconds: Math.round(ageMs / 1_000),
      cache: parsed,
    };
  }
  return { status: "available", errorCode: null, cache: parsed };
}

export function assertReplaySafeAccountingCache(value) {
  if (!validCache(value)) throw fixedError("cache_invalid");
  return value;
}

// The calibration pieces the local index store's corpus opener composes with.
// A transitional seam: when the shipping index is removed the calibration code
// moves to its own module and this object goes away.
export const REPLAY_SAFE_CALIBRATION_INTERNALS = Object.freeze({
  ACCOUNTING_RSS_CHECK_INTERVAL,
  ALLOWANCE_CAPACITY_SCHEMA_VERSION,
  ALLOWANCE_HISTORY_WINDOW_MINUTES,
  ALLOWANCE_SCENARIO_CANDIDATES,
  COMPACT_SNAPSHOT_RETAINED_BYTES,
  COMPACT_USAGE_RETAINED_BYTES,
  FIVE_HOUR_WINDOW_MINUTES,
  PARSER_VERSION,
  PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION,
  SPARK_MODEL,
  STREAMED_USAGE_MEMO_BYTES,
  STREAMED_USAGE_STAMP_BYTES,
  UNIFIED_CALIBRATION_READ_BATCH_ROWS,
  calibrationCohortId,
  calibrationPlanEvidence,
  codexPrimaryAllowanceBasis,
  compositionFitFailureReason,
  cooperativeYield,
  createAccountingPricer,
  declaredSpeedModeAt,
  deriveBoundedWeeklyCalibrationSeries,
  eventProjection,
  fitCompositionFromCorpusStream,
  fitHistoricalPlanTimelines,
  fitPlanCompositionsFromCorpus,
  historicalPlanComparisonReceipts,
  fixedError,
  planScopedTimelineReceipt,
  projectBoundedWeeklyCalibrationSummary,
  publicDiagnostics,
  MAX_CACHE_BYTES,
  safeModel,
  throwIfAborted,
  transitionResourceLimits,
  transitionUsageProjection,
  weeklyRateLimitProjection,
});
