import { createHash } from "node:crypto";
import {
  buildPlanAttributionIndex,
  PLAN_ATTRIBUTION_POLICY,
  planAttributionContextKey,
  planEraForInterval,
} from "@app-usagemonitor/quota-analysis";
import { TELEMETRY_PLAN_TYPES } from "@app-usagemonitor/telemetry-contract";
import {
  deriveTelemetryV11QuotaOccurrenceId,
  sanitizeTelemetryAttributionBinding,
} from "./contribution/index.js";
import { createLocalUnifiedTelemetryV12EvidenceSelector } from
  "./local-index-contribution-v12-evidence.js";
import { exportLimitProvider } from "./export/index.js";
import { sanitizeAccountScope } from "./providers/codex/account.js";

// Acquisition limits, not retention limits. A larger day/corpus must pause
// preparation; it must never silently drop records or erase local history.
export const LOCAL_TELEMETRY_V11_READER_LIMITS = Object.freeze({
  dayRows: 250_000,
  // Retained plan anchors, not a cap on the admitted historical corpus.
  quotaObservations: 1_000_000,
  sessions: 125_000,
  sessionModels: 1_000_000,
  toolClasses: 500_000,
  accountMarkers: 256,
});

const MAX_MARKER_AGE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const TOKEN = /^[A-Za-z0-9._:-]{1,64}$/u;
const KNOWN_PLANS = new Set(TELEMETRY_PLAN_TYPES.filter((plan) => plan !== "unknown"));
const EMPTY_EVIDENCE = Object.freeze({
  accountBasis: "unavailable", accountScope: null, observationBinding: null,
  planBasis: "unavailable", planType: "unknown", eraStartOccurrenceId: null,
});
const hash = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const knownPlan = (value) => KNOWN_PLANS.has(value) ? value : "unknown";
const hex = (value) => value instanceof Uint8Array && value.length === 32
  ? Buffer.from(value).toString("hex") : null;

function fail(code) {
  const error = new Error("Local telemetry attribution preparation failed closed");
  error.code = `local_telemetry_v11_${code}`;
  throw error;
}

function dayBounds(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(day)) fail("invalid_day");
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isSafeInteger(start) || new Date(start).toISOString().slice(0, 10) !== day) {
    fail("invalid_day");
  }
  return [start, start + DAY_MS];
}

function capturedMarkers(values, maximum) {
  if (!Array.isArray(values) || values.length > maximum) fail("marker_limit_exceeded");
  return Object.freeze(values.map((value) => {
    const start = Date.parse(value?.capturedAt);
    const end = Date.parse(value?.receivedAt);
    const accountScope = sanitizeAccountScope(value?.accountScope);
    const observationBinding = sanitizeTelemetryAttributionBinding(value?.observationBinding);
    // Old checkpoints lack a captured binding/bracket endpoint. Never fill
    // either with today's enrollment, auth state, or the next scan's clock.
    if (value?.version !== "provisional-account-marker-v2"
        || !["active-account", "app_server_read", "app_server_notification"].includes(value?.source)
        || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || end < start || end - start > MAX_MARKER_AGE_MS
        || accountScope.status !== "available" || observationBinding === null) return null;
    return Object.freeze({
      start, end, accountScope: Object.freeze(accountScope), observationBinding,
      scopeKey: hash(["local-marker-scope-v1", accountScope.scopeId, observationBinding]),
    });
  }).filter(Boolean).sort((left, right) => left.start - right.start || left.end - right.end));
}

function markerForInterval(markers, start, end, planType) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
  let selected = null;
  let overlappingScope = null;
  let overlappingPlan = planType;
  for (const marker of markers) {
    if (marker.start > end) break;
    if (marker.end < start) continue;
    // An overlapping contradictory marker invalidates the whole bracket;
    // sorting must never choose a winner at an equal clock timestamp.
    const markerPlan = knownPlan(marker.accountScope.planType);
    if (markerPlan !== "unknown" && overlappingPlan !== "unknown" && markerPlan !== overlappingPlan) return null;
    if (markerPlan !== "unknown") overlappingPlan = markerPlan;
    if (overlappingScope !== null && overlappingScope !== marker.scopeKey) return null;
    overlappingScope = marker.scopeKey;
    if (marker.start <= start && marker.end >= end) selected ??= marker;
  }
  return selected;
}

function markersConsistentWithQuota(markers, rows) {
  if (!markers.length) return markers;
  const plans = new Map(markers.map(marker => [marker,
    new Set([knownPlan(marker.accountScope.planType)].filter(plan => plan !== "unknown"))]));
  let next = 0;
  let active = [];
  for (const row of rows) {
    while (next < markers.length && markers[next].start <= row.observed_at_ms) active.push(markers[next++]);
    active = active.filter(marker => marker.end >= row.observed_at_ms);
    if (exportLimitProvider(row.limit_id) !== "openai_codex") continue;
    const plan = knownPlan(row.plan_type);
    if (plan !== "unknown") for (const marker of active) plans.get(marker).add(plan);
  }
  return markers.filter(marker => plans.get(marker).size <= 1);
}

// The shared index needs transition boundaries, not every repeated quota
// observation. Keep exact first/last anchors of each known-plan run. Group
// equal-time rows before compaction so ties cannot pick a winning plan or seed.
// Unknown rows remain two endpoints per context; the shared policy ignores
// them whenever that context also has positive named-plan evidence.
export function compactQuotaPlanEvidence(rows, markers, maximum) {
  const observations = [];
  const seeds = new Map();
  const contexts = new Map();
  let timestamp = null;
  let tied = new Map();
  const append = value => {
    if (observations.length >= maximum) fail("quota_limit_exceeded");
    observations.push(value);
    return value;
  };
  const flush = () => {
    for (const [key, group] of tied) {
      let context = contexts.get(key);
      if (!context) {
        // Match the public plan index context bound before retaining metadata.
        if (contexts.size >= PLAN_ATTRIBUTION_POLICY.maxContexts) fail("attribution_limit_exceeded");
        context = { current: null, unknown: null };
        contexts.set(key, context);
      }
      const known = [...group.values()].filter(row => row.planType !== "unknown");
      const unknown = group.get("unknown");
      if (unknown) {
        if (!context.unknown) {
          context.unknown = { first: append(unknown), last: null };
          seeds.set(JSON.stringify([unknown.contextKey, unknown.accountScopeId, "unknown", unknown.observedAtMs]), unknown.seed);
        } else if (!context.unknown.last) context.unknown.last = append(unknown);
        else context.unknown.last.observedAtMs = unknown.observedAtMs;
      }
      if (!known.length) continue;
      if (known.length > 1) {
        for (const row of known) append(row);
        context.current = null;
        continue;
      }
      const row = known[0];
      if (!context.current || context.current.first.planType !== row.planType) {
        context.current = { first: append(row), last: null };
        seeds.set(JSON.stringify([row.contextKey, row.accountScopeId, row.planType, row.observedAtMs]), row.seed);
      } else if (!context.current.last) context.current.last = append(row);
      else context.current.last.observedAtMs = row.observedAtMs;
    }
    tied = new Map();
  };
  for (const row of rows) {
    if (timestamp !== null && row.observed_at_ms !== timestamp) flush();
    timestamp = row.observed_at_ms;
    const provider = exportLimitProvider(row.limit_id);
    const planType = knownPlan(row.plan_type);
    const marker = provider === "openai_codex"
      ? markerForInterval(markers, timestamp, timestamp, planType) : null;
    const contextKey = contextFor(provider);
    const accountScopeId = marker?.scopeKey ?? null;
    const key = JSON.stringify([contextKey, accountScopeId]);
    let group = tied.get(key);
    if (!group) { group = new Map(); tied.set(key, group); }
    const seed = sourceRecordDigest(row);
    const prior = group.get(planType);
    if (!prior) group.set(planType, { contextKey, accountScopeId, planType,
      planVariant: "unknown", observedAtMs: timestamp, seed });
    else if (prior.seed !== seed) prior.seed = null;
  }
  flush();
  return { observations, seeds };
}

function sourceRecordDigest(row) {
  const source = hex(row.source_local);
  if (source === null || !Number.isSafeInteger(row.source_offset) || row.source_offset < 0
      || !Number.isSafeInteger(row.source_ordinal) || row.source_ordinal < 0
      || !Number.isSafeInteger(row.observed_at_ms)) return null;
  // The publication's membership proves these coordinates. Generation is a
  // read fence, not part of the identity: copy-forward must not create a new
  // occurrence. A replacement is always rederived from the fresh pinned facts.
  return hash(["local-quota-record-v1", source, row.source_offset,
    row.source_ordinal, row.observed_at_ms]);
}

function quotaRecord(row) {
  const digest = sourceRecordDigest(row);
  if (digest === null || typeof row.limit_id !== "string" || !TOKEN.test(row.limit_id)
      || typeof row.slot !== "string" || !TOKEN.test(row.slot)
      || !Number.isSafeInteger(row.slot_order) || row.slot_order < 0
      || (row.used_percent !== null && (typeof row.used_percent !== "number" || !Number.isFinite(row.used_percent)
        || row.used_percent < 0 || row.used_percent > 100))
      || (row.duration_mins !== null && (!Number.isSafeInteger(row.duration_mins) || row.duration_mins < 1
        || row.duration_mins > 527_040))
      || (row.resets_at_ms !== null && !Number.isSafeInteger(row.resets_at_ms))) return null;
  try {
    return Object.freeze({
      schemaVersion: "quota-observation-v1.0",
      observationId: deriveTelemetryV11QuotaOccurrenceId({
        sourceRecordDigest: hash(["local-quota-window-v1", digest, row.slot_order]),
        limitId: row.limit_id, slot: row.slot,
      }),
      observedTime: new Date(row.observed_at_ms).toISOString(),
      provider: exportLimitProvider(row.limit_id), planType: knownPlan(row.plan_type),
      planVariant: "unknown", limitId: row.limit_id, slot: row.slot,
      usedPercent: row.used_percent, windowDurationMinutes: row.duration_mins,
      resetsAt: row.resets_at_ms === null ? null : new Date(row.resets_at_ms).toISOString(),
    });
  } catch { return null; }
}

function contextFor(provider) {
  // Account-plan observations are shared across the provider's quota windows;
  // a five-hour/weekly pair on one record is one plan-era anchor, not two.
  return planAttributionContextKey(provider, "account-plan");
}

/**
 * A failure the v1.1 preparation reports, for row sources that detect a
 * condition (a changed publication, an oversized corpus) the shared reader
 * cannot see for itself.
 */
export function localTelemetryV11Failure(code) {
  try {
    fail(code);
  } catch (error) {
    return error;
  }
  return null;
}

/**
 * The v1.1 attribution reader over any row source. The attribution rules (plan
 * eras, account markers, v1.2 evidence selection, bounds) live here once; a
 * source supplies the committed facts and the consistency fence.
 */
export function createTelemetryV11ReaderFromSource(source, {
  accountMarkers = [], limits = {},
} = {}) {
  const bounds = { ...LOCAL_TELEMETRY_V11_READER_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(bounds, key) || !Number.isSafeInteger(value)
        || value < 1 || value > bounds[key]) fail("invalid_limits");
    bounds[key] = value;
  }
  const markers = capturedMarkers(accountMarkers, bounds.accountMarkers);
  let state = null;

  function initialize(descriptor) {
    const readers = source.initialize(descriptor, bounds);
    const consistentMarkers = markersConsistentWithQuota(markers, source.allQuotaRows(descriptor));
    const { observations, seeds } = compactQuotaPlanEvidence(
      source.allQuotaRows(descriptor), consistentMarkers, bounds.quotaObservations);
    const index = buildPlanAttributionIndex(observations);
    if (index.status !== "ready") fail("attribution_limit_exceeded");
    return { ...readers, index, seeds, markers: consistentMarkers };
  }

  function snapshot(read) {
    try {
      return source.snapshot((descriptor) => {
        if (state?.key !== descriptor.key) state = { ...initialize(descriptor), key: descriptor.key };
        return read(state, descriptor);
      });
    } catch (error) {
      state = null;
      throw error;
    }
  }

  function evidence(current, { provider, planBasis, planType, start, end }) {
    const marker = provider === "openai_codex" && planBasis !== "conflicted"
      ? markerForInterval(current.markers, start, end, planType) : null;
    const result = {
      ...EMPTY_EVIDENCE, planBasis, planType,
      accountBasis: marker === null ? "unavailable" : "provisional_marker",
      accountScope: marker?.accountScope ?? null,
      observationBinding: marker?.observationBinding ?? null,
    };
    // Exact ending-record plan is observation evidence, not proof of the
    // cumulative quantity's ownership. An unresolved/cross-boundary interval
    // retains that plan but cannot receive an era or provisional account.
    if (marker !== null && planType !== "unknown") {
      const contextKey = contextFor(provider);
      const match = planEraForInterval(current.index, {
        contextKey, accountScopeId: marker.scopeKey, intervalStartMs: start, observedAtMs: end,
      });
      if (match.status === "matched" && match.era.planType === planType
          && start >= match.era.firstObservedAtMs) {
        result.eraStartOccurrenceId = current.seeds.get(JSON.stringify([
          contextKey, marker.scopeKey, planType, match.era.firstObservedAtMs,
        ])) ?? null;
      }
    }
    return Object.freeze(result);
  }

  return Object.freeze({
    projectionEvidence({ binding } = {}) {
      const captured = sanitizeTelemetryAttributionBinding(binding);
      if (captured === null) fail("invalid_binding");
      return snapshot((current) => {
        // Only normalized, quota-consistent evidence can affect projection.
        // Keep its content inside the reader; the private resume journal gets
        // one digest, never scopes, marker brackets or enrollment identifiers.
        const material = current.markers.map((marker) => JSON.stringify([
          marker.start, marker.end, marker.accountScope.scopeId,
          knownPlan(marker.accountScope.planType), marker.observationBinding,
        ])).sort();
        const days = new Set();
        for (const marker of current.markers) {
          if (marker.observationBinding.destinationOrigin !== captured.destinationOrigin
              || marker.observationBinding.enrollmentNamespace !== captured.enrollmentNamespace) continue;
          // A validated bracket is at most five minutes, hence at most two
          // calendar days. The caller checks actual record evidence there
          // before requesting an existing-only account-root lease.
          days.add(new Date(marker.start).toISOString().slice(0, 10));
          days.add(new Date(marker.end).toISOString().slice(0, 10));
        }
        return Object.freeze({ fingerprint: hash(["telemetry-v11-marker-evidence-v1", material]),
          boundDays: Object.freeze([...days].sort()) });
      });
    },
    days() {
      return snapshot((current, descriptor) => [...new Set([
        ...current.base.days(), ...source.quotaDays(descriptor),
      ])].filter((day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(day)).sort());
    },
    readDay(day) {
      return readDayInternal(day, false);
    },
    readDayWithV12Evidence(day) {
      return readDayInternal(day, true);
    },
  });

  function readDayInternal(day, includeV12Evidence) {
    const [start, end] = dayBounds(day);
    return snapshot((current, descriptor) => {
      const rawUsage = includeV12Evidence
        ? source.usageEvidenceRows(descriptor, start, end, bounds.dayRows + 1)
        : source.usageRawRows(descriptor, start, end, bounds.dayRows + 1);
      const rawQuota = source.quotaDayRows(descriptor, start, end, bounds.dayRows + 1);
      const canonicalCount = source.canonicalQuotaCount(start, end);
      if (rawUsage.length + rawQuota.length > bounds.dayRows || canonicalCount > bounds.dayRows) fail("day_limit_exceeded");
      const base = current.base.deriveDay(day);
      const usage = base.chunks.filter((chunk) => chunk.stream === "usage").flatMap((chunk) => chunk.records);
      const session = base.chunks.filter((chunk) => chunk.stream === "session").flatMap((chunk) => chunk.records);
      const rawById = new Map(rawUsage.map((row) => [hex(row.event_key), row]));
      const telemetryV12Evidence = includeV12Evidence
        ? createLocalUnifiedTelemetryV12EvidenceSelector({
          records: usage,
          facts: rawUsage.map((row) => ({
            eventId: hex(row.event_key),
            sessionLocal: hex(row.session_local),
            sourceLocal: hex(row.evidence_source_local),
            sourceOffset: row.evidence_source_offset === null
              ? null : Number(row.evidence_source_offset),
            sourceOrdinal: row.evidence_source_ordinal === null
              ? null : Number(row.evidence_source_ordinal),
            parserVersion: row.parser_version,
            boundary: row.boundary_event_key === null ? null : {
              parserVersion: row.boundary_parser_version,
              sessionLocal: hex(row.boundary_session_local),
              turnContextBefore: Number(row.turn_context_before),
              compactionBefore: Number(row.compaction_before),
              compactedAtMs: row.compacted_at_ms === null
                ? null : Number(row.compacted_at_ms),
            },
          })),
          boundaryLookupComplete: true,
          maxRows: bounds.dayRows,
        })
        : null;
      const proof = new WeakMap();
      for (const record of usage) {
        const raw = rawById.get(record.eventId);
        const association = raw ? current.usage.read(raw) : null;
        const planType = knownPlan(association?.planAttribution?.planType);
        const basis = association?.planAttribution?.basis;
        proof.set(record, ["usage", evidence(current, {
          provider: record.provider, planType,
          planBasis: basis === "conflicted" ? "conflicted"
            : basis === "same_record" && planType !== "unknown" ? "same_source_occurrence" : "unavailable",
          start: association?.usageIntervalStartedAt === null || !association
            ? null : Date.parse(association.usageIntervalStartedAt),
          end: raw?.observed_at_ms,
        })]);
        Object.freeze(record.components);
        Object.freeze(record);
      }
      for (const record of session) {
        Object.freeze(record.toolClassCounts);
        Object.freeze(record);
      }
      const quota = [];
      let excludedQuota = 0;
      for (const row of rawQuota) {
        const record = quotaRecord(row);
        if (record === null) { excludedQuota += 1; continue; }
        quota.push(record);
        proof.set(record, ["quota", evidence(current, {
          provider: record.provider, planType: record.planType,
          planBasis: record.planType === "unknown" ? "unavailable" : "same_source_occurrence",
          start: row.observed_at_ms, end: row.observed_at_ms,
        })]);
      }
      return Object.freeze({
        recordsByStream: Object.freeze({ usage: Object.freeze(usage), quota: Object.freeze(quota), session: Object.freeze(session) }),
        ...(includeV12Evidence ? { telemetryV12Evidence } : {}),
        attributionForRecord(stream, record) {
          if (stream !== "usage" && stream !== "quota") return null;
          const entry = proof.get(record);
          return entry?.[0] === stream ? entry[1] : EMPTY_EVIDENCE;
        },
        excluded: Object.freeze({ usage: base.excluded.usage, quota: excludedQuota, session: base.excluded.session }),
      });
    });
  }
}
