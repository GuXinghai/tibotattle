import { lstatSync } from "node:fs";
import { setImmediate as cooperativeYield } from "node:timers/promises";
import { codexCacheReasoningConfiguration } from "@app-usagemonitor/telemetry-contract";

import { REASONING_EFFORTS, reasoningEffortOrdinal } from "./codex-usage-vocabulary.js";
import { readLocalIndexGenerationIdentity } from "./local-index-companion-source.js";
import {
  LOCAL_INDEX_PARSER_VERSION,
  openLocalIndexStore,
} from "./local-index-store.js";
import { readCodexLocalThreadMetadata } from "./platform/index.js";

export const LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA = "local-cache-drop-thread-links-v1";
const MAX_REFERENCES = 2_000;
const MAX_RECENT_ROWS = 250;
export const MAX_CANDIDATES_PER_REFERENCE = 8;
export const MAX_SESSION_ROWS = 25_000;
export const MAX_TOTAL_SESSION_ROWS = 100_000;
export const FUTURE_EVIDENCE_TOLERANCE_MS = 5 * 60_000;
const PERIODS = new Set(["24h", "7d", "30d", "all"]);
const KINDS = new Set(["switch", "continuity"]);
const EFFORTS = new Set(REASONING_EFFORTS.filter((value) => value !== "unknown"));
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function generationNumber(value) {
  if (typeof value !== "number"
      && (typeof value !== "string" || value.length > 32
        || !/^[1-9]\d*(?:\.0+)?$/u.test(value))) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function configuration(value) {
  return object(value) && typeof value.model === "string"
    && value.model.length > 0 && value.model.length <= 200
    && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/u.test(value.model)
    && EFFORTS.has(value.reasoningEffort);
}

function referenceFor(kind, row) {
  if (!KINDS.has(kind) || !object(row)) return null;
  const previous = kind === "switch" ? row.previous : row.configuration;
  const current = kind === "switch" ? row.current : row.configuration;
  if (!configuration(previous) || !configuration(current)
      || typeof row.observedAt !== "string" || row.observedAt.length !== 24
      || !count(row.previousCacheReadTokens) || !count(row.currentCacheReadTokens)
      || !count(row.lostCacheTokens) || row.lostCacheTokens < 1
      || row.currentCacheReadTokens > row.previousCacheReadTokens / 2
      || row.lostCacheTokens > row.previousCacheReadTokens - row.currentCacheReadTokens
      || typeof row.gapSeconds !== "number" || !Number.isFinite(row.gapSeconds)
      || row.gapSeconds < 0) return null;
  const observedMs = Date.parse(row.observedAt);
  const gapMs = Math.round(row.gapSeconds * 1_000);
  if (!count(observedMs) || new Date(observedMs).toISOString() !== row.observedAt
      || !count(gapMs) || gapMs / 1_000 !== row.gapSeconds
      || observedMs < gapMs) return null;
  const key = JSON.stringify([
    kind, row.observedAt, row.gapSeconds,
    previous.model, previous.reasoningEffort,
    current.model, current.reasoningEffort,
    row.previousCacheReadTokens, row.currentCacheReadTokens, row.lostCacheTokens,
  ]);
  return {
    kind, key, observedMs, gapMs,
    previousModel: previous.model,
    previousEffort: reasoningEffortOrdinal(previous.reasoningEffort),
    currentModel: current.model,
    currentEffort: reasoningEffortOrdinal(current.reasoningEffort),
    previousCacheReadTokens: row.previousCacheReadTokens,
    currentCacheReadTokens: row.currentCacheReadTokens,
    lostCacheTokens: row.lostCacheTokens,
  };
}

/** Stable, anonymous key shared with the browser's local-only lookup map. */
export function cacheDropThreadLookupKey(kind, row) {
  return referenceFor(kind, row)?.key ?? null;
}

export function selectedReferences(overview) {
  const found = new Map();
  for (const [kind, impact] of [
    ["switch", overview?.accounting?.cacheSwitchImpact],
    ["continuity", overview?.accounting?.cacheContinuityImpact],
  ]) {
    if (!object(impact) || impact.status !== "available") continue;
    const periods = Array.isArray(impact.periods)
      ? impact.periods.slice(0, PERIODS.size).filter((period) => PERIODS.has(period?.periodId))
      : [];
    for (const period of [impact, ...periods]) {
      if (!Array.isArray(period.recent)) continue;
      for (const row of period.recent.slice(0, MAX_RECENT_ROWS)) {
        const reference = referenceFor(kind, row);
        if (reference !== null && !found.has(reference.key)) {
          if (found.size === MAX_REFERENCES) return [...found.values()];
          found.set(reference.key, reference);
        }
      }
    }
  }
  return [...found.values()];
}

export function unavailable() {
  return {
    schemaVersion: LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA,
    status: "unavailable",
    generation: null,
    entries: [],
  };
}

function safeName(value, maximumLength = 512) {
  if (typeof value !== "string" || value.length > maximumLength
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  return value.trim().length > 0 ? value.trim() : null;
}

export function safeThread(id, metadata) {
  const selected = metadata?.id === id;
  const parentId = typeof metadata?.parent?.id === "string"
      && THREAD_ID.test(metadata.parent.id)
    ? metadata.parent.id.toLowerCase()
    : null;
  const thread = {
    id,
    name: selected ? safeName(metadata.name) : null,
    nickname: selected ? safeName(metadata.nickname, 80) : null,
    parent: !selected || parentId === null || parentId === id
      ? null
      : { id: parentId, name: safeName(metadata.parent.name) },
  };
  // This is source classification supplied only by the bounded local Codex
  // metadata resolver. It changes navigation presentation, never cache-drop
  // matching or any accounting DTO.
  if (selected && metadata.origin === "auto_review") thread.origin = "auto_review";
  return thread;
}

function sameObservedDimension(left, right) {
  return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left === right;
}

export function previousConfigurationMatches(reference, previous, current) {
  if (reference.kind === "switch") {
    // Switch details preserve both raw labels, so an equivalent alias is not
    // sufficient to identify that specific prior configuration.
    return previous.reasoning_effort === reference.previousEffort;
  }
  // Continuity details expose only the current label. Match the analyzer's
  // model-specific request-effort boundary, not an inferred backend update.
  // A different observed tier or surface is not cache continuity. Tests
  // pin this to sameContinuityConfiguration without widening the anonymous DTO.
  const previousEffort = codexCacheReasoningConfiguration(
    reference.currentModel, REASONING_EFFORTS[previous.reasoning_effort],
  );
  const currentEffort = codexCacheReasoningConfiguration(
    reference.currentModel, REASONING_EFFORTS[reference.currentEffort],
  );
  return previousEffort === currentEffort
    && sameObservedDimension(previous.tier_id, current.tier_id)
    && sameObservedDimension(previous.surface_id, current.surface_id);
}


// Cache-drop thread links over the v2 store.
//
// The same lookup the previous index served: a bounded set of recent cache
// drops already present in one attested snapshot is matched back to the single
// rollout event that produced it, and only then to a thread. Matching rules,
// limits and the response shape are shared with the previous implementation;
// only the row source differs. Two things are stricter here by construction:
// every fact must be at or below its source's cursor, and a session that
// spans more than one source is not ordered across them (adjacency is per
// source), so it never links.

const UNINSPECTED_SESSION = Symbol("uninspected_session");
const COMMITTED = "u.source_offset <= (SELECT scanned_bytes FROM source WHERE id = u.source_id)";
const POSITIVE_INPUT = `COALESCE(u.tokens_in_uncached, 0)
  + COALESCE(u.tokens_in_cache_read, 0) + COALESCE(u.tokens_in_cache_write, 0) > 0`;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function readSelectedMatches(database, references, futureLimitMs) {
  const candidates = database.prepare(`
    SELECT u.source_id, u.source_offset, u.session_id,
           b.compaction_before, b.turn_context_before
    FROM usage_event u INDEXED BY usage_event_observed
    LEFT JOIN usage_event_boundary b
      ON b.source_id = u.source_id AND b.source_offset = u.source_offset
    WHERE u.observed_at_ms = ?
      AND u.model_id = (SELECT id FROM model WHERE model_id = ? AND recognition = 'recognized')
      AND u.reasoning_effort = ? AND u.tokens_in_cache_read = ?
      AND ${POSITIVE_INPUT}
      AND ${COMMITTED}
    LIMIT ?`);
  const sessionRows = database.prepare(`
    SELECT u.source_id, u.source_offset, u.observed_at_ms, u.model_id,
           u.reasoning_effort, u.tier_id, u.surface_id, u.tokens_in_cache_read,
           u.tokens_in_uncached, u.tokens_in_cache_write
    FROM usage_event u INDEXED BY usage_event_session
    WHERE u.session_id = ? AND u.observed_at_ms <= ? AND ${POSITIVE_INPUT}
      AND ${COMMITTED}
    LIMIT ?`);
  const model = database.prepare(
    "SELECT model_id FROM model WHERE id = ? AND recognition = 'recognized'",
  );
  const parserOf = database.prepare("SELECT parser_version FROM source WHERE id = ?");
  const identity = database.prepare("SELECT session_uuid FROM session WHERE id = ?");
  const sessions = new Map();
  let totalRows = 0;

  const currentParser = (sourceId) => (
    parserOf.get(sourceId)?.parser_version === LOCAL_INDEX_PARSER_VERSION
  );

  async function orderedSession(sessionId) {
    if (!count(sessionId)) return null;
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    // Budget exhaustion means unknown, not proof that this session could not
    // produce the tuple; keep that distinction for every later reference.
    sessions.set(sessionId, UNINSPECTED_SESSION);
    if (totalRows >= MAX_TOTAL_SESSION_ROWS) return UNINSPECTED_SESSION;
    const limit = Math.min(MAX_SESSION_ROWS, MAX_TOTAL_SESSION_ROWS - totalRows);
    const rows = [];
    for (const row of sessionRows.iterate(sessionId, futureLimitMs, limit + 1)) {
      totalRows += 1;
      rows.push(row);
      if (rows.length > limit) return UNINSPECTED_SESSION;
      if (totalRows % 500 === 0) await cooperativeYield();
    }
    sessions.set(sessionId, null);
    if (rows.length < 2) return null;
    const source = rows[0].source_id;
    if (!count(source)
        || rows.some((row) => row.source_id !== source || !count(row.source_offset))) {
      return null;
    }
    rows.sort((left, right) => left.source_offset - right.source_offset);
    if (rows.some((row, index) => index > 0
        && row.source_offset === rows[index - 1].source_offset)) return null;
    const adjacent = new Map();
    for (let index = 1; index < rows.length; index += 1) {
      adjacent.set(rows[index].source_offset, [rows[index - 1], rows[index]]);
    }
    sessions.set(sessionId, adjacent);
    return adjacent;
  }

  const matches = [];
  for (const reference of references) {
    if (reference.observedMs > futureLimitMs) continue;
    const possible = candidates.all(reference.observedMs, reference.currentModel,
      reference.currentEffort, reference.currentCacheReadTokens,
      MAX_CANDIDATES_PER_REFERENCE + 1);
    if (possible.length > MAX_CANDIDATES_PER_REFERENCE) continue;
    const resolved = [];
    let unexaminedCandidate = false;
    for (const candidate of possible) {
      const adjacent = await orderedSession(candidate.session_id);
      if (adjacent === UNINSPECTED_SESSION) {
        unexaminedCandidate = true;
        continue;
      }
      const pair = adjacent?.get(candidate.source_offset);
      if (pair === undefined || pair[1].source_id !== candidate.source_id) continue;
      const [previous, current] = pair;
      if (current.observed_at_ms - previous.observed_at_ms !== reference.gapMs
          || !previousConfigurationMatches(reference, previous, current)
          || previous.tokens_in_cache_read !== reference.previousCacheReadTokens
          || model.get(previous.model_id)?.model_id !== reference.previousModel
          || !currentParser(previous.source_id)
          || !count(current.tokens_in_uncached) || !count(current.tokens_in_cache_write)
          || !count(current.tokens_in_uncached + current.tokens_in_cache_write
            + reference.currentCacheReadTokens)
          || current.tokens_in_uncached + current.tokens_in_cache_write
            + reference.currentCacheReadTokens < reference.previousCacheReadTokens
          || Math.min(reference.previousCacheReadTokens - reference.currentCacheReadTokens,
            current.tokens_in_uncached + current.tokens_in_cache_write) !== reference.lostCacheTokens
          || candidate.compaction_before === 1) continue;
      if (reference.kind === "continuity" && candidate.turn_context_before !== 1) continue;
      const id = identity.get(candidate.session_id)?.session_uuid;
      resolved.push(typeof id === "string" && THREAD_ID.test(id) ? id.toLowerCase() : null);
    }
    // A tied metadata tuple is not an identity, even when both carry one UUID.
    if (!unexaminedCandidate && resolved.length === 1 && resolved[0] !== null) {
      matches.push({ kind: reference.kind, key: reference.key, id: resolved[0] });
    }
  }
  return matches;
}

/**
 * Local-only enrichment for the bounded recent rows already in this snapshot.
 * Never an arbitrary thread lookup and never writes to the store.
 */
export async function buildLocalIndexCacheDropThreadLinks({
  indexFile,
  codexHome,
  overview,
  nowMs = Date.now(),
  readThreadMetadata = readCodexLocalThreadMetadata,
} = {}) {
  const source = overview?.accounting?.cacheDiagnosticsSource;
  const generation = generationNumber(source?.generation);
  if (source === null || typeof source !== "object" || Array.isArray(source)
      || Object.keys(source).sort().join(",") !== "generation,generationFingerprint"
      || generation === null
      || typeof source.generationFingerprint !== "string"
      || !/^generation-v2-[a-f0-9]{64}$/u.test(source.generationFingerprint)
      || !count(nowMs) || typeof indexFile !== "string" || indexFile.length === 0) {
    return unavailable();
  }
  const before = readLocalIndexGenerationIdentity({ indexFile });
  if (before === null || before.id !== generation
      || before.fingerprint !== source.generationFingerprint) {
    return unavailable();
  }
  let matches;
  let database;
  try {
    const metadata = lstatSync(indexFile);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return unavailable();
    database = openLocalIndexStore(indexFile, { readOnly: true });
    matches = await readSelectedMatches(
      database, selectedReferences(overview), nowMs + FUTURE_EVIDENCE_TOLERANCE_MS,
    );
  } catch {
    return unavailable();
  } finally {
    try { database?.close(); } catch { /* read-only handle */ }
  }
  // The reads above are not one snapshot; a publication that moved while they
  // ran invalidates them as a set.
  const after = readLocalIndexGenerationIdentity({ indexFile });
  if (after === null || after.id !== before.id || after.fingerprint !== before.fingerprint) {
    return unavailable();
  }
  let metadata = null;
  try {
    metadata = await readThreadMetadata(
      codexHome,
      [...new Set(matches.map((row) => row.id))],
      { forCacheDropLinks: true },
    );
  } catch {
    // Thread names are optional; exact local ids remain useful without them.
  }
  return {
    schemaVersion: LOCAL_CACHE_DROP_THREAD_LINKS_SCHEMA,
    status: "available",
    generation: String(generation),
    entries: matches.map(({ kind, key, id }) => ({
      kind, key, thread: safeThread(id, metadata instanceof Map ? metadata.get(id) : null),
    })),
  };
}
