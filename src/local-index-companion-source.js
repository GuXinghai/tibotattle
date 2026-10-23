import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";

import {
  localIndexToolProvenanceComplete,
  readLocalIndexCoverage,
  readLocalIndexReport,
  readLocalIndexReportValidUntil,
} from "./local-index-report.js";
import {
  LOCAL_INDEX_PARSER_VERSION,
  LOCAL_INDEX_STORE_USER_VERSION,
  openLocalIndexStore,
  readCalculationRevision,
  withReadSnapshot,
} from "./local-index-store.js";
import { readLocalIndexWorkUsage } from "./local-index-work-usage.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION } from "./codex-usage-vocabulary.js";

// The companion's unified projection, read from the v2 local index store.
//
// It returns the envelope `readLocalUnifiedCompanionProjection` returns for the
// previous index, so the snapshot builder consumes it unchanged. What differs
// is the proof of publication: there is no staged generation to attest, so the
// generation descriptor is derived from one read snapshot of the store and its
// `id` is that snapshot's `commit_seq`, which only moves forward.

const PROJECTION_MODES = new Set(["full", "deferred"]);
const QUARANTINED_BLOCK_REASON = "codex_rollout_sources_quarantined";
const TOOL_BLOCK_REASON = "tool_provenance_incomplete";

function unavailable(status, errorCode = null) {
  return {
    status,
    errorCode,
    generatedAt: null,
    indexStatus: null,
    generation: null,
    coveredAt: { startAt: null, endAt: null },
    usageEvents: 0,
    quotaObservations: 0,
    sourceCount: 0,
    sourceBytes: 0,
    discoveredSourceCount: 0,
    discoveredSourceBytes: 0,
    indexedSourceCount: 0,
    indexedSourceBytes: 0,
    skippedSourceCount: 0,
    skippedSourceBytes: 0,
    skippedThreadCount: 0,
    responseUnverifiedPrefixTurns: null,
    cumulativePrefixUnattributed: null,
    rolloutIssueCounts: {},
    indexBytes: 0,
    latestExportableRecordAt: null,
    tools: { total: 0, counts: {} },
    toolCoverageStatus: "unavailable",
    toolCoverageBlockReason: null,
    usage: [],
    cacheSwitchImpact: null,
    cacheContinuityImpact: null,
    timeline: null,
  };
}

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function issueCounts(database) {
  const counts = {};
  for (const row of database.prepare(`
    SELECT quarantine_code AS code, COUNT(*) AS source_count,
           COALESCE(SUM(size_bytes), 0) AS source_bytes,
           COUNT(DISTINCT session_id) AS thread_count
    FROM source WHERE quarantine_code IS NOT NULL
    GROUP BY quarantine_code ORDER BY quarantine_code`).iterate()) {
    counts[row.code] = Object.freeze({
      threadCount: Number(row.thread_count),
      sourceCount: Number(row.source_count),
      sourceBytes: Number(row.source_bytes),
    });
  }
  return Object.freeze(counts);
}

// The identity of one publication: only values that are functions of the
// committed snapshot alone. The report clock changes the usage count (events
// past the future cutoff), and two readers at different clocks must still
// agree on the generation, so no clock-dependent count is part of it.
function generationIdentity(commitSeq, coverage, toolsComplete) {
  const skipped = coverage.skippedSourceCount > 0;
  const status = skipped || !toolsComplete ? "partial" : "complete";
  const blockReason = skipped
    ? QUARANTINED_BLOCK_REASON
    : toolsComplete ? null : TOOL_BLOCK_REASON;
  const material = [
    commitSeq, LOCAL_INDEX_PARSER_VERSION, LOCAL_INDEX_STORE_USER_VERSION,
    coverage.discoveredSourceCount, coverage.indexedSourceCount, coverage.skippedSourceCount,
    status, blockReason ?? "",
  ].join("\u001f");
  return {
    status,
    blockReason,
    fingerprint: `generation-v2-${createHash("sha256").update(material, "utf8").digest("hex")}`,
  };
}

/** The publication descriptor for one read snapshot of the store. */
export function describeLocalIndexGeneration(database, report, commitSeq) {
  if (!Number.isSafeInteger(commitSeq) || commitSeq < 1) return null;
  const toolsComplete = report.toolCoverageStatus === "complete";
  const { status, blockReason, fingerprint } = generationIdentity(commitSeq, report, toolsComplete);
  const committedAtMs = Number(database.prepare(
    "SELECT MAX(committed_at_ms) AS at FROM commit_log WHERE seq <= ?",
  ).get(commitSeq)?.at ?? 0);
  return {
    id: commitSeq,
    calculationRevision: readCalculationRevision(database),
    fingerprint,
    status,
    blockReason,
    schemaVersion: String(LOCAL_INDEX_STORE_USER_VERSION),
    parserVersion: LOCAL_INDEX_PARSER_VERSION,
    contractVersion: null,
    startedAtMs: committedAtMs,
    completedAtMs: committedAtMs,
    discoveredSourceCount: report.discoveredSourceCount,
    discoveredSourceBytes: report.discoveredSourceBytes,
    indexedSourceCount: report.indexedSourceCount,
    indexedSourceBytes: report.indexedSourceBytes,
    skippedSourceCount: report.skippedSourceCount,
    skippedSourceBytes: report.skippedSourceBytes,
    skippedThreadCount: report.skippedThreadCount,
    issueCounts: issueCounts(database),
    usageEvents: report.usageEvents,
    quotaOccurrences: null,
    coveredStartMs: report.coveredAt.startAt === null ? null : Date.parse(report.coveredAt.startAt),
    coveredEndMs: report.coveredAt.endAt === null ? null : Date.parse(report.coveredAt.endAt),
    // The store records every one of these as a fact of its own commit; there
    // is no separate publication step that could leave them unattested.
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolFacts: report.tools.total,
    toolFactFingerprint: null,
    toolProvenanceComplete: toolsComplete,
  };
}

/**
 * The identity (`{ id, fingerprint }`) of the store's current publication,
 * without building the report. It is the same value the projection's
 * generation carries, from a handful of catalog aggregates; `null` when the
 * store is absent, unreadable, or has never committed.
 */
export function readLocalIndexGenerationIdentity({ indexFile } = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  let database;
  try {
    const metadata = lstatSync(indexFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
    database = openLocalIndexStore(indexFile, { readOnly: true });
  } catch {
    return null;
  }
  try {
    return withReadSnapshot(database, ({ commitSeq }) => {
      if (!Number.isSafeInteger(commitSeq) || commitSeq < 1) return null;
      const identity = generationIdentity(
        commitSeq, readLocalIndexCoverage(database), localIndexToolProvenanceComplete(database),
      );
      return { id: commitSeq, fingerprint: identity.fingerprint, calculationRevision: readCalculationRevision(database) };
    });
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/**
 * The publication proof the contribution engine fences a pass with, over an
 * open connection: the publication fingerprint plus the connection-level
 * change counters that detect another writer committing mid-pass. Throws
 * `local_unified_index_unavailable` when the store has never committed.
 */
export function readLocalIndexPublication(database) {
  const identity = withReadSnapshot(database, ({ commitSeq }) => {
    if (!Number.isSafeInteger(commitSeq) || commitSeq < 1) return null;
    return generationIdentity(
      commitSeq, readLocalIndexCoverage(database), localIndexToolProvenanceComplete(database),
    );
  });
  if (identity === null) {
    const error = new Error("local_unified_index_unavailable");
    error.code = "local_unified_index_unavailable";
    throw error;
  }
  return Object.freeze({
    fingerprint: identity.fingerprint,
    // The hosted contract names the extractor, not the local storage format.
    // The compound v2 store stamp remains in the publication fingerprint.
    parserVersion: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
    dataVersion: database.prepare("PRAGMA data_version").get().data_version,
    changes: database.prepare("SELECT total_changes() AS count").get().count,
  });
}

/**
 * How long a projection read at `nowMs` for `generationFingerprint` stays
 * exact. Anything unproven (a different publication, an unreadable store)
 * answers `nowMs`: not reusable, so the caller reads in full.
 */
export function readLocalIndexProjectionValidUntil({
  indexFile, generationFingerprint, nowMs, includeWorkUsage = false,
} = {}) {
  let database;
  try {
    const metadata = lstatSync(indexFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return nowMs;
    database = openLocalIndexStore(indexFile, { readOnly: true });
  } catch {
    return nowMs;
  }
  try {
    return withReadSnapshot(database, ({ commitSeq }) => {
      const identity = generationIdentity(
        commitSeq, readLocalIndexCoverage(database), localIndexToolProvenanceComplete(database),
      );
      if (commitSeq < 1 || identity.fingerprint !== generationFingerprint) return nowMs;
      return readLocalIndexReportValidUntil(database, { nowMs, includeWorkUsage });
    });
  } catch {
    return nowMs;
  } finally {
    database.close();
  }
}

/**
 * Read the companion projection from the v2 store.
 *
 * `includeWorkUsage` additionally returns the work breakdown beside it, as the
 * previous reader does.
 */
export async function readLocalIndexCompanionProjection({
  indexFile,
  nowMs = Date.now(),
  declaredSpeedBaselines = [],
  mode = "full",
  includeWorkUsage = false,
  codexHome,
  secretFile = null,
  signal = null,
} = {}) {
  const complete = (companion, workUsage = null) => includeWorkUsage
    ? {
      companion,
      workUsage: workUsage ?? {
        status: companion.status === "available" ? "unavailable" : companion.status,
        asOfMs: nowMs,
      },
    }
    : companion;
  if (includeWorkUsage && typeof codexHome !== "string") {
    throw new TypeError("codexHome must be a string");
  }
  signal?.throwIfAborted();
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be a finite epoch timestamp");
  if (!PROJECTION_MODES.has(mode)) throw new TypeError("mode must be full or deferred");
  if (mode === "deferred") return complete(unavailable("deferred", "local_unified_index_deferred"));
  const baselines = Array.isArray(declaredSpeedBaselines) ? declaredSpeedBaselines : [];

  let size;
  try {
    const metadata = lstatSync(indexFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return complete(unavailable("unavailable", "local_unified_index_unavailable"));
    }
    size = metadata.size;
  } catch (error) {
    if (error?.code === "ENOENT") return complete(unavailable("missing"));
    return complete(unavailable("unavailable", "local_unified_index_unavailable"));
  }

  let database;
  try {
    database = openLocalIndexStore(indexFile, { readOnly: true });
  } catch (error) {
    return complete(unavailable("unavailable", error?.code ?? "local_unified_index_unavailable"));
  }
  try {
    const { companion, workUsage } = await readSnapshot({
      database, indexFile, nowMs, baselines, includeWorkUsage, codexHome, secretFile, signal, size,
    });
    return complete(companion, workUsage);
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.code?.startsWith("local_unified_index_") || error?.code?.startsWith("local_index_")) {
      return complete(unavailable("unavailable", error.code));
    }
    throw fixedError("local_unified_index_unavailable");
  } finally {
    database.close();
  }
}

async function readSnapshot({
  database, indexFile, nowMs, baselines, includeWorkUsage, codexHome, secretFile, signal, size,
}) {
  // The report and the work breakdown must describe the same publication. The
  // work read is asynchronous, so it cannot sit inside the synchronous
  // snapshot; its `commit_seq` is compared afterwards instead.
  const report = withReadSnapshot(database, ({ commitSeq }) => ({
    commitSeq,
    result: readLocalIndexReport(database, { nowMs, declaredSpeedBaselines: baselines }),
  }));
  signal?.throwIfAborted();
  const generation = describeLocalIndexGeneration(database, report.result, report.commitSeq);
  const { commitSeq, buildInProgress, expandedBuckets, readWallMs, ...projection } = report.result;
  void commitSeq; void expandedBuckets;
  const companion = {
    ...projection,
    generatedAt: generation === null || generation.completedAtMs === 0
      ? null : new Date(generation.completedAtMs).toISOString(),
    indexStatus: generation?.status ?? "unknown",
    generation,
    rolloutIssueCounts: generation?.issueCounts ?? {},
    indexBytes: size,
    buildInProgress,
    readWallMs,
  };
  // A store that was created but never committed has nothing to project.
  if (generation === null) return { companion: unavailable("missing"), workUsage: null };
  let workUsage = null;
  if (includeWorkUsage) {
    try {
      workUsage = await readLocalIndexWorkUsage({
        database, indexFile, codexHome, secretFile, nowMs, signal, declaredSpeedBaselines: baselines,
      });
      const settled = Number(database.prepare(
        "SELECT commit_seq AS n FROM store_state WHERE id = 1",
      ).get().n);
      if (settled !== report.commitSeq) {
        // A refresh committed between the two reads; claim nothing for work.
        workUsage = { status: "unavailable", asOfMs: nowMs, errorCode: "work_usage_unavailable" };
      }
    } catch (error) {
      signal?.throwIfAborted();
      workUsage = {
        status: "unavailable",
        asOfMs: nowMs,
        errorCode: error?.code === "work_usage_capacity_exceeded"
          ? error.code : "work_usage_unavailable",
      };
    }
  }
  return { companion, workUsage };
}
