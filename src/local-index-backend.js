import { existsSync } from "node:fs";

import { refreshLocalIndexAccountingCache } from "./local-index-accounting-cache.js";
import { buildLocalIndexCacheDropThreadLinks } from "./local-index-cache-drop-links.js";
import {
  readLocalIndexCompanionProjection,
  readLocalIndexGenerationIdentity,
  readLocalIndexProjectionValidUntil,
  readLocalIndexPublication,
} from "./local-index-companion-source.js";
import {
  createLocalIndexTelemetryV11Reader,
  createLocalIndexTelemetryV1IndexReader,
} from "./local-index-contribution.js";
import { readLegacyOrdinalMap } from "./local-index-cutover.js";
import { refreshLocalIndex } from "./local-index-refresh.js";
import { auditPairing } from "./local-index-pairing.js";
import { auditRollups } from "./local-index-rollup.js";
import {
  LOCAL_INDEX_PARSER_VERSION,
  openLocalIndexStore,
  withReadSnapshot,
} from "./local-index-store.js";
import { auditWorkRollups } from "./local-index-work-rollup.js";
import { readLocalIndexWindowBreakdown } from "./local-index-window-breakdown.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION, OUTCOME_UNKNOWN } from "./codex-usage-vocabulary.js";

// The v2 index as one backend the local companion composes.
//
// The companion's refresh runner, its cached projection reader and its
// accounting refresh each consume a small function seam that the previous
// index implemented. This module implements the same seams over the v2 store,
// so the composition root changes which backend it builds and nothing
// downstream changes:
//
//   refreshUnifiedIndex  -> createLocalCollectorRefreshRunner({ refreshUnifiedIndex })
//   refreshAccounting    -> createLocalCollectorRefreshRunner({ refreshAccounting })
//   projectionReader     -> createCachedLocalUnifiedProjectionReader(projectionReader)
//
// Everything it returns is content-free: counts, timings, and the generation
// descriptor. Paths stay inside the store (docs/decisions/2026-10-12-local-index-v2-and-local-paths.md).

export const LOCAL_INDEX_BACKEND_VERSION = "local-index-backend-v1";

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function storeHasSources(indexFile) {
  if (!existsSync(indexFile)) return false;
  let database;
  try {
    database = openLocalIndexStore(indexFile, { readOnly: true });
    return database.prepare("SELECT 1 AS present FROM source LIMIT 1").get()?.present === 1;
  } catch {
    // An unreadable store is the refresh's to report; it must not be reseeded.
    return true;
  } finally {
    database?.close();
  }
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The projection reader for callers that compose no backend of their own. The
 * options are the cached reader's; `exactWindow` is a retired field the
 * previous index honoured and is dropped.
 */
export async function readLocalIndexProjection(options = {}, controls = {}) {
  const { exactWindow: _exactWindow, ...rest } = options;
  void _exactWindow;
  return readLocalIndexCompanionProjection({
    ...rest,
    signal: controls?.signal ?? null,
  });
}

/**
 * Create the v2 backend.
 *
 * `legacyIndexFile` is the previous index, read once, only while the v2 store
 * has no registered source, for the ordinal map that keeps hosted quota
 * identity continuous across the cutover. When it names a file that cannot be
 * read the refresh fails closed instead of minting fresh ordinals.
 */
export function createLocalIndexBackend({
  indexFile,
  secretFile = null,
  legacyIndexFile = null,
  workerCount = null,
  refresh = refreshLocalIndex,
  readOrdinalMap = readLegacyOrdinalMap,
  now = () => Date.now(),
} = {}) {
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  for (const [name, value] of [["refresh", refresh], ["readOrdinalMap", readOrdinalMap], ["now", now]]) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
  }

  // The descriptor needs one full report read; it is reused for as long as the
  // store's publication identity does not move.
  let described = null;

  async function describeCurrentGeneration(file) {
    const identity = readLocalIndexGenerationIdentity({ indexFile: file });
    if (identity === null) return null;
    if (described !== null && described.file === file
        && described.id === identity.id && described.fingerprint === identity.fingerprint) {
      return described.generation;
    }
    const projection = await readLocalIndexCompanionProjection({ indexFile: file, nowMs: now() });
    const generation = projection.status === "available" ? projection.generation : null;
    if (generation === null) return null;
    described = {
      file, id: generation.id, fingerprint: generation.fingerprint, generation,
    };
    return generation;
  }

  function legacyOrdinalSeed(file) {
    if (legacyIndexFile === null || storeHasSources(file)) return null;
    if (!existsSync(legacyIndexFile)) return null;
    try {
      const { ordinalSeed } = readOrdinalMap(legacyIndexFile);
      return ordinalSeed.size === 0 ? null : ordinalSeed;
    } catch {
      throw fixedError("local_unified_index_legacy_ordinals_unavailable");
    }
  }

  /** The refresh runner's `refreshUnifiedIndex` seam. */
  async function refreshUnifiedIndex({
    codexHome,
    indexFile: requestedFile = null,
    secretFile: requestedSecret = null,
    onProgress = null,
    signal = null,
  } = {}) {
    const file = requestedFile ?? indexFile;
    const result = await refresh({
      codexHome,
      indexFile: file,
      secretFile: requestedSecret ?? secretFile,
      workerCount,
      signal,
      ordinalSeed: legacyOrdinalSeed(file),
      ...(onProgress === null ? {} : { onProgress }),
    });
    // A deferred refresh stopped under write-ahead-log pressure. Everything it
    // committed is valid, but it did not reach the end of the corpus, so it
    // is not a publication accounting may treat as complete.
    if (result.status !== "refreshed") throw fixedError("local_unified_index_publication_busy");
    const generation = await describeCurrentGeneration(file);
    if (generation === null) throw fixedError("local_unified_index_generation_invalid");
    const scanned = count(result.sourcesResumed) + count(result.sourcesRescanned)
      + count(result.sourcesNew);
    return {
      status: "ingested",
      unchanged: result.unchanged === true,
      generation,
      sources: count(result.sources),
      sourcesSkipped: count(result.sourcesSkipped),
      sourcesTouched: scanned,
      sourcesResumed: count(result.sourcesResumed),
      sourcesRescanned: count(result.sourcesRescanned),
      sourcesScanned: scanned,
      bytesScanned: count(result.bytesScanned),
      insertedUsageEvents: count(result.usageEvents),
      totalUsageEvents: count(generation.usageEvents),
      wallMs: Number.isFinite(result.wallMs) ? result.wallMs : 0,
    };
  }

  /** The refresh runner's `refreshAccounting` seam. */
  async function refreshAccounting({
    // The previous implementation's routing options; the v2 cache is always
    // unified and built from this backend's store.
    sourceMode: _sourceMode,
    unifiedIndexFile: requestedFile = null,
    indexFile: _legacyAnalysisFile,
    indexSecretFile: _legacyAnalysisSecretFile,
    ...options
  } = {}) {
    void _sourceMode; void _legacyAnalysisFile; void _legacyAnalysisSecretFile;
    return refreshLocalIndexAccountingCache({
      ...options,
      indexFile: requestedFile ?? indexFile,
    });
  }

  /**
   * The refresh deadline for the next run. A store that does not exist yet, or
   * whose sources were written by another parser stamp, needs a full scan and
   * gets the bounded cold window; every other store, including an unreadable
   * one, keeps the ordinary incremental deadline.
   */
  function refreshTimeoutMs({
    indexFile: file = indexFile, existingTimeoutMs, freshTimeoutMs,
  } = {}) {
    if (!existsSync(file)) return freshTimeoutMs;
    let database;
    try {
      database = openLocalIndexStore(file, { readOnly: true });
      const stale = database.prepare(
        "SELECT 1 AS stale FROM source WHERE parser_version <> ? LIMIT 1",
      ).get(LOCAL_INDEX_PARSER_VERSION);
      return stale?.stale === 1 ? freshTimeoutMs : existingTimeoutMs;
    } catch {
      return existingTimeoutMs;
    } finally {
      try { database?.close(); } catch { /* the deadline is advisory */ }
    }
  }

  /**
   * Compare every derived table with a fresh grouping of the committed facts,
   * inside one read snapshot. Read-only and content-free: it returns counts of
   * differing rows, where zero means identical. Repair (a rebuild of the
   * derived tables from facts) belongs to the writer and is not done here.
   */
  function audit({ indexFile: file = indexFile } = {}) {
    if (!existsSync(file)) return Object.freeze({ status: "unavailable", consistent: false });
    let database;
    try {
      database = openLocalIndexStore(file, { readOnly: true });
      return withReadSnapshot(database, ({ commitSeq }) => {
        const rollup = auditRollups(database);
        const work = auditWorkRollups(database);
        const pairing = auditPairing(database);
        return Object.freeze({
          status: "audited",
          commitSeq,
          rollup,
          work,
          pairing,
          consistent: rollup === 0 && work === 0 && pairing === 0,
        });
      });
    } catch {
      return Object.freeze({ status: "unavailable", consistent: false });
    } finally {
      try { database?.close(); } catch { /* read-only handle */ }
    }
  }

  /** The three callbacks `createCachedLocalUnifiedProjectionReader` accepts. */
  const projectionReader = Object.freeze({
    reader: Object.assign(
      async function readProjection(options = {}, controls = {}) {
        return readLocalIndexProjection(
          { ...options, indexFile: options.indexFile ?? indexFile },
          controls,
        );
      },
      { close: async () => {} },
    ),
    validUntil: async ({
      indexFile: file = indexFile, generationFingerprint, nowMs, includeWorkUsage = false,
    } = {}) => readLocalIndexProjectionValidUntil({
      indexFile: file, generationFingerprint, nowMs, includeWorkUsage,
    }),
    readGeneration: async ({ indexFile: file = indexFile } = {}) => (
      readLocalIndexGenerationIdentity({ indexFile: file })?.fingerprint ?? null
    ),
  });

  // The contribution engine's four seams over the store. The record rules are
  // the contribution owner's; these only supply the row source and the
  // publication proof it fences each pass with.
  const contributionPorts = (ports) => ({
    ...ports,
    outcomeUnknownOrdinal: OUTCOME_UNKNOWN,
    parserVersionBase: LOCAL_UNIFIED_INDEX_PARSER_VERSION,
  });
  const contribution = Object.freeze({
    openIndex: (file, options) => openLocalIndexStore(file, options),
    createIndexReader: (database, ports) => (
      createLocalIndexTelemetryV1IndexReader(database, contributionPorts(ports))
    ),
    createV11Reader: (database, ports) => (
      createLocalIndexTelemetryV11Reader(database, contributionPorts(ports))
    ),
    readPublication: readLocalIndexPublication,
  });

  return Object.freeze({
    version: LOCAL_INDEX_BACKEND_VERSION,
    indexFile,
    contribution,
    audit,
    refreshUnifiedIndex,
    refreshAccounting,
    refreshTimeoutMs,
    projectionReader,
    /** The cache-drop thread-link provider; same inputs as the previous index's. */
    cacheDropThreadLinks: (options = {}) => buildLocalIndexCacheDropThreadLinks({
      ...options, indexFile: options.indexFile ?? indexFile,
    }),
    /** The window-breakdown route's provider. */
    windowBreakdown: ({ fromMs, toMs, indexFile: file = indexFile, pricer } = {}) => (
      readLocalIndexWindowBreakdown({
        indexFile: file, fromMs, toMs, ...(pricer === undefined ? {} : { pricer }),
      })
    ),
  });
}
