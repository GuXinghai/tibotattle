import { describeLocalIndexGeneration } from "./local-index-companion-source.js";
import { openLocalIndexCalibrationCorpus } from "./local-index-calibration.js";
import { iterateLocalIndexUsageGroups, readLocalIndexReportMetadata } from "./local-index-report.js";
import {
  EVENT_FLAG_CACHE_WRITE_ASSUMED_ZERO,
  EVENT_FLAG_PARTIAL,
  LOCAL_INDEX_PARSER_VERSION,
  LOCAL_INDEX_STORE_USER_VERSION,
  openLocalIndexStore,
} from "./local-index-store.js";
import { projectRecordedTokenComponents } from "./reporting/index.js";
import {
  REPLAY_SAFE_CALIBRATION_INTERNALS,
  buildReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache,
} from "./replay-safe-accounting-cache.js";

// The replay-safe accounting cache, built from the v2 local index store.
//
// The cache's periods, timelines and quota series are folded by the same
// builder the shipping index feeds; what changes is the source. This module
// supplies that builder with a scan over the store's committed facts and a
// calibration corpus from Layer C, both read under one commit sequence, so the
// cache is bound to exactly the generation the companion projection names.

const { fixedError, throwIfAborted } = REPLAY_SAFE_CALIBRATION_INTERNALS;

export const LOCAL_INDEX_ACCOUNTING_SOURCE_VERSION = "local-index-accounting-source-v1";
const CONTRACT_VERSION = "local-index-v2";
const CALLBACK_YIELD_ROWS = 2_048;
const QUOTA_SLOTS = new Set(["primary", "secondary"]);
const MAXIMUM_INSTANT_MS = 8_640_000_000_000_000;

function nonNegative(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw fixedError("local_unified_index_row_invalid");
  }
  return numeric;
}

function nullableNonNegative(value) {
  return value === null || value === undefined ? null : nonNegative(value);
}

function components(row) {
  return projectRecordedTokenComponents({
    input_uncached_tokens: nullableNonNegative(row.tokens_in_uncached),
    input_cache_read_tokens: nullableNonNegative(row.tokens_in_cache_read),
    input_cache_write_tokens: nullableNonNegative(row.tokens_in_cache_write),
    output_text_tokens: nullableNonNegative(row.tokens_out_text),
    output_reasoning_tokens: nullableNonNegative(row.tokens_out_reasoning),
    output_combined_tokens: nullableNonNegative(row.tokens_out_combined),
  });
}

function instant(value) {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || Math.abs(ms) > MAXIMUM_INSTANT_MS) {
    throw fixedError("local_unified_index_row_invalid");
  }
  return { ms, iso: new Date(ms).toISOString() };
}

function diagnostics(database) {
  const result = {};
  for (const row of database.prepare(`
    SELECT code, SUM(count) AS count FROM source_diagnostic
    GROUP BY code ORDER BY code`).iterate()) {
    result[row.code] = nonNegative(row.count);
  }
  return result;
}

/** The v1-shaped coverage the accounting builder proves its inputs against. */
function coverageFor(database, generation, report) {
  const quarantined = generation.skippedSourceCount > 0;
  // Same admissibility as the shipping reader: a gap is attested only when
  // both the skipped sources and the threads they belong to are counted.
  const attestedGap = quarantined && generation.skippedThreadCount > 0;
  const proven = !quarantined || attestedGap;
  return {
    status: quarantined ? "partial" : "complete",
    indexStatus: generation.status,
    blockReason: quarantined ? generation.blockReason : null,
    generatedAt: generation.completedAtMs > 0
      ? new Date(generation.completedAtMs).toISOString() : null,
    coveredAt: report.coveredAt,
    generationId: generation.id,
    generationFingerprint: generation.fingerprint,
    generationProof: proven,
    sourceCount: generation.indexedSourceCount,
    sourceBytes: generation.indexedSourceBytes,
    skippedSourceCount: generation.skippedSourceCount,
    skippedSourceBytes: generation.skippedSourceBytes,
    skippedThreadCount: generation.skippedThreadCount,
    usageEvents: report.usageEvents,
    quotaObservations: null,
    quotaOccurrences: Number(database.prepare(`
      SELECT COUNT(*) AS n FROM quota_occurrence q JOIN source s ON s.id = q.source_id
      WHERE q.source_offset <= s.scanned_bytes`).get().n),
    admittedQuotaOccurrences: null,
    provenanceComplete: true,
    quotaOccurrencesComplete: true,
    diagnosticsComplete: true,
  };
}

function capabilitiesFor(coverage) {
  return {
    readsRawSources: false,
    deterministicCanonicalOrder: coverage.generationProof,
    sourceOrderingProvenance: coverage.provenanceComplete,
    sourceOffsetProvenance: coverage.provenanceComplete,
    sourceScopedQuotaOccurrences: coverage.quotaOccurrencesComplete,
    durableDiagnostics: coverage.diagnosticsComplete,
    crashSafeGenerationPublication: coverage.generationProof,
  };
}

/**
 * A scan with the contract of `createLocalUnifiedAccountingSource`'s reader,
 * over the store's committed facts at one commit sequence.
 *
 * Plan attribution per row is not produced: the builder asks for it only when
 * it falls back to retaining a windowed corpus, which this source never lets
 * it do for a store that holds usage (see `localIndexCalibrationSource`).
 */
export function createLocalIndexAccountingScan({
  indexFile,
  contextBehavior = "source_native",
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (contextBehavior !== "source_native") {
    throw new TypeError("contextBehavior must be source_native");
  }
  return async function scanLocalIndex({
    startAt,
    endAt,
    onUsage,
    onUsageGroup,
    usageBoundaryMs = [],
    declaredSpeedBaselines = [],
    onRateLimitSnapshot,
    indexedHistory,
    usageAttribution = "none",
    signal = null,
  } = {}) {
    throwIfAborted(signal);
    const startMs = Date.parse(startAt);
    const endMs = Date.parse(endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      throw new TypeError("scan window is invalid");
    }
    let database;
    try {
      database = openLocalIndexStore(indexFile, { readOnly: true });
    } catch (error) {
      throw fixedError(error?.code ?? "local_unified_index_unavailable");
    }
    try {
      return await withReadSnapshotAsync(database, async ({ commitSeq }) => {
        const report = readLocalIndexReportMetadata(database, { nowMs: endMs });
        const generation = describeLocalIndexGeneration(database, report, commitSeq);
        if (generation === null) throw fixedError("local_unified_index_coverage_unavailable");
        const coverage = coverageFor(database, generation, report);
        const history = report.coveredAt.startAt === null || report.coveredAt.endAt === null
          ? null
          : {
            startMs: Date.parse(report.coveredAt.startAt),
            endMs: Date.parse(report.coveredAt.endAt),
          };
        const scanStartMs = history === null ? startMs : Math.min(startMs, history.startMs);
        const scanEndMs = history === null ? endMs : Math.max(endMs, history.endMs);
        let sequence = 0;
        let sinceYield = 0;
        const deliver = async (callback, value) => {
          throwIfAborted(signal);
          const pending = callback(value);
          if (pending !== undefined && pending !== null) await pending;
          sinceYield += 1;
          if (sinceYield === CALLBACK_YIELD_ROWS) {
            sinceYield = 0;
            throwIfAborted(signal);
            await new Promise((resolve) => setImmediate(resolve));
          }
        };

        // Same order the shipping reader delivers, so floating-point folds
        // see events in the same sequence.
        const usageStatement = database.prepare(`
          SELECT u.observed_at_ms, u.source_offset, u.event_key, u.tier_observed_at_ms,
                 u.total_input_context, u.flags,
                 u.tokens_in_uncached, u.tokens_in_cache_read, u.tokens_in_cache_write,
                 u.tokens_out_text, u.tokens_out_reasoning, u.tokens_out_combined,
                 s.source_local, s.source_ordinal,
                 m.model_id,
                 t.billing_surface, t.codex_speed_mode, t.api_service_tier, t.tier_source,
                 c.surface, c.thread_source, c.agent_scope, c.lineage_disposition
          FROM usage_event u
          JOIN source s ON s.id = u.source_id
          JOIN model m ON m.id = u.model_id
          JOIN tier_semantics t ON t.id = u.tier_id
          JOIN surface_class c ON c.id = u.surface_id
          WHERE u.source_offset <= s.scanned_bytes
            AND u.observed_at_ms >= ? AND u.observed_at_ms <= ?
          ORDER BY u.observed_at_ms,
                   COALESCE(s.source_ordinal, 2147483647),
                   s.source_local,
                   u.source_offset,
                   u.event_key`);
        // Weighted delivery is explicit: legacy consumers retain their ordered
        // per-event stream and its exact source provenance.
        const grouped = typeof onUsageGroup === "function"
          && (indexedHistory === undefined || typeof indexedHistory.onUsageGroup === "function");
        const speedBoundaries = declaredSpeedBaselines.flatMap((row) => [
          Date.parse(row?.firstSeenAt), Date.parse(row?.lastSeenAt),
          Date.parse(row?.lastSeenAt) + 1,
        ]);
        const groups = grouped ? iterateLocalIndexUsageGroups(database, {
          startMs: scanStartMs, endMs: scanEndMs, accounting: true,
          boundaryMs: [startMs, endMs, history?.startMs, history?.endMs,
            ...usageBoundaryMs, ...speedBoundaries],
        }) : null;
        function* usageRows() {
          if (!grouped) {
            yield* usageStatement.iterate(scanStartMs, scanEndMs);
            return;
          }
          for (const group of groups) {
            const { record, row } = group;
            if (!group.aggregate) {
              yield { ...row, model_id: record.model,
                billing_surface: record.tierSemantics.billingSurface,
                codex_speed_mode: record.tierSemantics.codexSpeedMode,
                api_service_tier: record.tierSemantics.apiServiceTier,
                tier_source: record.tierSemantics.tierSource,
                surface: record.surfaceClassification.surface,
                thread_source: record.surfaceClassification.threadSource,
                agent_scope: record.surfaceClassification.agentScope,
                lineage_disposition: record.surfaceClassification.lineageDisposition };
              continue;
            }
            const c = record.components;
            yield {
              observed_at_ms: group.observedMs, model_id: record.model,
              total_input_context: record.totalInputContextTokens,
              tokens_in_uncached: c.input_uncached_tokens,
              tokens_in_cache_read: c.input_cache_read_tokens,
              tokens_in_cache_write: c.input_cache_write_tokens,
              tokens_out_text: c.output_text_tokens,
              tokens_out_reasoning: c.output_reasoning_tokens,
              tokens_out_combined: c.output_combined_tokens,
              flags: 0, tier_observed_at_ms: null, eventCount: group.eventCount,
              billing_surface: record.tierSemantics.billingSurface,
              codex_speed_mode: record.tierSemantics.codexSpeedMode,
              api_service_tier: record.tierSemantics.apiServiceTier,
              tier_source: record.tierSemantics.tierSource,
              surface: record.surfaceClassification.surface,
              thread_source: record.surfaceClassification.threadSource,
              agent_scope: record.surfaceClassification.agentScope,
              lineage_disposition: record.surfaceClassification.lineageDisposition,
            };
          }
        }
        for (const row of usageRows()) {
          const { ms: observedAtMs, iso: timestamp } = instant(row.observed_at_ms);
          const inWindow = observedAtMs >= startMs && observedAtMs <= endMs;
          const inHistory = history !== null
            && observedAtMs >= history.startMs && observedAtMs <= history.endMs;
          if (!inWindow && !inHistory) continue;
          const recorded = components(row);
          const usageComponents = recorded.components;
          if (!Object.values(usageComponents).some((value) => value > 0)) continue;
          if (inWindow && usageAttribution === "required" && (grouped || onUsage !== undefined)) {
            // The builder falls back to attributing rows itself only when the
            // calibration source declined the store, which it never does for
            // one that holds usage. Refuse rather than deliver unattributed
            // rows to a consumer that asked for attribution.
            throw fixedError("local_unified_index_read_failed");
          }
          const totalInputContext = nullableNonNegative(row.total_input_context);
          const tierObservedAtMs = nullableNonNegative(row.tier_observed_at_ms);
          const flags = nonNegative(row.flags);
          const componentAvailability = Object.fromEntries(Object.entries(usageComponents)
            .map(([key, value]) => [key, value !== null]));
          // A selected output representation supersedes its alias; absence of
          // that alias is not a second missing observation.
          if (usageComponents.output_combined_tokens === null) {
            delete componentAvailability.output_combined_tokens;
          }
          if ((flags & EVENT_FLAG_CACHE_WRITE_ASSUMED_ZERO) !== 0) {
            componentAvailability.input_cache_write_tokens = false;
          }
          const usage = {
            timestamp,
            timestampMs: observedAtMs,
            model: row.model_id,
            components: usageComponents,
            componentAvailability,
            // Keep additive estimates, but never upgrade partial or
            // contradictory source evidence to fully observed pricing.
            pricingEvidenceIncomplete: recorded.conflict || (flags & EVENT_FLAG_PARTIAL) !== 0,
            tierSemantics: {
              billingSurface: row.billing_surface,
              codexSpeedMode: row.codex_speed_mode,
              apiServiceTier: row.api_service_tier,
              tierSource: row.tier_source,
              tierObservedAt: tierObservedAtMs === null
                ? null : new Date(tierObservedAtMs).toISOString(),
            },
            surfaceClassification: {
              surface: row.surface,
              threadSource: row.thread_source,
              agentScope: row.agent_scope,
              lineageDisposition: row.lineage_disposition,
            },
          };
          if (totalInputContext !== null) {
            usage.totalInputContextTokens = totalInputContext;
          }
          if (row.eventCount !== undefined) usage.eventCount = nonNegative(row.eventCount);
          if (row.source_offset !== undefined) {
            const sourceOffset = nonNegative(row.source_offset);
            const sourceOrdinal = nullableNonNegative(row.source_ordinal);
            usage.sourceLocal = Buffer.from(row.source_local);
            usage.sourceRecordOrdinal = sourceOffset;
            usage.sourceOffset = sourceOffset;
            if (sourceOrdinal !== null) {
              usage.sourceRolloutOrdinal = sourceOrdinal;
              usage.sourceOrdinal = sourceOrdinal;
            }
          }
          if (inWindow && (grouped || onUsage !== undefined)) {
            usage.sequence = sequence++;
            await deliver(grouped ? onUsageGroup : onUsage, usage);
          }
          if (inHistory && indexedHistory !== undefined) {
            if (usage.sequence === undefined) usage.sequence = sequence++;
            await deliver(grouped ? indexedHistory.onUsageGroup : indexedHistory.onUsage, usage);
          }
        }

        if (onRateLimitSnapshot !== undefined) {
          const quotaStatement = database.prepare(`
            SELECT q.observed_at_ms, q.provider, q.limit_id, q.slot, q.plan_type,
                   q.used_percent, q.resets_at_ms, q.duration_mins,
                   q.source_offset, q.slot_order,
                   s.source_local, s.source_ordinal,
                   c.surface, c.thread_source, c.agent_scope, c.lineage_disposition
            FROM quota_occurrence q
            JOIN source s ON s.id = q.source_id
            JOIN surface_class c ON c.id = q.surface_id
            WHERE q.admission = 'admitted'
              AND q.source_offset <= s.scanned_bytes
              AND q.observed_at_ms >= ? AND q.observed_at_ms <= ?
            ORDER BY q.observed_at_ms,
                     s.source_ordinal,
                     s.source_local,
                     q.source_offset,
                     q.slot_order`);
          for (const row of quotaStatement.iterate(startMs, endMs)) {
            const { ms: observedAtMs, iso: timestamp } = instant(row.observed_at_ms);
            const resetsAtMs = nullableNonNegative(row.resets_at_ms);
            const usedPercent = Number(row.used_percent);
            // An admitted row is already valid by construction; a row that is
            // not is evidence the store cannot vouch for, so it is left out.
            if (resetsAtMs === null || resetsAtMs <= 0 || resetsAtMs % 1_000 !== 0
                || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100
                || !QUOTA_SLOTS.has(row.slot)
                || !Number.isSafeInteger(Number(row.duration_mins))
                || Number(row.duration_mins) < 1) continue;
            const sourceOffset = nonNegative(row.source_offset);
            const sourceOrdinal = nonNegative(row.source_ordinal);
            await deliver(onRateLimitSnapshot, {
              timestamp,
              timestampMs: observedAtMs,
              window: {
                provider: row.provider,
                planType: row.plan_type ?? "unknown",
                limitId: row.limit_id,
                slot: row.slot,
                usedPercent,
                windowDurationMins: Number(row.duration_mins),
                resetsAt: resetsAtMs / 1_000,
              },
              surfaceClassification: {
                surface: row.surface,
                threadSource: row.thread_source,
                agentScope: row.agent_scope,
                lineageDisposition: row.lineage_disposition,
              },
              sourceRolloutOrdinal: sourceOrdinal,
              sourceRecordOrdinal: sourceOffset,
              sourceLocal: Buffer.from(row.source_local),
              sourceOrdinal,
              sourceOffset,
              slotOrder: nonNegative(row.slot_order),
              sequence: sequence++,
            });
          }
        }
        throwIfAborted(signal);

        const capabilities = capabilitiesFor(coverage);
        const scanned = {
          readerVersion: LOCAL_INDEX_ACCOUNTING_SOURCE_VERSION,
          schemaVersion: String(LOCAL_INDEX_STORE_USER_VERSION),
          parserVersion: LOCAL_INDEX_PARSER_VERSION,
          contractVersion: CONTRACT_VERSION,
          generationId: generation.id,
          generationFingerprint: generation.fingerprint,
          coverage,
          capabilities,
          diagnosticCoverage: "complete",
          diagnosticsAvailable: true,
          diagnostics: diagnostics(database),
          toolCallsByClass: {},
          toolObservationsBySource: {},
          serverBillableUnits: {},
        };
        if (indexedHistory !== undefined) {
          scanned.indexedHistory = history === null
            ? {
              status: "unavailable",
              errorCode: "local_unified_index_coverage_unavailable",
            }
            : {
              status: "available",
              errorCode: null,
              coverage,
              capabilities,
              diagnosticsAvailable: true,
            };
        }
        return scanned;
      });
    } finally {
      try { database.close(); } catch { /* a close failure cannot widen the handle */ }
    }
  };
}

// `withReadSnapshot` is synchronous; the scan awaits its consumers, so it holds
// one read transaction across the awaits itself.
async function withReadSnapshotAsync(database, work) {
  database.exec("BEGIN");
  try {
    const commitSeq = Number(database.prepare(
      "SELECT commit_seq FROM store_state WHERE id = 1").get().commit_seq);
    return await work({ commitSeq });
  } finally {
    try { database.exec("COMMIT"); } catch { /* read transaction already closed */ }
  }
}

/**
 * The calibration source the builder takes: Layer C's corpus, fenced to the
 * commit sequence the cache is bound to.
 */
export function localIndexCalibrationSource({ indexFile }) {
  return {
    // A store with no usage, or no weekly snapshots, yields null; the builder
    // then fails closed with `accounting_calibration_corpus_unavailable`.
    open: async ({ expectedGeneration, ...options }) => {
      const corpus = await openLocalIndexCalibrationCorpus({ indexFile, ...options });
      if (corpus === null) return null;
      if (expectedGeneration !== null && expectedGeneration !== undefined
          && String(corpus.commitSeq) !== String(expectedGeneration)) {
        corpus.dispose();
        throw fixedError("accounting_unified_generation_mismatch");
      }
      return corpus;
    },
  };
}

/**
 * Build the replay-safe accounting cache for the store's current generation.
 *
 * `expectedGeneration` is the `{ id, fingerprint }` the caller read from the
 * companion projection; a store that has committed since fails the build with
 * `accounting_unified_generation_mismatch` rather than mixing two snapshots.
 */
export async function buildLocalIndexAccountingCache({
  indexFile,
  expectedGeneration,
  contextBehavior,
  ...options
} = {}) {
  return buildReplaySafeAccountingCache({
    ...options,
    sourceMode: "unified",
    expectedGeneration,
    ...(contextBehavior === undefined ? {} : { contextBehavior }),
    scan: createLocalIndexAccountingScan({
      indexFile,
      contextBehavior: contextBehavior ?? "source_native",
    }),
    calibrationSource: localIndexCalibrationSource({ indexFile }),
  });
}

/**
 * Build the cache for the store's current generation and publish it to the
 * collector state file, with the deferral, validation and atomic publication
 * the shipping refresh provides. The build runs in this process.
 */
export async function refreshLocalIndexAccountingCache({
  stateFile,
  indexFile,
  expectedGeneration,
  contextBehavior,
  ...options
} = {}) {
  return refreshReplaySafeAccountingCache({
    ...options,
    stateFile,
    sourceMode: "unified",
    expectedGeneration,
    ...(contextBehavior === undefined ? {} : { contextBehavior }),
    buildCache: (buildOptions) => buildLocalIndexAccountingCache({
      ...buildOptions,
      indexFile,
    }),
  });
}
