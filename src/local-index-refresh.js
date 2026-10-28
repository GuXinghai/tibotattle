import { availableParallelism } from "node:os";
import { lstatSync, statSync, statfsSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  createLeadingRateLimitGate,
  RESPONSE_MODEL_RECOVERY_VERSION,
} from "./providers/codex/logs.js";
import { localCodexLogScanner } from "./local-node-runtime.js";
import { recognizedExportModelId } from "./export/index.js";
import {
  createLineageSnapshots,
  extractRolloutUsage,
  rolloutContainsResponseUsage,
  inheritedTierSeed,
  ownObservedTier,
  resolveLogicalRolloutHeads,
  rolloutContentQuarantineReason,
} from "./local-index-extract.js";
import {
  createHistoryBaseSeedResolver,
  createParentModelResolver,
  selectRolloutUsageSeed,
} from "./local-index-history.js";
import {
  balanceComponents,
  createWorkerBatchControl,
  lineageComponents,
  releaseWorkerBatch,
} from "./local-index-batching.js";
import { withStableRolloutSource } from "./rollout-source-snapshot.js";
import { createLocalRefreshTimer, reportLocalRefreshReuseDiagnostic } from "./local-refresh-timing.js";
import {
  localDigest,
  readExistingDeviceSalt,
  readOrCreateDeviceSalt,
  sessionLocal,
  snapshotLocal,
  sourceLocal,
} from "./local-index-identity.js";
import {
  DISCOVERY_QUARANTINE_CODES,
  LOCAL_INDEX_PARSER_VERSION,
  LOCAL_INDEX_MODEL_RECOGNITION_VERSION,
  createLocalIndexSecondaryIndexes,
  createLocalIndexWriter,
  loadCatalog,
  openLocalIndexStore,
  readCommitSeq,
  readPendingResponseModelRecoverySources,
  readPendingModelRecognitionSources,
  readLocalIndexIdentityBeforeMigration,
  reasoningEffortOrdinal,
} from "./local-index-store.js";
import {
  SEGMENT_BYTES,
  classifyFromStat,
  createSegmentTap,
  digestWindows,
  needsSegmentVerification,
  resolveFileIds,
  verifySegments,
  windowsMatch,
} from "./local-index-source-digest.js";

// Refresh the local index store from the Codex rollouts.
//
// Cold build and incremental refresh are one flow. Discovery yields the
// sources; each is compared with its catalog row by stat tuple (and by the
// head, boundary and open-tail windows when it grew); only sources that
// changed are read. A source advances in one transaction that also moves its
// cursor. When every unit of work is a brand-new source (a cold build or a
// large backlog), parallel lanes extract and the host writes provisional facts
// beyond the cursor, which `repairProvisional` removes after a crash.

const { discoverCodexRolloutInfos } = localCodexLogScanner;
const MAXIMUM_WORKERS = 10;
const AUTOMATIC_WORKER_RESERVED_PARALLELISM = 3;
const MAXIMUM_AUTOMATIC_WORKERS = 6;
const WORKER_BATCH_EVENTS = 500;
const WORKER_BATCH_WINDOW = 2;
const PARALLEL_BACKLOG_BYTES = 256 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const CODEX_BILLING_SURFACE = "chatgpt_subscription";
const REPLACEMENT_REASONS = new Set([
  "parser_version", "identity_changed", "cursor_invalid", "quarantine_changed",
  "dependency_quarantine_changed", "same_size_changed", "shrink",
  "boundary_changed", "compressed_changed", "segment_mismatch",
  "response_reconciliation",
]);

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

const LOCAL_INDEX_WORKER_CURSOR_KEYS = Object.freeze([
  "nextOffset", "finalModel", "finalEffort", "finalTierRaw", "finalTierObservedAtMs",
  "finalTierSource", "finalTotals", "finalCwd", "finalCompactionPending",
  "finalTurnContextPending", "turnContextSeen", "snapshotsPersisted", "windows", "segments",
].sort());

export function validateLocalIndexWorkerCursor(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).sort().join("\0") !== LOCAL_INDEX_WORKER_CURSOR_KEYS.join("\0")) {
    throw fixedError("local_index_worker_message_invalid");
  }
  const { finalTierRaw, finalTierObservedAtMs, finalTierSource } = value;
  if (!(finalTierRaw === null || typeof finalTierRaw === "string")
      || !(finalTierObservedAtMs === null || Number.isSafeInteger(finalTierObservedAtMs))
      || !(finalTierSource === null
        || finalTierSource === "turn_override"
        || finalTierSource === "rollout_thread_settings")
      || (finalTierSource === null
        ? finalTierRaw !== null || finalTierObservedAtMs !== null
        : !Number.isSafeInteger(finalTierObservedAtMs))) {
    throw fixedError("local_index_worker_message_invalid");
  }
  return value;
}

export function defaultLocalIndexFile(root) {
  return resolve(root, "local-index-store-v1.sqlite");
}

export function defaultLocalIndexSecretFile(indexFile) {
  return resolve(dirname(resolve(indexFile)), "local-unified-index-device-salt-v1");
}

export function defaultLocalIndexWorkerCount(parallelism = availableParallelism()) {
  return Math.min(
    MAXIMUM_AUTOMATIC_WORKERS,
    Math.max(1, parallelism - AUTOMATIC_WORKER_RESERVED_PARALLELISM),
  );
}

function sourceIdentity(info) {
  return typeof info?.sourceIdentity === "string" && info.sourceIdentity.length > 0
    ? info.sourceIdentity
    : info.rolloutKey;
}

function modelDeclaration(rawModel) {
  if (typeof rawModel !== "string" || rawModel.length === 0) {
    return { modelId: "unknown", recognition: "missing" };
  }
  const recognized = recognizedExportModelId(rawModel);
  if (recognized !== null && recognized !== undefined) {
    return { modelId: recognized, recognition: "recognized" };
  }
  return { modelId: "unknown", recognition: "unrecognized" };
}

function tierRow(tier) {
  if (tier === null || tier === undefined) {
    return {
      apiServiceTier: "unknown",
      billingSurface: CODEX_BILLING_SURFACE,
      codexSpeedMode: "unknown",
      tierSource: "unobserved",
      providerTierRaw: null,
    };
  }
  const tierSource = tier.inherited === true ? "lineage_inherited" : tier.tierSource;
  if (!["lineage_inherited", "turn_override", "rollout_thread_settings"].includes(tierSource)) {
    return {
      apiServiceTier: "unknown",
      billingSurface: CODEX_BILLING_SURFACE,
      codexSpeedMode: "unknown",
      tierSource: "unobserved",
      providerTierRaw: null,
    };
  }
  const raw = tier.providerTierRaw;
  const normalized = typeof raw === "string" ? raw.toLowerCase() : null;
  let codexSpeedMode = "unknown";
  if (normalized === "default" || normalized === "standard") codexSpeedMode = "standard";
  else if (normalized === "priority" || normalized === "fast") codexSpeedMode = "fast";
  else if (normalized === "ultrafast") codexSpeedMode = "ultrafast";
  else if (normalized !== null) codexSpeedMode = "other";
  return {
    apiServiceTier: "unknown",
    billingSurface: CODEX_BILLING_SURFACE,
    codexSpeedMode,
    // Provenance, not strength: a tier seeded from the lineage must not
    // masquerade as a declaration read from this file.
    tierSource,
    providerTierRaw: raw ?? null,
  };
}

function surfaceRow(classification) {
  return {
    agentScope: classification?.agentScope ?? "unknown",
    surface: classification?.surface ?? "local_rollout_unclassified",
    threadSource: classification?.threadSource ?? "unknown",
    lineageDisposition: classification?.lineageDisposition ?? "standalone",
  };
}

/**
 * The inspection recorded with a source: everything discovery would otherwise
 * re-read from the file header or a cold decode. `statSize` is the walked
 * (physical) size the record is valid for.
 */
function inspectionRecord(info) {
  return JSON.stringify({
    statSize: Number(info.physicalSize ?? info.size ?? 0),
    lineage: info.lineage ?? null,
    compressionReason: info.compressionReason ?? null,
    size: info.compressed === true ? Number(info.size ?? 0) : undefined,
    contentSha256: info.compressed === true ? info.contentSha256 ?? null : undefined,
  });
}

/**
 * Build the discovery cache from the catalog: a hit requires the exact stat
 * tuple the inspection was recorded under, so any change re-inspects.
 */
/**
 * Discovery sees doubles. A stored exact id matches a walked entry when both
 * give the same device and the same inode after rounding to a double; hits
 * that relied on rounding are re-checked exactly once ids are resolved.
 */
function sameWalkedFileId(fileId, walked) {
  const separator = fileId.indexOf(":");
  return separator > 0
    && Number(fileId.slice(0, separator)) === Number(walked.dev)
    && Number(fileId.slice(separator + 1)) === Number(walked.ino);
}

function createInspectionCache(catalog, { disabled = null, roundedHits = null } = {}) {
  const byPath = new Map();
  for (const row of catalog.values()) {
    if (row.lineage_json !== null) byPath.set(row.path, row);
  }
  return (walked) => {
    const row = byPath.get(walked.path);
    if (row === undefined || disabled?.has(walked.path)) return null;
    if (typeof row.file_id !== "string"
        || !sameWalkedFileId(row.file_id, walked)
        || Number(row.birthtime_ms) !== Number(walked.birthtimeMs)
        || Number(row.mtime_ms) !== Number(walked.mtimeMs)
        || Number(row.ctime_ms) !== Number(walked.ctimeMs)) return null;
    let record;
    try {
      record = JSON.parse(row.lineage_json);
    } catch {
      return null;
    }
    if (record?.lineage === null || typeof record?.lineage !== "object"
        || record.statSize !== Number(walked.size)) return null;
    if (!Number.isSafeInteger(Number(walked.ino))) roundedHits?.set(walked.path, row.file_id);
    return record;
  };
}

function carriedTotals(row) {
  const totals = {
    input_tokens: row.carry_total_input,
    cached_input_tokens: row.carry_total_cached,
    cache_write_input_tokens: row.carry_total_cache_write,
    output_tokens: row.carry_total_output,
    reasoning_output_tokens: row.carry_total_reasoning,
    total_tokens: row.carry_total_total,
  };
  for (const value of Object.values(totals)) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) return null;
  }
  return Object.values(totals).every((value) => value === null) ? null : totals;
}

function carriedTier(row) {
  if (row.carry_tier_observed_at_ms === null
      || !["turn_override", "rollout_thread_settings"].includes(row.carry_tier_source)) return null;
  return {
    providerTierRaw: row.carry_tier_raw ?? null,
    observedAtMs: Number(row.carry_tier_observed_at_ms),
    tierSource: row.carry_tier_source,
  };
}

function carriedCompaction(row) {
  if (row.compacted_at_ms === null || row.compaction_offset === null) return null;
  return {
    observedAtMs: Number(row.compacted_at_ms),
    sourceOffset: Number(row.compaction_offset),
  };
}

/**
 * Event and quota fact sink for one refresh. It owns the leading-rate-limit
 * gate per source and translates extractor events into store rows.
 */
function createFactSink({ writer, deviceSalt, accountScope, counts }) {
  const gates = new Map();
  const quotaSuppressed = new Map();

  function gateFor(state) {
    let gate = gates.get(state.sourceId);
    if (gate === undefined) {
      gate = createLeadingRateLimitGate(writer.loadSettledQuotaWindows(state.sourceId));
      gates.set(state.sourceId, gate);
    }
    return gate;
  }

  function eventKey(state, offset, observedAtMs) {
    return localDigest(
      deviceSalt,
      "unified-index-event",
      `${state.sourceLocal.toString("hex")}\0${offset}\0${observedAtMs}`,
    );
  }

  function occurrence(state, entry, admission) {
    writer.writeQuotaOccurrence({
      sourceId: state.sourceId,
      sourceOffset: entry.sourceOffset,
      slotOrder: entry.slotOrder,
      surfaceId: state.surfaceId,
      canonicalObservationId: entry.canonicalObservationId,
      observedAtMs: entry.observedAtMs,
      provider: entry.provider,
      planType: entry.planType ?? null,
      limitId: entry.limitId,
      slot: entry.slot,
      usedPercent: entry.usedPercent,
      resetsAtMs: entry.resetsAtMs ?? null,
      durationMins: entry.durationMins,
      admission,
    });
    if (admission === "admitted") counts.quotaOccurrences += 1;
  }

  return {
    write(state, event) {
      const declaration = modelDeclaration(event.model);
      let quotaObservationId = null;
      const gate = gateFor(state);
      for (const [slotOrder, window] of event.quota.entries()) {
        const id = writer.internQuota(window);
        if (quotaObservationId === null || window.slot === "primary") quotaObservationId = id;
        const entry = {
          sourceOffset: event.sourceOffset,
          canonicalObservationId: id,
          observedAtMs: window.observedAtMs,
          provider: "openai_codex",
          planType: window.planType ?? null,
          limitId: window.limitId,
          slot: window.slot,
          slotOrder,
          usedPercent: window.usedPercent,
          resetsAtMs: window.resetsAtMs ?? null,
          durationMins: window.durationMins,
        };
        // A reset-less window never enters the source-scoped series.
        if (entry.resetsAtMs === null || entry.resetsAtMs <= 0) {
          occurrence(state, entry, "suppressed");
          continue;
        }
        const decision = gate.offer({
          provider: entry.provider,
          planType: entry.planType,
          limitId: entry.limitId,
          slot: entry.slot,
          usedPercent: entry.usedPercent,
          resetsAt: entry.resetsAtMs,
          windowDurationMins: entry.durationMins,
        }, entry.observedAtMs, entry);
        for (const withheld of decision.withheld) {
          quotaSuppressed.set(state.sourceId, (quotaSuppressed.get(state.sourceId) ?? 0) + 1);
          occurrence(state, withheld, "suppressed");
        }
        for (const released of decision.released) occurrence(state, released, "admitted");
        if (decision.released.length === 0 && decision.withheld.length === 0) {
          occurrence(state, entry, "held");
        }
      }
      const components = event.components;
      const inserted = writer.writeUsageEvent({
        sourceId: state.sourceId,
        sourceOffset: event.sourceOffset,
        observedAtMs: event.observedAtMs,
        eventKey: event.responseIdentity
          ? localDigest(deviceSalt, 'unified-index-response', event.responseIdentity)
          : eventKey(state, event.sourceOffset, event.observedAtMs),
        sessionId: state.sessionId,
        accountScopeId: writer.internAccountScope(accountScope),
        modelId: writer.internModel(declaration.modelId, declaration.recognition),
        tierId: writer.internTier(tierRow(event.tier)),
        surfaceId: state.surfaceId,
        quotaObservationId,
        tierObservedAtMs: event.tier?.observedAtMs ?? null,
        reasoningEffort: reasoningEffortOrdinal(event.reasoningEffort ?? "unknown"),
        workDirectoryId: writer.internWorkDirectory(event.cwd ?? null),
        partial: event.partial === true,
        modelInherited: event.modelInherited === true,
        cacheWriteAssumedZero: event.cacheWriteAssumedZero === true,
        statusOnly: event.statusOnly === true,
        responseUsage: event.responseUsage === true,
        tokensInUncached: components?.inputUncachedTokens ?? null,
        tokensInCacheRead: components?.inputCacheReadTokens ?? null,
        tokensInCacheWrite: components?.inputCacheWriteTokens ?? null,
        tokensOutText: components?.outputTextTokens ?? null,
        tokensOutReasoning: components?.outputReasoningTokens ?? null,
        tokensOutCombined: event.outputCombinedTokens ?? null,
        totalInputContext: event.totalInputContextTokens ?? null,
      });
      counts.usageEvents += inserted;
      return inserted;
    },
    writeBoundary(state, event) {
      if (!writer.hasUsageEvent(state.sourceId, event.currentSourceOffset)) return;
      writer.writeBoundary({
        sourceId: state.sourceId,
        sourceOffset: event.currentSourceOffset,
        compactionBefore: event.compactionBefore,
        turnContextBefore: event.turnContextBefore,
        compactedAtMs: event.compactedAtMs,
      });
    },
    writeTool(state, event) {
      writer.writeToolFact({
        sourceId: state.sourceId,
        sourceOffset: event.sourceOffset,
        toolOrdinal: event.toolOrdinal,
        eventKey: localDigest(
          deviceSalt,
          "unified-index-tool-event",
          `${state.sourceLocal.toString("hex")}\0${event.sourceOffset}\0${event.toolOrdinal}`,
        ),
        sessionId: state.sessionId,
        observedAtMs: event.observedAtMs,
        toolClass: event.toolClass,
        sourceKind: event.sourceKind,
      });
    },
    writeWork(state, event) {
      writer.writeWorkFact({ sourceId: state.sourceId, sourceOffset: event.sourceOffset,
        sessionId: state.sessionId, observedAtMs: event.observedAtMs,
        kind: event.kind, durationMs: event.durationMs,
        taskKey: localDigest(deviceSalt, "task-work-v1", event.taskId) });
    },
    finishSource(state) {
      const gate = gates.get(state.sourceId);
      if (gate === undefined) return;
      for (const entry of gate.flush()) occurrence(state, entry, "admitted");
    },
    suppressedFor(state) {
      return quotaSuppressed.get(state.sourceId) ?? 0;
    },
    discardSource(state) {
      gates.delete(state.sourceId);
      quotaSuppressed.delete(state.sourceId);
    },
  };
}

async function runWorkerLane(lane, { maximumLineBytes, signal, onBatch }) {
  return new Promise((settle, fail) => {
    const batchControl = createWorkerBatchControl();
    const worker = new Worker(new URL("./local-index-worker.js", import.meta.url), {
      workerData: {
        maximumLineBytes,
        batchEvents: WORKER_BATCH_EVENTS,
        batchControl: batchControl.buffer,
        batchWindow: WORKER_BATCH_WINDOW,
        components: lane.components.map((members) => members.map((info) => ({
          path: info.path,
          size: Number(info.size ?? 0),
          physicalSize: info.physicalSize,
          compressed: info.compressed === true,
          sessionId: info.lineage?.sessionId ?? null,
          parentId: info.lineage?.parentId ?? null,
          isFork: info.lineage?.isFork === true,
          isInlineFork: info.lineage?.isInlineFork === true,
          historyMode: info.lineage?.historyMode ?? "legacy",
          historyBase: info.lineage?.historyBase ?? null,
          startOrdinal: info.lineage?.startOrdinal ?? 0,
          resolvedHead: info.resolvedHead === true,
          rolloutId: info.rolloutId ?? null,
          rolloutKey: info.rolloutKey,
          dev: info.dev,
          ino: info.ino,
          fileId: info.fileId ?? null,
          birthtimeMs: info.birthtimeMs,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
        }))),
      },
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        codeRangeSizeMb: 16,
        stackSizeMb: 2,
      },
    });
    let failed = null;
    const abort = () => worker.terminate();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.on("message", (message) => {
      if (message.type === "batch") {
        try {
          onBatch(message);
        } catch (error) {
          failed = error;
          worker.terminate();
        } finally {
          releaseWorkerBatch(batchControl);
        }
        return;
      }
      if (message.type === "failed") {
        failed ??= fixedError(message.code ?? "local_index_worker_failed");
      }
    });
    worker.on("error", (error) => { failed ??= error; });
    worker.on("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (failed) fail(failed);
      else if (signal?.aborted) fail(fixedError("local_index_aborted"));
      else if (code !== 0) fail(fixedError("local_index_worker_failed"));
      else settle();
    });
  });
}

/**
 * Back-pressure on the write-ahead log. A reader that keeps one snapshot open
 * pins the log: nothing can be checkpointed, so every commit grows it. The
 * log is then a resource the refresher must not spend without bound.
 *
 * Measured on a 2,400-source synthetic corpus (140 MB store): an unpinned
 * cold build never exceeded 4.1 MB of log, so anything past the soft limit
 * means a reader is pinning it. With a reader pinned from the start the log
 * reached 456 MB, and a steady refresh adds well under 1 MB. The hard limit
 * is twice the pinned bulk build, bounded by a tenth of the free disk. At it
 * the refresher stops starting write transactions and reports `deferred`;
 * everything committed stays valid and resumes from its cursor.
 *
 * Deferral loses data only if Codex deletes a rollout before the next
 * refresh. Moves to archived_sessions keep the source's identity and are
 * discovered, and no deletion was observed in the measured history, so the
 * limit is set by disk and read latency, not by rotation (plan section 8.4).
 */
export const LOCAL_INDEX_WAL_LIMITS = Object.freeze({
  softBytes: 64 * 1024 * 1024,
  hardBytes: 1024 * 1024 * 1024,
  freeDiskFraction: 0.1,
});

export function localIndexWalHardLimit(indexFile, limits = LOCAL_INDEX_WAL_LIMITS) {
  let hard = limits.hardBytes;
  if (typeof limits.freeDiskFraction === "number") {
    try {
      const stats = statfsSync(dirname(indexFile));
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (Number.isFinite(free) && free > 0) {
        hard = Math.min(hard, Math.max(limits.softBytes, Math.floor(free * limits.freeDiskFraction)));
      }
    } catch {
      // No free-space figure: the fixed limit applies.
    }
  }
  return hard;
}

/**
 * Refresh the store. Returns content-free counts and timings.
 *
 * `ordinalSeed` carries `source_local -> source_ordinal` identity metadata
 * from the previous store at the one-time cutover (hex-keyed Map). It is
 * consulted only when a source is first registered.
 */
export async function refreshLocalIndex({
  codexHome,
  indexFile,
  secretFile = null,
  startAt = "1970-01-01T00:00:00.000Z",
  endAt = null,
  workerCount = null,
  maximumLineBytes,
  signal = null,
  discoveryLimits = null,
  ordinalSeed = null,
  requireExistingDeviceSalt = false,
  verify = null,
  walLimits = LOCAL_INDEX_WAL_LIMITS,
  discover = discoverCodexRolloutInfos,
  onProgress = null,
  onTiming = null, monotonicClock = undefined, onReuseDiagnostic = null,
  now = () => Date.now(),
} = {}) {
  if (typeof codexHome !== "string" || codexHome.length < 1) {
    throw new TypeError("codexHome must be a non-empty string");
  }
  if (onProgress !== null && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be null or a function");
  }
  if (typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("indexFile must be a non-empty string");
  }
  if (workerCount !== null
      && (!Number.isSafeInteger(workerCount) || workerCount < 1 || workerCount > MAXIMUM_WORKERS)) {
    throw new TypeError(`workerCount must be null or between 1 and ${MAXIMUM_WORKERS}`);
  }
  if (typeof requireExistingDeviceSalt !== "boolean") {
    throw new TypeError("requireExistingDeviceSalt must be a boolean");
  }
  const startedAt = performance.now();
  const timing = createLocalRefreshTimer({ onTiming, clock: monotonicClock });
  const finishPrepare = timing.start("index_prepare");
  const resolvedIndexFile = resolve(indexFile);
  let existingIdentity = requireExistingDeviceSalt || (ordinalSeed !== null && ordinalSeed.size > 0);
  // Inspect existing state read-only before permitting salt creation. Opening
  // it writable first could recover facts or reconcile rollups under a lost
  // identity. An incompatible/unreadable file must also fail without minting.
  let present = false;
  try { lstatSync(resolvedIndexFile); present = true; }
  catch (error) { if (error?.code !== "ENOENT") throw fixedError("local_index_unavailable"); }
  if (present) {
    const prior = readLocalIndexIdentityBeforeMigration(resolvedIndexFile);
    existingIdentity ||= prior.hasFacts;
  }
  const saltFile = secretFile ?? defaultLocalIndexSecretFile(resolvedIndexFile);
  const deviceSalt = await (existingIdentity
    ? readExistingDeviceSalt(saltFile) : readOrCreateDeviceSalt(saltFile));
  const database = openLocalIndexStore(resolvedIndexFile, { create: true });
  const writer = createLocalIndexWriter(database);
  for (const [method, stage] of [["deleteSourceFacts", "index_delete"], ["finishSourceCandidate", "index_candidate_compare"],
    ["commitSourceState", "index_cursor"], ["commit", "index_commit"]]) {
    const original = writer[method].bind(writer);
    writer[method] = (...args) => timing.measureSync(stage, () => original(...args));
  }
  try {
    const catalog = loadCatalog(database);
    // A store that already holds facts may predate a reader index that the
    // rescan path also leans on; make it before any source is rewritten. A new
    // store builds them after its bulk load instead.
    if (catalog.size > 0) createLocalIndexSecondaryIndexes(database);
    finishPrepare();
    let infos;
    let discoveryReceipt;
    const disabled = new Set();
    for (;;) {
      const roundedHits = new Map();
      infos = await timing.measure("index_discovery",()=>discover({
        codexHome, startAt, endAt, signal, discoveryLimits,
        inspectionCache: createInspectionCache(catalog, { disabled, roundedHits }),
      }));
      const receipt = localCodexLogScanner.codexRolloutDiscoveryReceipt(infos);
      const fileIds = await timing.measure("index_file_ids",()=>resolveFileIds([...infos, ...receipt.quarantined]));
      // A cached inspection found through a rounded inode is trusted only if
      // the exact id agrees; otherwise discover again without that entry.
      const stale = [];
      for (const [path, cached] of roundedHits) {
        if (fileIds.get(path) !== cached) stale.push(path);
      }
      if (stale.length > 0) {
        for (const path of stale) disabled.add(path);
        continue;
      }
      // Discovery results are frozen; carry the exact id on copies.
      const withId = (info) => ({ ...info, fileId: fileIds.get(info.path) ?? null });
      infos = infos.map(withId);
      discoveryReceipt = { ...receipt, quarantined: receipt.quarantined.map(withId) };
      break;
    }
    const discoveredAt = performance.now();
    const result = await runRefresh({
      database, writer, deviceSalt, infos, catalog, workerCount, maximumLineBytes,
      signal, ordinalSeed, verify, now, startedAt, discoveredAt, discoveryReceipt,
      indexFile: resolvedIndexFile, walLimits, onProgress,
      timing, onReuseDiagnostic,
    });
    return result;
  } finally {
    if (database.isOpen) database.close();
  }
}

async function runRefresh({
  database, writer, deviceSalt, infos, catalog, workerCount, maximumLineBytes,
  signal, ordinalSeed, verify, now, startedAt, discoveredAt, discoveryReceipt,
  indexFile, walLimits, onProgress,
  timing, onReuseDiagnostic,
}) {
  let deferred = null;
  let walBytesPeak = 0;
  const walHardBytes = localIndexWalHardLimit(indexFile, walLimits);
  // Checked before each write transaction of the scan; see LOCAL_INDEX_WAL_LIMITS.
  function walPressure() {
    if (deferred !== null) return true;
    let bytes = 0;
    try {
      bytes = statSync(`${indexFile}-wal`).size;
    } catch {
      // No log file yet: nothing is pending.
    }
    walBytesPeak = Math.max(walBytesPeak, bytes);
    if (bytes >= walHardBytes) {
      deferred = { reason: "wal_limit", walBytes: bytes };
      return true;
    }
    return false;
  }
  const counts = {
    usageEvents: 0, quotaOccurrences: 0, sourcesSkipped: 0, sourcesNew: 0,
    sourcesResumed: 0, sourcesRescanned: 0, sourcesSemanticNoop: 0, sourcesQuarantined: 0,
    sourcesAbsent: 0, bytesScanned: 0, usageEventsRemoved: 0,
    sourcesVerified: 0, bytesVerified: 0, verificationMismatches: 0,
    discoverySourcesRejected: 0,
  };
  // Advisory, throttled progress: sources settled so far of the sources this
  // pass classified. It carries counts only and never delays or fails the scan.
  let lastProgressAtMs = Number.NEGATIVE_INFINITY;
  function reportProgress() {
    if (onProgress === null) return;
    const at = performance.now();
    if (at - lastProgressAtMs < PROGRESS_INTERVAL_MS) return;
    lastProgressAtMs = at;
    const settled = counts.sourcesSkipped + counts.sourcesQuarantined + counts.sourcesNew
      + counts.sourcesResumed + counts.sourcesRescanned;
    try {
      Promise.resolve(onProgress({
        sources: infos.length,
        sourcesScanned: Math.min(settled, infos.length),
        usageEvents: counts.usageEvents,
      })).catch(() => {});
    } catch {
      // A progress consumer that throws must not fail the refresh.
    }
  }
  const hexOf = (info) => sourceLocal(deviceSalt, sourceIdentity(info)).toString("hex");
  const sessionLocals = new Map();
  const localForSession = (sessionId) => {
    let cached = sessionLocals.get(sessionId);
    if (cached === undefined) {
      cached = sessionLocal(deviceSalt, sessionId);
      sessionLocals.set(sessionId, cached);
    }
    return cached;
  };
  const sessionIdFor = (info) => info.lineage?.sessionId ?? info.rolloutKey;

  // 1. Classify every discovered source by stat, then confirm growth by windows.
  const classification = new Map();
  const finishClassify = timing.start("index_classify");
  const verifiedSources = [];
  const contentUnchanged = [];
  // Scoped recovery version lives beside the source's committed diagnostics.
  // Do not bump the global parser and invalidate every historical source.
  const modelRecovery=readPendingResponseModelRecoverySources(database, RESPONSE_MODEL_RECOVERY_VERSION);
  for (const id of readPendingModelRecognitionSources(database)) modelRecovery.add(id);
  let modelRecoverySources=0,modelRecoveryBytes=0,modelRecoveryPending=0;
  for (const info of infos) {
    const row = catalog.get(hexOf(info));
    let decision = classifyFromStat(info, row, LOCAL_INDEX_PARSER_VERSION);
    // A timestamp change is not a fact change. Authenticate the entire committed
    // byte range before taking this path, including the incomplete last segment.
    // Missing digests, partial cursors, replacements and parser/model repairs
    // retain the ordinary replay path; quota and lineage facts stay untouched.
    if (decision.reason === "same_size_changed" && !info.compressed
        && row.quarantine_code === null && Number(row.scanned_bytes) > 0
        && Number(row.scanned_bytes) === Number(row.size_bytes)
        && !modelRecovery.has(Number(row.id))) {
      try {
        const unchanged = await withStableRolloutSource(info, async handle => {
          const stored = new Map(database.prepare(
            "SELECT segment, digest FROM source_segment WHERE source_id = ?",
          ).all(Number(row.id)).map(entry => [Number(entry.segment), entry.digest]));
          return await verifySegments(handle, stored, Number(row.scanned_bytes), { signal }) === -1
            && await windowsMatch(handle, row);
        });
        signal?.throwIfAborted();
        if (unchanged) {
          decision = { mode: "skip" };
          contentUnchanged.push({ id: Number(row.id), info });
          counts.sourcesSemanticNoop += 1;
        }
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        // An unavailable or changing source cannot authorize preservation.
      }
    }
    if(['skip','append'].includes(decision.mode)&&row?.quarantine_code===null&&modelRecovery.has(Number(row.id))){
      const bytes=Number(info.size??0);
      if(modelRecoverySources>=8||(modelRecoverySources>0&&modelRecoveryBytes+bytes>256*1024*1024)){
        modelRecoveryPending++;
        // Appending must not stamp old unknown facts as already reparsed.
        decision={mode:'skip'};
      }
      else{decision={mode:'rescan',reason:'model_attribution_recovery'};modelRecoverySources++;modelRecoveryBytes+=bytes;}
    }
    if (decision.mode === "append") {
      let handle;
      try {
        handle = await open(info.path, "r");
        if (!(await windowsMatch(handle, row))) {
          decision = { mode: "rescan", reason: "boundary_changed" };
        } else if (database.prepare('SELECT 1 FROM usage_event WHERE source_id=? AND (flags & 16)<>0 LIMIT 1').get(row.id)
            || await rolloutContainsResponseUsage(handle, { start: Number(row.scanned_bytes), end: Number(info.size), signal })) {
          decision = { mode: 'rescan', reason: 'response_reconciliation' };
        }
      } catch {
        decision = { mode: "rescan", reason: "boundary_changed" };
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    // A source registered by an interrupted cold build holds no verified
    // facts; it is new work, not a rescan, and lanes may take it.
    if (row !== undefined && row.verified_at_ms === null
        && Number(row.scanned_bytes) === 0 && row.quarantine_code === null
        && decision.mode !== "skip") {
      decision = { mode: "new" };
    }
    // Deferred verification of closed segments: a deliberate read, due at
    // most once per day per source (or when forced), never on the hot path.
    if (verify !== null && row !== undefined && !info.compressed
        && (decision.mode === "skip" || decision.mode === "append")
        && needsSegmentVerification(row, now(), { force: verify.force === true })) {
      let handle;
      try {
        handle = await open(info.path, "r");
        const stored = new Map(database.prepare(
          "SELECT segment, digest FROM source_segment WHERE source_id = ?",
        ).all(Number(row.id)).map((entry) => [Number(entry.segment), entry.digest]));
        const mismatch = await verifySegments(handle, stored, Number(row.scanned_bytes));
        counts.sourcesVerified += 1;
        counts.bytesVerified += Number(row.scanned_bytes);
        if (mismatch === -1) {
          verifiedSources.push(Number(row.id));
        } else {
          counts.verificationMismatches += 1;
          decision = { mode: "rescan", reason: "segment_mismatch" };
        }
      } catch {
        decision = { mode: "rescan", reason: "segment_mismatch" };
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    // Discovery rejected this source earlier and accepts it now; it holds no
    // facts, so it is new work.
    if (row !== undefined && DISCOVERY_QUARANTINE_CODES.includes(row.quarantine_code)) {
      decision = { mode: "new" };
    }
    classification.set(info, { ...decision, row });
  }

  finishClassify();
  const finishPlan = timing.start("index_plan");
  // Sources discovery rejects now may hold facts from when they were accepted.
  // Remove those facts, keep the catalog row (and its ordinal), and record why.
  const rejected = [];
  for (const info of discoveryReceipt.quarantined) {
    const row = catalog.get(hexOf(info));
    if (row === undefined) continue;
    const code = info.quarantineReason;
    if (Number(row.scanned_bytes) === 0 && row.quarantine_code === code) continue;
    rejected.push({ info, row, code });
  }
  if (rejected.length > 0) {
    writer.begin();
    try {
      for (const { info, row, code } of rejected) {
        counts.usageEventsRemoved += writer.deleteSourceFacts(Number(row.id));
        if (row.session_id !== null) writer.clearLineageSnapshots(Number(row.session_id));
        writer.commitSourceState(Number(row.id), {
          sessionId: row.session_id, surfaceId: row.surface_id, path: info.path,
          rolloutKey: info.rolloutKey, fileId: info.fileId ?? null,
          birthtimeMs: Number(info.birthtimeMs), sizeBytes: Number(info.size ?? 0),
          mtimeMs: Number(info.mtimeMs ?? 0), ctimeMs: Number(info.ctimeMs),
          scannedBytes: 0, quarantineCode: code, snapshotsPersisted: false,
          turnContextSeen: false, carryTotals: null, replaceSegments: true,
          diagnostics: {},
        });
        counts.discoverySourcesRejected += 1;
      }
      writer.commit({ kind: "refresh", sourcesChanged: rejected.length });
    } catch (error) {
      writer.rollback();
      throw error;
    }
  }
  if (verifiedSources.length > 0 || contentUnchanged.length > 0) {
    writer.begin();
    try {
      for (const id of verifiedSources) writer.markVerified(id, now());
      for (const { id, info } of contentUnchanged) {
        writer.markContentUnchanged(id, info);
        writer.markVerified(id, now());
      }
      writer.commit({ kind: "verify", sourcesChanged: 0, bumpSeq: false });
    } catch (error) {
      writer.rollback();
      throw error;
    }
  }

  // 2. Dependency repair and session-wide replacement, as in the shipping
  //    ingest: a changed damaged ancestor re-checks its quarantined
  //    descendants, and a replaced source re-derives its whole session.
  const components = lineageComponents(infos);
  const changedRolloutIds = new Set();
  const changedSessionIds = new Set();
  const markChanged = (info) => {
    if (typeof info.rolloutId === "string") changedRolloutIds.add(info.rolloutId);
    if (typeof info.lineage?.sessionId === "string") changedSessionIds.add(info.lineage.sessionId);
  };
  for (const info of infos) {
    const entry = classification.get(info);
    if (typeof entry.row?.quarantine_code === "string" && entry.mode !== "quarantined") {
      markChanged(info);
    }
  }
  for (const component of components) {
    for (const info of component.members) {
      const entry = classification.get(info);
      if (entry.row?.quarantine_code !== "codex_rollout_lineage_invalid"
          || entry.mode !== "quarantined") continue;
      const baseId = info.lineage?.historyBase?.rolloutId ?? null;
      const parentId = info.lineage?.parentId ?? null;
      const changed = (baseId !== null && changedRolloutIds.has(baseId))
        || (info.lineage?.isInlineFork === true && parentId !== null
          && changedSessionIds.has(parentId));
      if (!changed) continue;
      classification.set(info, {
        ...entry, mode: "rescan", reason: "dependency_quarantine_changed",
      });
      markChanged(info);
    }
  }
  const replacementSessions = new Set();
  for (const info of infos) {
    const entry = classification.get(info);
    if (entry.row !== undefined && entry.mode === "rescan"
        && REPLACEMENT_REASONS.has(entry.reason)) {
      replacementSessions.add(sessionIdFor(info));
    }
  }

  const logicalHeads = resolveLogicalRolloutHeads(infos);
  const totalWork = [];
  for (const component of components) {
    const plans = component.members.map((info) => {
      const entry = classification.get(info);
      let plan = { info, row: entry.row, mode: entry.mode, reason: entry.reason };
      if (replacementSessions.has(sessionIdFor(info)) && plan.mode !== "rescan"
          && plan.mode !== "new") {
        plan = { ...plan, mode: "rescan", reason: "session_rescan" };
      }
      return plan;
    });
    const planByInfo = new Map(plans.map((plan) => [plan.info, plan]));
    const plansBySession = new Map();
    for (const plan of plans) {
      const sessionId = plan.info.lineage?.sessionId;
      if (!sessionId) continue;
      const list = plansBySession.get(sessionId) ?? [];
      list.push(plan);
      plansBySession.set(sessionId, list);
    }
    // Fork-boundary durability: a fork about to be scanned needs its
    // ancestors' persisted snapshot sets. An ancestor scanned before anything
    // forked from it has none, so it is rescanned once.
    const queue = [];
    const queued = new Set();
    const enqueue = (plan) => {
      if (queued.has(plan) || ["skip", "quarantined"].includes(plan.mode)
          || plan.info.lineage?.isInlineFork !== true) return;
      queued.add(plan);
      queue.push(plan);
    };
    const rescanSession = (sessionId) => {
      for (const plan of plansBySession.get(sessionId) ?? []) {
        if (plan.mode !== "rescan" && plan.mode !== "new") {
          plan.mode = "rescan";
          plan.reason = "session_rescan";
        }
        enqueue(plan);
      }
    };
    for (const plan of plans) enqueue(plan);
    const required = new Set();
    for (let index = 0; index < queue.length; index += 1) {
      let parentId = queue[index].info.lineage?.parentId ?? null;
      while (parentId && !required.has(parentId)) {
        required.add(parentId);
        const parent = logicalHeads.get(parentId);
        const ancestor = planByInfo.get(parent);
        if (ancestor !== undefined
            && ["skip", "append"].includes(ancestor.mode)
            && Number(ancestor.row?.snapshots_persisted ?? 0) !== 1) {
          ancestor.mode = "rescan";
          ancestor.reason = "snapshot_persistence";
          rescanSession(parentId);
        }
        if (parent?.lineage?.historyMode === "paginated") break;
        parentId = parent?.lineage?.parentId ?? null;
      }
    }
    totalWork.push({ component, plans });
  }

  // Lanes take whole lineage components that are entirely new: their seeds are
  // produced in-lane, and no existing source is replaced, so nothing readers
  // can see is rewritten. Everything else runs sequentially.
  finishPlan();
  for (const { plans } of totalWork) for (const plan of plans) {
    if (plan.mode === "rescan") reportLocalRefreshReuseDiagnostic(onReuseDiagnostic, "index", `rescan_${plan.reason ?? "other"}`);
  }
  const isUnchanged = (plan) => plan.mode === "skip" || plan.mode === "quarantined";
  const laneComponents = totalWork.filter(({ plans }) => (
    plans.every((plan) => plan.mode === "new")
  ));
  const everyComponentFits = totalWork.every(({ plans }) => (
    plans.every(isUnchanged) || plans.every((plan) => plan.mode === "new")
  ));
  const newBytes = laneComponents.flatMap(({ plans }) => plans)
    .reduce((sum, plan) => sum + Number(plan.info.size ?? 0), 0);
  const useLanes = everyComponentFits && newBytes > 0
    && (workerCount !== null ? workerCount > 1 : newBytes >= PARALLEL_BACKLOG_BYTES);
  const lanes = useLanes ? (workerCount ?? defaultLocalIndexWorkerCount()) : 1;

  // 3. Ordinals: existing sources keep theirs; new ones are allocated above the
  //    maximum in a deterministic order (or taken from the carried seed).
  const newInfos = totalWork.flatMap(({ plans }) => plans)
    .filter((plan) => plan.mode === "new" && plan.row === undefined)
    .map((plan) => plan.info)
    .toSorted((left, right) => (
      left.rolloutKey.localeCompare(right.rolloutKey) || left.path.localeCompare(right.path)
    ));

  // Rollout logs carry no account identity; the scope row is interned lazily,
  // inside the first transaction that writes an event.
  const sink = createFactSink({
    writer,
    deviceSalt,
    accountScope: {
      status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null,
    },
    counts,
  });

  const summaryBefore = { transactions: writer.transactions };
  const sourceStates = new Map();

  function registerNew(info) {
    const surface = surfaceRow(info.lineage?.surfaceClassification);
    const local = sourceLocal(deviceSalt, sourceIdentity(info));
    const sessionId = sessionIdFor(info);
    const seeded = ordinalSeed?.get(local.toString("hex"));
    const session = writer.internSession(localForSession(sessionId), sessionId);
    const surfaceId = writer.internSurface(surface);
    const registered = writer.registerSource({
      sourceLocal: local,
      ordinal: seeded,
      sessionId: session,
      surfaceId,
      path: info.path,
      rolloutKey: info.rolloutKey,
      fileId: info.fileId ?? null,
      birthtimeMs: Number.isFinite(Number(info.birthtimeMs)) ? Number(info.birthtimeMs) : null,
      sizeBytes: Number(info.size ?? 0),
      mtimeMs: Number(info.mtimeMs ?? 0),
      ctimeMs: Number.isFinite(Number(info.ctimeMs)) ? Number(info.ctimeMs) : null,
      lineageJson: inspectionRecord(info),
    });
    return {
      sourceId: registered.id,
      ordinal: registered.ordinal,
      sourceLocal: local,
      sessionId: session,
      surfaceId,
      surface,
    };
  }

  function stateFor(info, row) {
    const cached = sourceStates.get(info);
    if (cached !== undefined) return cached;
    let state;
    if (row === undefined) {
      state = registerNew(info);
    } else {
      const surface = surfaceRow(info.lineage?.surfaceClassification);
      const session = writer.internSession(
        localForSession(sessionIdFor(info)), sessionIdFor(info),
      );
      state = {
        sourceId: Number(row.id),
        ordinal: Number(row.source_ordinal),
        sourceLocal: Buffer.from(row.source_local),
        sessionId: session,
        surfaceId: writer.internSurface(surface),
        surface,
      };
    }
    sourceStates.set(info, state);
    return state;
  }

  function cursorState(info, state, outcome, extra = {}) {
    return {
      sessionId: state.sessionId,
      surfaceId: state.surfaceId,
      path: info.path,
      rolloutKey: info.rolloutKey,
      fileId: info.fileId ?? null,
      birthtimeMs: Number.isFinite(Number(info.birthtimeMs)) ? Number(info.birthtimeMs) : null,
      sizeBytes: Number(info.size ?? 0),
      mtimeMs: Number(info.mtimeMs ?? 0),
      ctimeMs: Number.isFinite(Number(info.ctimeMs)) ? Number(info.ctimeMs) : null,
      lineageJson: inspectionRecord(info),
      ...outcome,
      ...extra,
      diagnostics: {
        ...(extra.diagnostics ?? outcome.diagnostics ?? {}),
        modelRecognitionVersion: LOCAL_INDEX_MODEL_RECOGNITION_VERSION,
      },
    };
  }

  const quarantineState = (info, state, reason, diagnostics = {}) => cursorState(info, state, {
    scannedBytes: 0,
    quarantineCode: reason,
    snapshotsPersisted: false,
    turnContextSeen: false,
    carryTotals: null,
    diagnostics,
  });

  // Dependency gating shared by both executors.
  const invalidRolloutIds = new Set();
  const invalidSessionIds = new Set();
  // Quarantined sources that are no longer discovered remain an honest gap
  // and keep blocking dependents; discovered ones are decided by their plan.
  const currentKeys = new Set([
    ...infos.map(hexOf),
    ...discoveryReceipt.quarantined.map(hexOf),
  ]);
  const retainedInvalid = new Set();
  for (const [hex, row] of catalog) {
    if (typeof row.quarantine_code === "string" && !currentKeys.has(hex)) {
      retainedInvalid.add(hex);
    }
  }
  function dependencyUnavailable(info) {
    const baseId = info.lineage?.historyBase?.rolloutId ?? null;
    if (baseId !== null && (invalidRolloutIds.has(baseId)
        || retainedInvalid.has(sourceLocal(deviceSalt, baseId).toString("hex")))) return true;
    const parentId = info.lineage?.parentId ?? null;
    return info.lineage?.isInlineFork === true && parentId !== null
      && invalidSessionIds.has(parentId);
  }
  function markUnavailable(info) {
    if (typeof info.rolloutId === "string") invalidRolloutIds.add(info.rolloutId);
    if (typeof info.lineage?.sessionId === "string") invalidSessionIds.add(info.lineage.sessionId);
  }

  // Allocate ordinals for every new source up front, in a deterministic
  // order, so they do not depend on filesystem walk order or lane timing.
  if (ordinalSeed !== null && ordinalSeed.size > 0) {
    writer.reserveOrdinalsAbove(Math.max(...ordinalSeed.values()));
  }
  if (newInfos.length > 0) {
    writer.begin();
    try {
      for (const info of newInfos) stateFor(info, undefined);
      writer.commit({ bumpSeq: false });
    } catch (error) {
      writer.rollback();
      throw error;
    }
  }

  if (!useLanes) {
    await timing.measure("index_execute",()=>runSequential());
  } else {
    await timing.measure("index_execute",()=>runLanes());
  }
  const finishPost = timing.start("index_post");
  if (deferred === null) createLocalIndexSecondaryIndexes(database);
  if(deferred===null&&modelRecoveryPending>0)deferred={reason:'model_attribution_recovery',pendingSources:modelRecoveryPending};

  // 4. Reconcile discovery presence independently of fact changes. An
  // unchanged source can reappear after a narrower discovery window.
  const discovered = new Set([
    ...infos.map(hexOf),
    ...discoveryReceipt.quarantined.map(hexOf),
  ]);
  const absent = [...catalog.entries()]
    .filter(([hex, row]) => !discovered.has(hex) && row.presence !== "absent");
  const reappeared = [...catalog.entries()]
    .filter(([hex, row]) => discovered.has(hex) && row.presence === "absent");
  if (absent.length > 0 || reappeared.length > 0) {
    if (signal?.aborted) throw fixedError("local_index_aborted");
    writer.begin();
    try {
      let restored = 0;
      for (const [, row] of reappeared) restored += writer.markPresent(Number(row.id));
      for (const [, row] of absent) writer.markAbsent(Number(row.id));
      writer.commit({ kind: "refresh", sourcesChanged: absent.length + restored,
        bumpSeq: absent.length + restored > 0 });
    } catch (error) {
      writer.rollback();
      throw error;
    }
    counts.sourcesAbsent = absent.length;
  }

  const finished = performance.now();
  finishPost();
  return {
    status: deferred === null ? "refreshed" : "deferred",
    deferred,
    walBytesPeak,
    walPinned: walBytesPeak >= walLimits.softBytes,
    unchanged: writer.transactions === summaryBefore.transactions,
    mode: useLanes ? "lanes" : "sequential",
    laneCount: lanes,
    sources: infos.length,
    ...counts,
    discoveredSourceBytes: discoveryReceipt.discoveredSourceBytes,
    skippedSourceCount: discoveryReceipt.skippedSourceCount,
    writeTransactions: writer.transactions,
    discoveryWallMs: discoveredAt - startedAt,
    scanWallMs: finished - discoveredAt,
    wallMs: finished - startedAt,
    peakRssBytes: process.memoryUsage.rss(),
  };

  // ------------------------------------------------------------------------
  async function runSequential() {
    const finalBySessionId = new Map();
    const lineageTierSeeds = new Map();
    const rowFor = (info) => catalog.get(hexOf(info));
    const selectSnapshot = database.prepare(`
      SELECT 1 AS present FROM lineage_snapshot l
      JOIN session s ON s.id = l.session_id
      WHERE s.session_local = ? AND l.snapshot_local = ? LIMIT 1`);
    const parentModels = createParentModelResolver(infos, { maximumLineBytes, signal });
    const historySeeds = createHistoryBaseSeedResolver(infos, { maximumLineBytes, signal });

    async function lineageSeedTier(info) {
      const visited = [];
      const seen = new Set();
      let parentId = info.lineage?.parentId ?? null;
      let resolved = null;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        visited.push(parentId);
        if (lineageTierSeeds.has(parentId)) {
          resolved = lineageTierSeeds.get(parentId);
          break;
        }
        const scanned = finalBySessionId.get(parentId);
        if (scanned !== undefined) {
          if (scanned.tier !== null && scanned.tier !== undefined) {
            resolved = inheritedTierSeed(scanned.tier);
          }
          break;
        }
        const parent = logicalHeads.get(parentId);
        const row = parent === undefined ? undefined : rowFor(parent);
        const carried = row === undefined ? null : carriedTier(row);
        if (carried !== null) {
          resolved = inheritedTierSeed(carried);
          break;
        }
        if (parent?.lineage?.historyMode === "paginated") {
          const exact = parent.lineage.historyBase == null
            ? null
            : await historySeeds.resolveSeed(parent);
          resolved = inheritedTierSeed(exact?.seedTier ?? null);
          break;
        }
        parentId = parent?.lineage?.parentId ?? null;
      }
      for (const sessionId of visited) lineageTierSeeds.set(sessionId, resolved);
      return resolved;
    }

    function seedForNew(info) {
      const parentId = info.lineage?.parentId;
      if (!parentId) return { seedModel: null, seedEffort: null };
      const scanned = finalBySessionId.get(parentId);
      if (scanned !== undefined) return { seedModel: scanned.model, seedEffort: scanned.effort };
      const parent = logicalHeads.get(parentId);
      const row = parent === undefined ? undefined : rowFor(parent);
      if (row === undefined) return { seedModel: null, seedEffort: null };
      return { seedModel: row.carry_model ?? null, seedEffort: row.carry_effort ?? null };
    }

    function ancestorSessionLocals(info) {
      const chain = [];
      const seen = new Set();
      let parentId = info.lineage?.parentId ?? null;
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        chain.push(localForSession(parentId));
        const parent = logicalHeads.get(parentId);
        if (parent?.lineage?.historyMode === "paginated") break;
        parentId = parent?.lineage?.parentId ?? null;
      }
      return chain;
    }

    for (const { component, plans } of totalWork) {
      const needsWork = plans.some((plan) => !["skip", "quarantined"].includes(plan.mode))
        || plans.some((plan) => dependencyUnavailable(plan.info));
      if (!needsWork) {
        for (const plan of plans) {
          counts[plan.mode === "quarantined" ? "sourcesQuarantined" : "sourcesSkipped"] += 1;
          const row = plan.row;
          if (row?.quarantine_code) retainedInvalid.add(hexOf(plan.info));
        }
        continue;
      }
      const snapshots = createLineageSnapshots(component.members);
      try {
        for (let sourceIndex = 0; sourceIndex < plans.length; sourceIndex += 1) {
          const plan = plans[sourceIndex];
          if (signal?.aborted) throw fixedError("local_index_aborted");
          const { info, row, mode } = plan;
          if (mode === "quarantined") {
            counts.sourcesQuarantined += 1;
            markUnavailable(info);
            continue;
          }
          if (mode === "skip" && !dependencyUnavailable(info)) {
            counts.sourcesSkipped += 1;
            continue;
          }
          if (walPressure()) return;
          // Reconciliation runs before emitting facts. If an append discovers
          // own-response history missed by the classification hint, roll back
          // and retry from the full source with fresh seeds and segment digests.
          const countsBeforeCandidate = { ...counts };
          writer.begin();
          try {
            const state = stateFor(info, row);
            if (dependencyUnavailable(info)) {
              counts.usageEventsRemoved += writer.deleteSourceFacts(state.sourceId);
              writer.commitSourceState(state.sourceId, quarantineState(
                info, state, "codex_rollout_lineage_invalid",
              ));
              markUnavailable(info);
              counts.sourcesQuarantined += 1;
              writer.commit({ kind: "refresh" });
              continue;
            }
            const resuming = mode === "append";
            const candidate = !resuming && row !== undefined && plan.candidateDisabled !== true
              && writer.beginSourceCandidate(state.sourceId);
            if (!resuming && row !== undefined && !candidate) {
              counts.usageEventsRemoved += writer.deleteSourceFacts(state.sourceId);
              if (replacementSessions.has(sessionIdFor(info))) {
                writer.clearLineageSnapshots(state.sessionId);
              }
            }
            const paginated = info.lineage?.historyMode === "paginated";
            const ownTier = resuming ? carriedTier(row) : null;
            const logicalSeed = paginated || resuming ? null : {
              ...seedForNew(info),
              seedTier: await lineageSeedTier(info),
            };
            const cursorSeed = resuming ? {
              seedModel: row.carry_model ?? null,
              seedEffort: row.carry_effort ?? null,
              seedTier: ownTier ?? (paginated ? null : await lineageSeedTier(info)),
              seedTotals: carriedTotals(row),
            } : null;
            const collector = snapshots.collectorFor(info);
            const needsHistorySeed = !resuming || (paginated && ownTier === null
              && info.lineage?.historyBase != null);
            const historySeed = needsHistorySeed
              ? await historySeeds.resolveSeed(info, {
                includeSnapshots: !resuming && collector !== null,
              })
              : null;
            const selectedSeed = selectRolloutUsageSeed(info, {
              historySeed, logicalSeed, cursorSeed,
            });
            const memoryInherited = snapshots.inheritedFor(info);
            const ancestors = info.lineage?.isInlineFork === true
              ? ancestorSessionLocals(info)
              : [];
            const inherited = ancestors.length === 0 ? memoryInherited : {
              has: (key) => {
                if (memoryInherited?.has(key) === true) return true;
                const digest = snapshotLocal(deviceSalt, key);
                return ancestors.some((ancestor) => (
                  selectSnapshot.get(ancestor, digest) !== undefined
                ));
              },
            };
            const startOffset = resuming ? Number(row.scanned_bytes) : 0;
            if (!resuming && collector !== null
                && snapshots.replaceFor(info, historySeed?.seedSnapshots ?? [])) {
              writer.clearLineageSnapshots(state.sessionId);
              for (const key of historySeed?.seedSnapshots ?? []) {
                writer.addLineageSnapshot(state.sessionId, snapshotLocal(deviceSalt, key));
              }
            }
            const parentModelAt = selectedSeed.seedModel === null
              ? await parentModels.forSource(info) : null;
            const { outcome, tapSegments, windows } = await withStableRolloutSource(
              info,
              async (handle) => {
                const tap = info.compressed === true
                  ? null
                  : await createSegmentTap(handle, { startOffset });
                const extracted = await timing.measure("index_extract",()=>extractRolloutUsage(tap?.handle ?? handle, {
                  responseSource: handle,
                  size: Number(info.size ?? 0),
                  startOffset,
                  isFork: info.lineage?.isInlineFork === true,
                  inheritedSnapshots: info.lineage?.isInlineFork === true ? inherited : null,
                  collectSnapshots: collector === null ? null : {
                    add(key) {
                      collector.add(key);
                      writer.addLineageSnapshot(state.sessionId, snapshotLocal(deviceSalt, key));
                    },
                  },
                  ...selectedSeed,
                  parentModelAt,
                  seedCompactionPending: resuming ? carriedCompaction(row) : null,
                  seedTurnContextPending: resuming && Number(row.turn_context_pending) === 1,
                  seedTurnContextSeen: resuming && Number(row.turn_context_seen) === 1,
                  seedCwd: resuming ? writer.workDirectoryPath(row.carry_work_directory_id) : null,
                  ...(maximumLineBytes === undefined ? {} : { maximumLineBytes }),
                  signal,
                  onEvent: (event) => sink.write(state, event),
                  onBoundary: (event) => sink.writeBoundary(state, event),
                  onTool: (event) => sink.writeTool(state, event),
                  onWork: (event) => sink.writeWork(state, event),
                }));
                return {
                  outcome: extracted,
                  tapSegments: tap?.finish(extracted.read.nextOffset) ?? null,
                  windows: await digestWindows(handle, extracted.read.nextOffset),
                };
              },
            );
            if (signal?.aborted || outcome.read.aborted === true) {
              throw fixedError("local_index_aborted");
            }
            sink.finishSource(state);
            const diagnostics = {
              ...outcome.diagnostics,
              oversizedLines: outcome.read.oversizedLines,
              deferredTailBytes: outcome.read.partialDeferred
                ? Number(info.size) - outcome.read.nextOffset : 0,
              contradictedLeadingSnapshotsSkipped: sink.suppressedFor(state),
            };
            if (candidate) {
              if (rolloutContentQuarantineReason(outcome) !== null) throw fixedError("local_index_candidate_replay_required");
              writer.finishSourceCandidate();
              counts.usageEvents = countsBeforeCandidate.usageEvents;
              counts.sourcesSemanticNoop += 1;
            }
            const quarantineReason = rolloutContentQuarantineReason(outcome);
            if (quarantineReason !== null) {
              counts.usageEventsRemoved += writer.deleteSourceFacts(state.sourceId);
              sink.discardSource(state);
              writer.commitSourceState(state.sourceId, quarantineState(
                info, state, quarantineReason, diagnostics,
              ));
              markUnavailable(info);
              counts.sourcesQuarantined += 1;
              writer.commit({ kind: "refresh" });
              continue;
            }
            if (info.lineage?.sessionId && logicalHeads.get(info.lineage.sessionId) === info) {
              finalBySessionId.set(info.lineage.sessionId, {
                model: outcome.finalModel, effort: outcome.finalEffort, tier: outcome.finalTier,
              });
            }
            const verifiedNow = now();
            writer.commitSourceState(state.sourceId, cursorState(info, state, {
              scannedBytes: outcome.read.nextOffset,
              headDigest: windows.head,
              boundaryDigest: windows.boundary,
              tailDigest: windows.tail,
              // Full reads (new or rescanned) verify everything below `complete`;
              // a resume keeps the older verification point for the old prefix.
              verifiedAtMs: resuming ? row.verified_at_ms : verifiedNow,
              verifiedBytes: resuming ? Number(row.verified_bytes) : outcome.read.nextOffset,
              quarantineCode: null,
              snapshotsPersisted: collector !== null
                && (startOffset === 0 || Number(row?.snapshots_persisted ?? 0) === 1),
              turnContextSeen: outcome.finalTurnContextSeen,
              carryModel: outcome.finalModel,
              carryEffort: outcome.finalEffort,
              carryTierRaw: ownObservedTier(outcome.finalTier)?.providerTierRaw ?? null,
              carryTierObservedAtMs: ownObservedTier(outcome.finalTier)?.observedAtMs ?? null,
              carryTierSource: ownObservedTier(outcome.finalTier)?.tierSource ?? null,
              carryTotals: outcome.finalTotals,
              carryWorkDirectoryId: writer.internWorkDirectory(outcome.finalCwd ?? null),
              compactionPending: outcome.finalCompactionPending,
              turnContextPending: outcome.finalTurnContextPending,
              segments: tapSegments ?? undefined,
              replaceSegments: !resuming,
              diagnostics,
            }));
            counts.bytesScanned += Math.max(0, outcome.read.nextOffset - startOffset);
            counts[mode === "new" ? "sourcesNew" : resuming ? "sourcesResumed" : "sourcesRescanned"] += 1;
            writer.commit({ kind: "refresh" });
            reportProgress();
          } catch (error) {
            writer.rollback();
            if (error?.code === "local_index_candidate_replay_required") {
              plan.candidateDisabled = true;
              sink.discardSource(sourceStates.get(info));
              sourceStates.delete(info);
              Object.assign(counts, countsBeforeCandidate);
              sourceIndex -= 1;
              continue;
            }
            if (mode === "append" && error?.code === "codex_response_usage_rescan_required") {
              reportLocalRefreshReuseDiagnostic(onReuseDiagnostic, "index", "rescan_response_reconciliation");
              plan.mode = "rescan";
              plan.candidateDisabled = true;
              sourceIndex -= 1;
              continue;
            }
            throw error;
          }
        }
      } finally {
        snapshots.release();
      }
    }
  }

  async function runLanes() {
    const sourcesByKey = new Map(infos.map((info) => [info.rolloutKey, info]));
    for (const { plans } of totalWork) {
      for (const plan of plans) {
        if (plan.mode === "skip") counts.sourcesSkipped += 1;
        if (plan.mode === "quarantined") counts.sourcesQuarantined += 1;
      }
    }
    // Resolve state (including pre-registered rows) before lanes start.
    writer.begin();
    try {
      for (const { plans } of laneComponents) {
        for (const plan of plans) stateFor(plan.info, plan.row);
      }
      writer.commit({ bumpSeq: false });
    } catch (error) {
      writer.rollback();
      throw error;
    }
    const assigned = balanceComponents(
      laneComponents.map(({ component }) => component),
      lanes,
    );
    await Promise.all(assigned.map((lane) => runWorkerLane(lane, {
      maximumLineBytes,
      signal,
      onBatch: (message) => {
        if (walPressure()) throw fixedError("local_index_wal_limit");
        if (message.final === true && message.quarantineReason == null) {
          validateLocalIndexWorkerCursor(message.cursor);
        }
        const info = sourcesByKey.get(message.rolloutKey);
        if (info === undefined) return;
        const state = sourceStates.get(info);
        writer.begin();
        try {
          if (message.snapshotReset === true) {
            writer.clearLineageSnapshots(state.sessionId);
            for (const key of message.snapshotSeedKeys ?? []) {
              writer.addLineageSnapshot(state.sessionId, snapshotLocal(deviceSalt, key));
            }
          }
          for (const event of message.events) sink.write(state, event);
          for (const event of message.boundaries ?? []) sink.writeBoundary(state, event);
          for (const event of message.tools ?? []) sink.writeTool(state, event);
          for (const event of message.work ?? []) sink.writeWork(state, event);
          for (const key of message.snapshotKeys ?? []) {
            writer.addLineageSnapshot(state.sessionId, snapshotLocal(deviceSalt, key));
          }
          if (message.final === true) {
            sink.finishSource(state);
            const diagnostics = {
              ...message.diagnostics,
              contradictedLeadingSnapshotsSkipped: sink.suppressedFor(state),
            };
            if (typeof message.quarantineReason === "string") {
              counts.usageEventsRemoved += writer.deleteSourceFacts(state.sourceId);
              sink.discardSource(state);
              writer.commitSourceState(state.sourceId, quarantineState(
                info, state, message.quarantineReason, diagnostics,
              ));
              markUnavailable(info);
              counts.sourcesQuarantined += 1;
            } else {
              const cursor = message.cursor;
              if (cursor === null || cursor === undefined) {
                // A dependency-gated source: no scan happened.
                writer.commitSourceState(state.sourceId, quarantineState(
                  info, state, "codex_rollout_lineage_invalid", diagnostics,
                ));
                counts.sourcesQuarantined += 1;
              } else {
                writer.commitSourceState(state.sourceId, cursorState(info, state, {
                  scannedBytes: cursor.nextOffset,
                  headDigest: cursor.windows?.head ? Buffer.from(cursor.windows.head) : null,
                  boundaryDigest: cursor.windows?.boundary
                    ? Buffer.from(cursor.windows.boundary) : null,
                  tailDigest: cursor.windows?.tail ? Buffer.from(cursor.windows.tail) : null,
                  verifiedAtMs: now(),
                  verifiedBytes: cursor.nextOffset,
                  quarantineCode: null,
                  snapshotsPersisted: cursor.snapshotsPersisted === true,
                  turnContextSeen: cursor.turnContextSeen === true,
                  carryModel: cursor.finalModel,
                  carryEffort: cursor.finalEffort,
                  carryTierRaw: cursor.finalTierRaw,
                  carryTierObservedAtMs: cursor.finalTierObservedAtMs,
                  carryTierSource: cursor.finalTierSource,
                  carryTotals: cursor.finalTotals,
                  carryWorkDirectoryId: writer.internWorkDirectory(cursor.finalCwd ?? null),
                  compactionPending: cursor.finalCompactionPending,
                  turnContextPending: cursor.finalTurnContextPending,
                  segments: cursor.segments === null || cursor.segments === undefined
                    ? undefined
                    : new Map(cursor.segments.map(([index, digest]) => [index, Buffer.from(digest)])),
                  replaceSegments: true,
                  diagnostics,
                }));
                counts.bytesScanned += cursor.nextOffset;
                counts.sourcesNew += 1;
              }
            }
          }
          writer.commit({ kind: "cold", sourcesChanged: message.final === true ? 1 : 0,
            bumpSeq: message.final === true });
          if (message.final === true) reportProgress();
        } catch (error) {
          writer.rollback();
          throw error;
        }
      },
    }))).catch((error) => {
      // A lane stopped by the log limit is a deferral, not a failure.
      if (!(deferred !== null && error?.code === "local_index_wal_limit")) throw error;
    });
  }
}

export function localIndexFilesFor(root) {
  const file = defaultLocalIndexFile(root);
  return { indexFile: file, walFile: `${file}-wal`, shmFile: `${file}-shm`,
    secretFile: join(dirname(file), "local-unified-index-device-salt-v1") };
}
