// The closed Codex usage vocabulary the local index and its readers share:
// parser provenance stamps and the two fixed enumerations whose ordinals are
// part of the persisted format and of the telemetry contract. Append only.
//
// These names keep their historical `LOCAL_UNIFIED_INDEX_` prefix because
// they are written into stored parser stamps and tests pin them.

// Stamped onto every row. A parser change re-scans only the affected rows'
// source files; rows whose rollout files have rotated away keep their
// last-good values and stay visibly marked as older-parser output.
//
// v2 (2026-08-08): the delta derivation now recognises interleaved cumulative
// counter streams and mid-file counter resets — a counter regression
// re-anchors without charging, and a cumulative delta that materially exceeds
// the co-reported per-turn `last_token_usage` charges the per-turn value
// instead of the inter-stream gap. Rows derived under v1 can carry phantom
// spend (measured: 13.02B phantom tokens in one session), so the incremental
// ingest forces a whole-file rescan of any source whose cursor was stamped by
// an older parser version.
//
// v3 (2026-08-10): session-lineage speed carry-forward. A fork/lineage
// descendant with no `thread_settings_applied` of its own now seeds its
// initial tier from the most-recent observed tier of its ancestor chain,
// recorded under the new `lineage_inherited` tier_source (never masquerading
// as `rollout_thread_settings`). Strictly lineage-scoped — a session's own
// resume segments plus its fork/parent chain, never concurrent unrelated
// threads. Rows derived under v2 label such turns `unobserved` (priced
// Standard even when the reachable ancestor declaration was Fast), so the
// incremental ingest forces a whole-file rescan of v2-stamped sources.
//
// v4 (2026-08-16): top-level turn and compaction boundaries are attached to
// the next accepted positive-input usage row. Compaction is recognised from
// the bounded record header. The parser bump is intentional: every
// still-present source is re-scanned once so the new table does not silently
// mean "no boundary" for files indexed under earlier parsers.
//
// v5 (2026-08-16): every usage row also records its content-free source byte
// order. Event keys are HMACs, so they are deliberately random and cannot
// break real same-millisecond timestamp ties.
//
// v6 (2026-08-16): exact order is stored compactly as an interned integer
// source id plus source offset directly on the usage fact. The initial
// pre-release relation duplicated two 32-byte HMACs and indexes per event.
// This parser bump also forces still-present development-v5 sources to
// re-scan and backfill those fields instead of leaving a current-looking
// cursor over NULL order state. Rows retained from rotated older-parser
// sources remain distinguishable by provenance and are withheld from
// adjacency analysis rather than guessed into an order.
//
// v7 (2026-08-17): every current usage and quota fact is bound to a staged,
// attested publication generation with exact source-local ordering and
// source-scoped quota admission. This composes the v6 boundary/order contract
// with the unified accounting cutover's provenance contract.
// v8 (2026-08-17): typed response-item tool observations are source-scoped and
// generation-bound. Existing v7 cursors must rescan so a complete generation
// cannot silently publish an empty tool projection for already indexed files.
//
// v9 (2026-08-23): stable thread identity and immutable rollout identity are
// separate. Source and event keys are now rollout-scoped, and paginated
// history-base counters are seeded at their exact byte/ordinal boundary. This
// changes primary-key semantics, so incremental ingest performs a cold staged
// rebuild instead of mixing v8 and v9 facts.
//
// v10 (2026-08-23): every scan is bound to one opened physical source
// snapshot. Malformed accounting and unfinished JSONL tails are quarantined,
// with physical identity and the quarantine reason persisted in the cursor so
// an unchanged damaged rollout terminates cheaply and a changed one retries
// from byte zero.
//
// v11 (2026-08-29): an invalid quota window is withheld at record level while
// valid usage, tool, and quota facts from the same source remain available.
// A paginated replacement without history_base resets the selected lineage
// snapshot generation at the source-start boundary accepted by Codex.
// v12 (2026-09-04): preserve missing usage components as nullable facts and
// cursor counters. Existing retained sources reparse from byte zero; removed
// sources keep their original parser provenance rather than inventing proof.
// v13 (2026-09-04): recover compaction boundaries whose top-level header
// includes the current Codex serializer's ordinal before type.
// v14 (2026-09-04): paginated resets and exact history-base unknowns cannot
// inherit a logical parent's later model, effort, tier or counter state.
// Resume keeps own cursor state and reconstructs an absent inherited tier
// only from the same exact physical base, never the parent's final state.
// Inline descendants also stop tier and replay-snapshot traversal at that
// physical boundary instead of reviving discarded logical-ancestor history.
// Logical-parent state and ancestry are selected by resolved head, never by
// dependency/scan order among retained physical generations of one thread.
// v15 (2026-09-07): parent model declarations at/before the event and fork
// boundary recover missing paginated-fork models. Explicit child selections
// supersede the default. Counters, effort, tier and replay remain independent.
// v16 (2026-09-09): missing cache-write counts use the explicit product
// assumption of zero when input/cache-read counters are valid and consistent.
// A per-event suffix retains the assumption; raw delta/replay counters do not
// change. The base cursor stamp forces historical sources to be reparsed.
// v17 (2026-09-21): retain exact selected input/output totals in the existing
// total columns. Reject contradictory totals without inventing missing splits.
// Replay identity, additive components, and boundary semantics are unchanged.
// v18 (2026-09-22): classify bounded records by structural envelope type,
// not nested accounting markers, and raise the default line cap to 512 KiB.
// Reparse present sources, including quarantined lineage; retained absent
// sources keep their original facts and parser provenance.
// v19 (2026-09-29): reclassify retained GPT-6.1 Sol declarations through the
// reviewed catalog and retain explicit turn-context service tiers. Present
// sources are reparsed, while absent sources retain
// their original unknown identity and provenance. Physical schema is unchanged.
export const LOCAL_UNIFIED_INDEX_PARSER_VERSION = "unified-rollout-typed-v19";

export const LOCAL_UNIFIED_INDEX_SOURCE_IDENTITY_VERSION =
  "codex-immutable-rollout-v1";

// A row salvaged from a line that exceeded the bounded-line cap carries this
// parser version instead. The agreed schema has no "partial" column and the
// `outcome` enum is fixed by the telemetry contract, so the row-level parser
// stamp — which decision 4 of the design exists to provide — is where a
// degraded row is recorded. Kept in lockstep with the main constant: salvaged
// rows run the same delta derivation.
export const LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION =
  "unified-rollout-typed-v19-partial";

// Per-row provenance variants retain the inherited-model assumption without
// changing the physical schema. Ingest cursors keep the base v19 stamp.
export const LOCAL_UNIFIED_INDEX_PARENT_MODEL_PARSER_VERSION =
  "unified-rollout-typed-v19-parent-model";

export const LOCAL_UNIFIED_INDEX_PARENT_MODEL_PARTIAL_PARSER_VERSION =
  "unified-rollout-typed-v19-parent-model-partial";

// Cache continuity and dormant successor preparation both accept these exact
// row-level provenance variants. Keep the reviewed v15-v18 families readable after a
// v19 reparse; future parser labels remain unsupported until their semantics
// are reviewed explicitly.
const QUALIFIED_LOCAL_PARSER_VERSIONS = new Set([
  ...["unified-rollout-typed-v15", "unified-rollout-typed-v16", "unified-rollout-typed-v17", "unified-rollout-typed-v18"].flatMap((version) =>
    [version, `${version}-partial`, `${version}-parent-model`, `${version}-parent-model-partial`]),
  LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  LOCAL_UNIFIED_INDEX_PARTIAL_PARSER_VERSION,
  LOCAL_UNIFIED_INDEX_PARENT_MODEL_PARSER_VERSION,
  LOCAL_UNIFIED_INDEX_PARENT_MODEL_PARTIAL_PARSER_VERSION,
].flatMap((version) => version.startsWith("unified-rollout-typed-v15")
  ? [version] : [version, `${version}-cache-write-zero`]));

export function isLocalUnifiedIndexBoundaryParserVersion(value) {
  return QUALIFIED_LOCAL_PARSER_VERSIONS.has(value);
}

// The one shape a stored raw session identity may take: the provider-issued
// UUID. Deliberately narrower than the transport regex so a filename-shaped
// rollout-key fallback can never be recorded as an identity.
export const RAW_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Both enums are ordinals into the telemetry contract's fixed member lists.
// Their order is part of the on-disk format: append only, never reorder.
export const REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "unknown",
]);

export const OUTCOMES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "retry",
  "unknown",
]);

const REASONING_EFFORT_ORDINALS = new Map(
  REASONING_EFFORTS.map((value, index) => [value, index]),
);

const OUTCOME_ORDINALS = new Map(OUTCOMES.map((value, index) => [value, index]));

export const REASONING_EFFORT_UNKNOWN = REASONING_EFFORT_ORDINALS.get("unknown");

export const OUTCOME_UNKNOWN = OUTCOME_ORDINALS.get("unknown");

export function reasoningEffortOrdinal(value) {
  return REASONING_EFFORT_ORDINALS.get(value) ?? REASONING_EFFORT_UNKNOWN;
}

export function outcomeOrdinal(value) {
  return OUTCOME_ORDINALS.get(value) ?? OUTCOME_UNKNOWN;
}

export function reasoningEffortName(ordinal) {
  return REASONING_EFFORTS[ordinal] ?? "unknown";
}

export function outcomeName(ordinal) {
  return OUTCOMES[ordinal] ?? "unknown";
}
