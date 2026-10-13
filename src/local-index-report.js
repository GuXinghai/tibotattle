import { MAX_QUOTA_WINDOW_DURATION_MINUTES } from "@app-usagemonitor/quota-analysis";

import {
  analyzeCacheImpactRows,
  unavailableCacheContinuityImpact,
  unavailableCacheSwitchImpact,
} from "./cache-switch-impact.js";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import {
  addTimelineUsage,
  addUsageToPeriod,
  finalizeTimelineBuckets,
  finalizeUsagePeriod,
  KNOWN_TOOL_CLASSES,
  MAX_QUOTA_TIMELINE_POINTS,
  newUsagePeriod,
  quotaWindowProjection,
  safeSpeed,
  sampleQuotaTimelineByTrack,
  SPARK_QUOTA_LIMIT_IDS,
  TIMELINE_BUCKET_MS,
  usageProjection,
} from "./local-companion-usage-model.js";
import { positiveInput } from "./local-index-pairing.js";
import {
  committedPredicate,
  ROLLUP_BUCKET_MS,
  rollupBasisCurrent,
  storedContextStarts,
} from "./local-index-rollup.js";
import { LOCAL_INDEX_PARSER_VERSION, readCommitSeq } from "./local-index-store.js";
import { createAccountingPricer } from "./replay-safe-accounting-cache.js";

// The report read over the local index store.
//
// Periods and timelines come from the usage rollups: one projection per rollup
// row, weighted by its event count, instead of one per event. Only three kinds
// of bucket are read event by event, because a rollup row cannot be split:
//
//   * the bucket that contains a period start or the future cutoff;
//   * a bucket that contains a boundary of a declared speed window, since the
//     declared mode of an unobserved event depends on its own instant.
//
// Everything else is a whole bucket, so its events share one instant for every
// purpose the projection has (price-card date, window membership, period).
//
// A report is a pure function of one read snapshot, the clock and the speed
// ledger. Nothing about it is cached, so a changed ledger changes the next
// report exactly as a full per-event pass would.

const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const PERIOD_DEFINITIONS = Object.freeze([
  { id: "24h", label: "Last 24 hours", spanMs: 24 * 60 * 60 * 1_000 },
  { id: "7d", label: "Last 7 days", spanMs: 7 * 24 * 60 * 60 * 1_000 },
  { id: "30d", label: "Last 30 days", spanMs: 30 * 24 * 60 * 60 * 1_000 },
  { id: "all", label: "All indexed local history", spanMs: Number.POSITIVE_INFINITY },
]);
export const LOCAL_INDEX_REPORT_PERIOD_LABEL = "All indexed local history";

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function bucketOf(milliseconds) {
  return Math.floor(milliseconds / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
}

function isoOrNull(milliseconds) {
  return Number.isSafeInteger(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function loadDimensions(database) {
  const models = new Map(database.prepare("SELECT id, model_id FROM model").all()
    .map((row) => [Number(row.id), row.model_id]));
  const tiers = new Map(database.prepare(
    "SELECT id, codex_speed_mode, api_service_tier FROM tier_semantics",
  ).all().map((row) => [Number(row.id), {
    codexSpeedMode: row.codex_speed_mode,
    apiServiceTier: row.api_service_tier,
  }]));
  const surfaces = new Map(database.prepare(
    "SELECT id, surface, agent_scope, lineage_disposition FROM surface_class",
  ).all().map((row) => [Number(row.id), {
    surface: row.surface,
    agentScope: row.agent_scope,
    lineageDisposition: row.lineage_disposition,
  }]));
  const scopes = new Map(database.prepare("SELECT id, status FROM account_scope").all()
    .map((row) => [Number(row.id), row.status]));
  return { models, tiers, surfaces, scopes };
}

function validSpeedWindows(baselines) {
  if (!Array.isArray(baselines)) return [];
  const windows = [];
  for (const window of baselines) {
    const startMs = Date.parse(window?.firstSeenAt);
    const endMs = Date.parse(window?.lastSeenAt);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      windows.push({ startMs, endMs });
    }
  }
  return windows;
}

function tokenOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** True while some source has facts beyond its cursor (a build in progress). */
export function hasProvisionalFacts(database) {
  return database.prepare(`
    SELECT 1 AS present FROM source s
    WHERE EXISTS (SELECT 1 FROM usage_event u
                  WHERE u.source_id = s.id AND u.source_offset > s.scanned_bytes)
       OR EXISTS (SELECT 1 FROM quota_occurrence q
                  WHERE q.source_id = s.id AND q.source_offset > s.scanned_bytes)
    LIMIT 1`).get() !== undefined;
}

/**
 * Fold the usage rollups into the four periods and the timeline.
 *
 * `nowMs` is the report clock. Returns finalized periods, the finalized
 * timelines and the counters the companion projection reports beside them.
 */
export function readLocalIndexUsage(database, {
  nowMs,
  declaredSpeedBaselines = [],
  pricer = createAccountingPricer(),
} = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be a finite epoch timestamp");
  if (!rollupBasisCurrent(database)) throw fixedError("local_index_rollup_basis_stale");
  const futureLimitMs = nowMs + FUTURE_SKEW_MS;
  const starts = storedContextStarts(database);
  const dimensions = loadDimensions(database);
  const windows = validSpeedWindows(declaredSpeedBaselines);
  const periods = PERIOD_DEFINITIONS.map((definition) => ({
    summary: newUsagePeriod(
      definition.id,
      definition.id === "all" ? LOCAL_INDEX_REPORT_PERIOD_LABEL : definition.label,
    ),
    start: Number.isFinite(definition.spanMs)
      ? nowMs - definition.spanMs
      : Number.NEGATIVE_INFINITY,
  }));
  const timelineBuckets = new Map();
  const sparkTimelineBuckets = new Map();

  // Buckets that cannot be treated as one instant.
  const expanded = new Set();
  const cutoffBucket = bucketOf(futureLimitMs);
  if (cutoffBucket + ROLLUP_BUCKET_MS - 1 > futureLimitMs) expanded.add(cutoffBucket);
  for (const period of periods) {
    if (Number.isFinite(period.start) && bucketOf(period.start) !== period.start) {
      expanded.add(bucketOf(period.start));
    }
  }
  for (const window of windows) {
    if (bucketOf(window.startMs) !== window.startMs) expanded.add(bucketOf(window.startMs));
    const endBucket = bucketOf(window.endMs);
    if (endBucket + ROLLUP_BUCKET_MS - 1 !== window.endMs) expanded.add(endBucket);
  }

  let usageEvents = 0;
  const fold = (record, tier, observedMs, weight) => {
    usageEvents += weight;
    const projection = usageProjection(
      record,
      safeSpeed(tier.codexSpeedMode) === "unknown"
        ? declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown"
        : "unknown",
      pricer,
    );
    if (projection === null) return;
    for (const period of periods) {
      if (observedMs >= period.start) addUsageToPeriod(period.summary, projection, weight);
    }
    addTimelineUsage(
      projection.isSpark ? sparkTimelineBuckets : timelineBuckets,
      observedMs,
      projection,
      weight,
    );
  };

  // 1. Whole buckets, from the rollups.
  const rollupRows = database.prepare(`
    SELECT bucket_ms, model_id, tier_id, surface_id, account_scope_id, shape,
           ctx_class, events, in_uncached, in_cache_read, in_cache_write,
           out_text, out_reasoning, out_combined
    FROM usage_rollup
    WHERE events > 0 AND bucket_ms <= ?`);
  for (const row of rollupRows.iterate(futureLimitMs)) {
    const bucketMs = Number(row.bucket_ms);
    if (expanded.has(bucketMs)) continue;
    const shape = Number(row.shape);
    const classIndex = Number(row.ctx_class);
    const component = (bit, value) => ((shape >> bit) & 1) === 1 ? null : Number(value);
    const tier = dimensions.tiers.get(Number(row.tier_id));
    fold({
      observedAt: new Date(bucketMs).toISOString(),
      model: dimensions.models.get(Number(row.model_id)),
      // A class stands for every total between two registry thresholds, so its
      // first token count prices exactly as each of them does.
      totalInputContextTokens: classIndex < 0
        ? null
        : classIndex === 0 ? 0 : starts[classIndex - 1],
      components: {
        input_uncached_tokens: component(0, row.in_uncached),
        input_cache_read_tokens: component(1, row.in_cache_read),
        input_cache_write_tokens: component(2, row.in_cache_write),
        output_text_tokens: component(3, row.out_text),
        output_reasoning_tokens: component(4, row.out_reasoning),
        output_combined_tokens: component(5, row.out_combined),
      },
      tierSemantics: tier,
      surfaceClassification: dimensions.surfaces.get(Number(row.surface_id)),
      accountScope: { status: dimensions.scopes.get(Number(row.account_scope_id)) },
    }, tier, bucketMs, Number(row.events));
  }

  // 2. Buckets read event by event, through the same projection.
  const eventRows = database.prepare(`
    SELECT u.observed_at_ms, u.model_id, u.tier_id, u.surface_id,
           u.account_scope_id, u.total_input_context, u.tokens_in_uncached,
           u.tokens_in_cache_read, u.tokens_in_cache_write, u.tokens_out_text,
           u.tokens_out_reasoning, u.tokens_out_combined
    FROM usage_event u
    WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ? AND u.observed_at_ms <= ?
      AND ${committedPredicate("u")}`);
  for (const bucketMs of [...expanded].sort((left, right) => left - right)) {
    for (const row of eventRows.iterate(bucketMs, bucketMs + ROLLUP_BUCKET_MS, futureLimitMs)) {
      const observedMs = Number(row.observed_at_ms);
      const tier = dimensions.tiers.get(Number(row.tier_id));
      fold({
        observedAt: new Date(observedMs).toISOString(),
        model: dimensions.models.get(Number(row.model_id)),
        totalInputContextTokens: tokenOrNull(row.total_input_context),
        components: {
          input_uncached_tokens: tokenOrNull(row.tokens_in_uncached),
          input_cache_read_tokens: tokenOrNull(row.tokens_in_cache_read),
          input_cache_write_tokens: tokenOrNull(row.tokens_in_cache_write),
          output_text_tokens: tokenOrNull(row.tokens_out_text),
          output_reasoning_tokens: tokenOrNull(row.tokens_out_reasoning),
          output_combined_tokens: tokenOrNull(row.tokens_out_combined),
        },
        tierSemantics: tier,
        surfaceClassification: dimensions.surfaces.get(Number(row.surface_id)),
        accountScope: { status: dimensions.scopes.get(Number(row.account_scope_id)) },
      }, tier, observedMs, 1);
    }
  }

  // The earliest and latest instants, by an index seek into one bucket each.
  const firstBucket = database.prepare(
    "SELECT MIN(bucket_ms) AS value FROM usage_rollup WHERE events > 0",
  ).get().value;
  let firstObservedMs = null;
  if (firstBucket !== null && firstBucket !== undefined) {
    const value = database.prepare(`
      SELECT MIN(u.observed_at_ms) AS value FROM usage_event u
      WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ?
        AND ${committedPredicate("u")}`).get(Number(firstBucket), Number(firstBucket) + ROLLUP_BUCKET_MS).value;
    if (value !== null && Number(value) <= futureLimitMs) firstObservedMs = Number(value);
  }
  let lastObservedMs = null;
  const lastBuckets = database.prepare(`
    SELECT bucket_ms FROM usage_rollup WHERE events > 0 AND bucket_ms <= ?
    GROUP BY bucket_ms ORDER BY bucket_ms DESC LIMIT 4`).all(futureLimitMs);
  for (const { bucket_ms: bucket } of lastBuckets) {
    const value = database.prepare(`
      SELECT MAX(u.observed_at_ms) AS value FROM usage_event u
      WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ? AND u.observed_at_ms <= ?
        AND ${committedPredicate("u")}`).get(Number(bucket), Number(bucket) + ROLLUP_BUCKET_MS, futureLimitMs).value;
    if (value !== null) {
      lastObservedMs = Number(value);
      break;
    }
  }

  const coveredStartMs = timelineBuckets.size === 0
    ? null : Math.min(...timelineBuckets.keys());
  const coveredEndMs = timelineBuckets.size === 0
    ? null : Math.max(...timelineBuckets.keys()) + TIMELINE_BUCKET_MS;
  return {
    usage: periods.map((period) => finalizeUsagePeriod(period.summary)),
    timeline: {
      bucketMinutes: TIMELINE_BUCKET_MS / 60_000,
      coveredAt: {
        startAt: isoOrNull(coveredStartMs),
        endAt: isoOrNull(coveredEndMs),
      },
      usage: finalizeTimelineBuckets(timelineBuckets),
      sparkUsage: finalizeTimelineBuckets(sparkTimelineBuckets),
    },
    usageEvents,
    firstObservedMs,
    lastObservedMs,
    expandedBuckets: expanded.size,
  };
}

function quotaRowCompare(left, right) {
  return left.observedMs - right.observedMs
    || left.limitId.localeCompare(right.limitId)
    || left.durationMinutes - right.durationMinutes
    || left.slot.localeCompare(right.slot)
    || left.planType.localeCompare(right.planType)
    || left.usedPercent - right.usedPercent;
}

function quotaRowTieBreak(row) {
  // Percent is zero-padded so the string compare is numeric. Slot is last:
  // display provenance, not identity.
  return [
    row.planType,
    row.usedPercent.toFixed(3).padStart(7, "0"),
    row.resetAt,
    row.accountAttribution,
    row.slot,
  ].join("\0");
}

// What quotaWindowProjection accepts, as a predicate the index can answer: a
// percent in range, a valid duration and a reset instant that converts.
const QUOTA_VALID_SQL = `
  used_percent IS NOT NULL AND used_percent >= 0 AND used_percent <= 100
  AND duration_mins >= 1 AND duration_mins <= ${MAX_QUOTA_WINDOW_DURATION_MINUTES}
  AND resets_at_ms IS NOT NULL AND resets_at_ms >= 1000
  AND resets_at_ms < 8640000000001000`;

function quotaCandidate(row) {
  const observedMs = Number(row.observed_at_ms);
  const projected = quotaWindowProjection({
    limitId: row.limit_id,
    slot: row.slot,
    planType: row.plan_type,
    usedPercent: row.used_percent,
    windowDurationMins: Number(row.duration_mins),
    resetsAt: Number.isSafeInteger(Number(row.resets_at_ms))
      ? Math.floor(Number(row.resets_at_ms) / 1_000)
      : null,
  });
  if (projected === null) return null;
  return {
    observedAt: new Date(observedMs).toISOString(),
    ...projected,
    // Rollout logs carry no account identity, and the index records that
    // honestly; quota points read from it are therefore unattributed.
    accountAttribution: "unattributed",
    observedMs,
  };
}

function withoutObservedMs(row) {
  const { observedMs, ...rest } = row;
  void observedMs;
  return rest;
}

function sampleRanks(size, take) {
  if (size <= take) return Array.from({ length: size }, (_, index) => index + 1);
  if (take === 1) return [1];
  const ranks = [];
  const last = size - 1;
  for (let index = 0; index < take; index += 1) {
    ranks.push(Math.round((index * last) / (take - 1)) + 1);
  }
  return ranks;
}

/**
 * The deduplicated, validated, per-track-sampled quota series of one limit.
 * The same series the companion's reader produces, without visiting every
 * observation in JavaScript:
 *
 *   * validity is a SQL predicate over the covering index;
 *   * same-millisecond candidates of one track (rare: two slots reporting one
 *     duration at once) are resolved in JavaScript by the shared tie-break;
 *   * the per-track budgets are computed from counts, and only the sampled
 *     ranks are fetched, by a window function over the index order.
 *
 * `committedOnly` restricts to observations that some committed occurrence
 * supports, for the moments a parallel build is in flight.
 */
export function readLocalIndexQuotaSeries(database, limitIds, nowMs, { committedOnly = false } = {}) {
  const cutoffMs = nowMs + FUTURE_SKEW_MS;
  const guard = committedOnly
    ? `AND EXISTS (SELECT 1 FROM quota_occurrence o JOIN source s ON s.id = o.source_id
                   WHERE o.canonical_observation_id = quota_observation.id
                     AND o.source_offset <= s.scanned_bytes)`
    : "";
  const placeholders = limitIds.map(() => "?").join(", ");
  const where = `limit_id IN (${placeholders}) AND observed_at_ms <= ? AND ${QUOTA_VALID_SQL} ${guard}`;
  const params = [...limitIds, cutoffMs];

  // Same-millisecond candidates of one track: keep the lowest tie-break.
  const loserIds = [];
  const losersByTrack = new Map();
  const groupRows = database.prepare(`
    SELECT id, observed_at_ms, limit_id, slot, plan_type, used_percent,
           resets_at_ms, duration_mins
    FROM quota_observation
    WHERE limit_id = ? AND duration_mins = ? AND observed_at_ms = ?
      AND ${QUOTA_VALID_SQL} ${guard}
    ORDER BY slot`);
  for (const group of database.prepare(`
    SELECT limit_id, duration_mins, observed_at_ms FROM quota_observation
    WHERE ${where}
    GROUP BY limit_id, duration_mins, observed_at_ms HAVING COUNT(*) > 1`).all(...params)) {
    let winner = null;
    const members = [];
    for (const row of groupRows.iterate(group.limit_id, group.duration_mins, group.observed_at_ms)) {
      const candidate = quotaCandidate(row);
      if (candidate === null) continue;
      const member = { id: Number(row.id), candidate };
      members.push(member);
      if (winner === null
          || quotaRowTieBreak(candidate) < quotaRowTieBreak(winner.candidate)) {
        winner = member;
      }
    }
    for (const member of members) {
      if (member === winner) continue;
      loserIds.push(member.id);
      const key = `${group.limit_id}\0${group.duration_mins}`;
      losersByTrack.set(key, (losersByTrack.get(key) ?? 0) + 1);
    }
  }
  const excluded = loserIds.length === 0
    ? ""
    : "AND id NOT IN (SELECT value FROM json_each(?))";
  const excludedParams = loserIds.length === 0 ? [] : [JSON.stringify(loserIds)];

  const tracks = [];
  let total = 0;
  for (const row of database.prepare(`
    SELECT limit_id, duration_mins, COUNT(*) AS n FROM quota_observation
    WHERE ${where}
    GROUP BY limit_id, duration_mins`).all(...params)) {
    const size = Number(row.n)
      - (losersByTrack.get(`${row.limit_id}\0${row.duration_mins}`) ?? 0);
    if (size < 1) continue;
    tracks.push({
      limitId: row.limit_id,
      duration: Number(row.duration_mins),
      key: `${row.limit_id}:${Number(row.duration_mins)}`,
      size,
    });
    total += size;
  }
  if (total === 0) return [];

  if (total <= MAX_QUOTA_TIMELINE_POINTS) {
    const rows = [];
    for (const row of database.prepare(`
      SELECT id, observed_at_ms, limit_id, slot, plan_type, used_percent,
             resets_at_ms, duration_mins
      FROM quota_observation
      WHERE ${where} ${excluded}
      ORDER BY observed_at_ms, limit_id, slot`).iterate(...params, ...excludedParams)) {
      const candidate = quotaCandidate(row);
      if (candidate !== null) rows.push(candidate);
    }
    rows.sort(quotaRowCompare);
    return rows.map(withoutObservedMs);
  }

  // Budgets exactly as sampleQuotaTimelineByTrack: smaller tracks first, each
  // taking at most its fair share of what remains.
  tracks.sort((left, right) => left.size - right.size || left.key.localeCompare(right.key));
  let remaining = MAX_QUOTA_TIMELINE_POINTS;
  let tracksLeft = tracks.length;
  const sampled = [];
  const numbered = database.prepare(`
    SELECT n.id, n.observed_at_ms, n.limit_id, n.slot, n.plan_type, n.used_percent,
           n.resets_at_ms, n.duration_mins
    FROM (
      SELECT id, observed_at_ms, limit_id, slot, plan_type, used_percent,
             resets_at_ms, duration_mins,
             ROW_NUMBER() OVER (ORDER BY observed_at_ms) AS rn
      FROM quota_observation
      WHERE limit_id = ? AND duration_mins = ? AND observed_at_ms <= ?
        AND ${QUOTA_VALID_SQL} ${guard} ${excluded}) n
    WHERE n.rn IN (SELECT value FROM json_each(?))
    ORDER BY n.rn`);
  for (const track of tracks) {
    const budget = Math.max(1, Math.floor(remaining / tracksLeft));
    const take = Math.min(track.size, budget);
    const ranks = sampleRanks(track.size, take);
    for (const row of numbered.iterate(
      track.limitId, track.duration, cutoffMs, ...excludedParams, JSON.stringify(ranks),
    )) {
      const candidate = quotaCandidate(row);
      if (candidate !== null) sampled.push(candidate);
    }
    remaining -= take;
    tracksLeft -= 1;
  }
  return sampled.sort(quotaRowCompare).map(withoutObservedMs);
}

// Column list shared by both candidate readers; the analysis is indifferent to
// which one produced a row.
const CANDIDATE_OUTPUT_SQL = `
    SELECT cu.observed_at_ms AS observed_at_ms,
           m.model_id AS model_id,
           m.recognition AS model_recognition,
           cu.reasoning_effort AS reasoning_effort,
           cu.tier_id AS tier_id,
           t.codex_speed_mode AS codex_speed_mode,
           cu.surface_id AS surface_id,
           s.parser_version AS parser_version,
           cu.tokens_in_uncached AS tokens_in_uncached,
           cu.tokens_in_cache_read AS tokens_in_cache_read,
           cu.tokens_in_cache_write AS tokens_in_cache_write,
           cu.tokens_out_text AS tokens_out_text,
           cu.tokens_out_reasoning AS tokens_out_reasoning,
           cu.tokens_out_combined AS tokens_out_combined,
           pu.observed_at_ms AS previous_observed_at_ms,
           pm.model_id AS previous_model_id,
           pm.recognition AS previous_model_recognition,
           pu.reasoning_effort AS previous_reasoning_effort,
           pu.tier_id AS previous_tier_id,
           pu.surface_id AS previous_surface_id,
           s.parser_version AS previous_parser_version,
           pu.tokens_in_cache_read AS previous_tokens_in_cache_read,
           COALESCE(b.compaction_before, 0) AS compaction_between,
           COALESCE(b.turn_context_before, 0) AS turn_context_between,
           cu.source_offset AS current_source_offset,
           0 AS ordering_coverage_gap`;

const SENTINEL_COLUMNS_SQL = `
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL,`;

// A sentinel has every candidate column, all NULL, exactly as the SQL emits it.
const SENTINEL_ROW = Object.freeze(Object.fromEntries([...CANDIDATE_OUTPUT_SQL.matchAll(/ AS ([a-z_]+)/gu)]
  .map((match) => [match[1], null])));

function committedClause(committedOnly, alias = "u") {
  return committedOnly
    ? `AND ${alias}.source_offset <= (SELECT scanned_bytes FROM source WHERE id = ${alias}.source_id)`
    : "";
}

/** Candidate rows in the order the analysis consumes them (SQL's, made total). */
function sortCandidateRows(rows) {
  return rows.sort((left, right) => (
    Number(left.observed_at_ms) - Number(right.observed_at_ms)
    || (left.current_source_offset === null ? -1 : 0)
      - (right.current_source_offset === null ? -1 : 0)
    || Number(left.current_source_offset ?? 0) - Number(right.current_source_offset ?? 0)
  ));
}

/**
 * The candidate rows of both cache-impact lenses, exactly, from the committed
 * facts, optionally for a set of sessions only.
 *
 * Positive-input requests (dated at or before the future-evidence limit) are
 * paired with their predecessor in the same session by source byte order and
 * kept when the model or reasoning effort changed or a turn-context or
 * compaction boundary separates them. A session spanning several sources has
 * offsets in incomparable coordinates, so it is withheld and surfaces as an
 * ordering-coverage sentinel at its latest instant. This is the oracle the
 * materialized reader is tested against, and it serves the sessions the
 * materialized pairs cannot.
 */
export function readLocalIndexCacheCandidateRowsExact(database, futureLimitMs, {
  committedOnly = false,
  sessionIds = null,
} = {}) {
  const positive = positiveInput("u");
  const committed = committedClause(committedOnly);
  const scoped = sessionIds === null
    ? ""
    : "AND u.session_id IN (SELECT value FROM json_each(?))";
  const scopeParams = sessionIds === null ? [] : [JSON.stringify(sessionIds)];
  return sortCandidateRows(database.prepare(`
    WITH coverage AS MATERIALIZED (
      -- Quota-only and compaction bookkeeping rows carry NULL or zero
      -- components; they are not input requests and must not consume the
      -- adjacency boundary before the next real one.
      SELECT u.session_id AS session_id,
             MAX(u.observed_at_ms) AS latest_observed_at_ms,
             COUNT(*) AS positive_events,
             COUNT(DISTINCT u.source_id) AS source_count
      FROM usage_event u
      WHERE ${positive} AND u.observed_at_ms <= ? ${committed} ${scoped}
      GROUP BY u.session_id
    ),
    adjacency AS MATERIALIZED (
      SELECT u.source_id AS source_id, u.source_offset AS source_offset,
             LAG(u.source_offset) OVER session_order AS previous_offset
      FROM usage_event u
      WHERE ${positive} AND u.observed_at_ms <= ? ${committed}
        AND u.session_id IN (SELECT session_id FROM coverage WHERE source_count = 1)
      -- Source byte order is authoritative inside the one source proven above.
      WINDOW session_order AS (PARTITION BY u.session_id ORDER BY u.source_offset)
    )
    ${CANDIDATE_OUTPUT_SQL}
    FROM adjacency a
    JOIN usage_event cu
      ON cu.source_id = a.source_id AND cu.source_offset = a.source_offset
    JOIN usage_event pu
      ON pu.source_id = a.source_id AND pu.source_offset = a.previous_offset
    LEFT JOIN usage_event_boundary b
      ON b.source_id = a.source_id AND b.source_offset = a.source_offset
    JOIN model m ON m.id = cu.model_id
    JOIN model pm ON pm.id = pu.model_id
    JOIN tier_semantics t ON t.id = cu.tier_id
    JOIN source s ON s.id = a.source_id
    WHERE a.previous_offset IS NOT NULL
      AND (cu.model_id != pu.model_id
        OR cu.reasoning_effort != pu.reasoning_effort
        OR b.turn_context_before = 1
        OR b.compaction_before = 1)
    UNION ALL
    SELECT latest_observed_at_ms, ${SENTINEL_COLUMNS_SQL}
           1 AS ordering_coverage_gap
    FROM coverage
    WHERE positive_events >= 2 AND source_count != 1`)
    .all(futureLimitMs, ...scopeParams, futureLimitMs));
}

/**
 * The candidate rows of both lenses from the materialized pairs.
 *
 * Stored pairs describe each source's committed requests whatever their date.
 * The shipping reader drops requests dated after the future-evidence limit
 * before pairing, which can re-form their neighbours' pairs, so any session
 * holding such a request is evaluated exactly instead. Sessions spanning
 * several sources are withheld, as in the exact reader.
 */
export function readLocalIndexCacheCandidateRows(database, futureLimitMs, { committedOnly = false } = {}) {
  const futureSessions = database.prepare(`
    SELECT DISTINCT u.session_id AS session_id FROM usage_event u
    WHERE u.observed_at_ms > ? AND ${positiveInput("u")} ${committedClause(committedOnly)}`)
    .all(futureLimitMs).map((row) => Number(row.session_id));
  const future = new Set(futureSessions);
  const spanning = database.prepare(`
    SELECT session_id FROM session_positive WHERE events > 0
    GROUP BY session_id HAVING COUNT(*) > 1`).all()
    .map((row) => Number(row.session_id)).filter((id) => !future.has(id));
  const excludedSessions = [...new Set([...futureSessions, ...spanning])];

  const rows = database.prepare(`
    ${CANDIDATE_OUTPUT_SQL}
    FROM cache_candidate c
    JOIN usage_event cu
      ON cu.source_id = c.source_id AND cu.source_offset = c.source_offset
    JOIN usage_event pu
      ON pu.source_id = c.source_id AND pu.source_offset = c.previous_offset
    LEFT JOIN usage_event_boundary b
      ON b.source_id = c.source_id AND b.source_offset = c.source_offset
    JOIN model m ON m.id = cu.model_id
    JOIN model pm ON pm.id = pu.model_id
    JOIN tier_semantics t ON t.id = cu.tier_id
    JOIN source s ON s.id = c.source_id
    WHERE cu.observed_at_ms <= ?
      AND c.session_id NOT IN (SELECT value FROM json_each(?))`)
    .all(futureLimitMs, JSON.stringify(excludedSessions));

  if (spanning.length > 0) {
    // Sessions spanning several sources: one sentinel at the latest request.
    for (const row of database.prepare(`
      SELECT MAX(u.observed_at_ms) AS latest_observed_at_ms
      FROM usage_event u
      WHERE ${positiveInput("u")} AND u.observed_at_ms <= ? ${committedClause(committedOnly)}
        AND u.session_id IN (SELECT value FROM json_each(?))
      GROUP BY u.session_id`).iterate(futureLimitMs, JSON.stringify(spanning))) {
      rows.push({
        ...SENTINEL_ROW,
        observed_at_ms: row.latest_observed_at_ms,
        ordering_coverage_gap: 1,
      });
    }
  }
  if (futureSessions.length > 0) {
    rows.push(...readLocalIndexCacheCandidateRowsExact(database, futureLimitMs, {
      committedOnly, sessionIds: futureSessions,
    }));
  }
  return sortCandidateRows(rows);
}

/** Both cache-impact lenses over the committed facts. */
export function readLocalIndexCacheImpacts(database, {
  nowMs,
  pricer = createAccountingPricer(),
  declaredSpeedBaselines = [],
  committedOnly = hasProvisionalFacts(database),
} = {}) {
  try {
    return analyzeCacheImpactRows(
      readLocalIndexCacheCandidateRows(database, nowMs + FUTURE_SKEW_MS, { committedOnly }),
      {
        nowMs,
        pricer,
        declaredSpeedBaselines,
        // The store records every compaction and turn-context boundary it
        // observes, so its one parser label proves them.
        boundaryParser: (value) => value === LOCAL_INDEX_PARSER_VERSION,
      },
    );
  } catch {
    // The usage figures stay useful when this optional diagnostic cannot be
    // evaluated. Never substitute a zero for a failed transition read.
    return {
      cacheSwitchImpact: unavailableCacheSwitchImpact("cache_switch_impact_unavailable"),
      cacheContinuityImpact: unavailableCacheContinuityImpact(
        "cache_continuity_impact_unavailable",
      ),
    };
  }
}

/**
 * Whether every source supplied its tool history. A source that skipped tool
 * records or had no tool history to read makes the totals understate use, so
 * the projection is withheld rather than shown as a count.
 */
export function localIndexToolProvenanceComplete(database) {
  return database.prepare(`
    SELECT 1 AS missing FROM source_diagnostic
    WHERE code IN ('toolRecordsSkipped', 'toolSourceHistoryUnavailable')
      AND count > 0
    LIMIT 1`).get() === undefined;
}

/** Tool-class counts over committed facts; empty when provenance is incomplete. */
export function readLocalIndexTools(database) {
  const counts = Object.fromEntries([...KNOWN_TOOL_CLASSES].map((name) => [name, 0]));
  let total = 0;
  if (!localIndexToolProvenanceComplete(database)) return { total, counts };
  for (const row of database.prepare(`
    SELECT f.tool_class AS tool_class, COUNT(*) AS count
    FROM tool_class_fact f JOIN source s ON s.id = f.source_id
    WHERE f.source_offset <= s.scanned_bytes
    GROUP BY f.tool_class`).iterate()) {
    const count = Number(row.count);
    const toolClass = KNOWN_TOOL_CLASSES.has(row.tool_class) ? row.tool_class : "other";
    counts[toolClass] += count;
    total += count;
  }
  return { total, counts };
}

/** Catalog counts the companion shows beside the figures. */
export function readLocalIndexCoverage(database) {
  const totals = database.prepare(`
    SELECT COUNT(*) AS sources,
           COALESCE(SUM(size_bytes), 0) AS bytes,
           COALESCE(SUM(presence = 'present'), 0) AS present,
           COALESCE(SUM(CASE WHEN presence = 'present' THEN size_bytes ELSE 0 END), 0) AS present_bytes,
           COALESCE(SUM(quarantine_code IS NULL AND presence = 'present'), 0) AS indexed,
           COALESCE(SUM(CASE WHEN quarantine_code IS NULL AND presence = 'present'
                             THEN size_bytes ELSE 0 END), 0) AS indexed_bytes,
           COALESCE(SUM(quarantine_code IS NOT NULL), 0) AS skipped,
           COALESCE(SUM(CASE WHEN quarantine_code IS NOT NULL THEN size_bytes ELSE 0 END), 0) AS skipped_bytes
    FROM source`).get();
  const issues = {};
  for (const row of database.prepare(`
    SELECT quarantine_code AS code, COUNT(*) AS count FROM source
    WHERE quarantine_code IS NOT NULL GROUP BY quarantine_code`).iterate()) {
    issues[row.code] = Number(row.count);
  }
  const skippedThreads = Number(database.prepare(`
    SELECT COUNT(DISTINCT session_id) AS n FROM source
    WHERE quarantine_code IS NOT NULL AND session_id IS NOT NULL`).get().n);
  return {
    sourceCount: Number(totals.sources),
    sourceBytes: Number(totals.bytes),
    discoveredSourceCount: Number(totals.present),
    discoveredSourceBytes: Number(totals.present_bytes),
    indexedSourceCount: Number(totals.indexed),
    indexedSourceBytes: Number(totals.indexed_bytes),
    skippedSourceCount: Number(totals.skipped),
    skippedSourceBytes: Number(totals.skipped_bytes),
    skippedThreadCount: skippedThreads,
    rolloutIssueCounts: issues,
  };
}

/**
 * The first instant after `nowMs` at which a report read at `nowMs` can
 * change without any commit: a fact crossing a period boundary, or a fact
 * entering the future cutoff. `Infinity` when nothing is pending.
 *
 * It is computed over every stored fact, committed or not, which can only make
 * the answer earlier, never later. Call inside `withReadSnapshot`.
 */
export function readLocalIndexReportValidUntil(database, { nowMs, includeWorkUsage = false } = {}) {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be a finite epoch timestamp");
  const boundaries = [];
  const earliestAtOrAfter = (table, thresholdMs, inclusive) => {
    const row = database.prepare(`
      SELECT MIN(observed_at_ms) AS at FROM ${table}
      WHERE observed_at_ms ${inclusive ? ">=" : ">"} ?`).get(thresholdMs);
    return row?.at === null || row?.at === undefined ? null : Number(row.at);
  };
  for (const definition of PERIOD_DEFINITIONS) {
    if (!Number.isFinite(definition.spanMs)) continue;
    // Membership uses >= at the lower bound, so the row expires on the first
    // millisecond after this exact equality.
    const at = earliestAtOrAfter("usage_event", nowMs - definition.spanMs, true);
    if (Number.isSafeInteger(at)) boundaries.push(at + definition.spanMs + 1);
  }
  for (const table of ["usage_event", "quota_observation"]) {
    const at = earliestAtOrAfter(table, nowMs + FUTURE_SKEW_MS, false);
    if (Number.isSafeInteger(at)) boundaries.push(at - FUTURE_SKEW_MS);
  }
  if (includeWorkUsage) {
    const at = earliestAtOrAfter("usage_event", nowMs, true);
    if (Number.isSafeInteger(at)) boundaries.push(at + 1);
  }
  const pending = boundaries.filter((value) => value > nowMs);
  return pending.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...pending);
}

/**
 * One consistent read: usage, quota series, tools and coverage from a single
 * snapshot, keyed by `commit_seq`. Call inside `withReadSnapshot`.
 */
export function readLocalIndexReport(database, options = {}) {
  const startedAt = performance.now();
  const nowMs = options.nowMs ?? Date.now();
  const commitSeq = readCommitSeq(database);
  const provisional = hasProvisionalFacts(database);
  const pricer = options.pricer ?? createAccountingPricer();
  const usage = readLocalIndexUsage(database, {
    nowMs,
    declaredSpeedBaselines: options.declaredSpeedBaselines ?? [],
    pricer,
  });
  const committedOnly = provisional;
  const quota = readLocalIndexQuotaSeries(database, ["codex"], nowMs, { committedOnly });
  const sparkQuota = readLocalIndexQuotaSeries(
    database, SPARK_QUOTA_LIMIT_IDS, nowMs, { committedOnly },
  );
  const quotaObservations = Number(database.prepare(
    committedOnly
      ? `SELECT COUNT(*) AS c FROM quota_observation WHERE EXISTS (
           SELECT 1 FROM quota_occurrence o JOIN source s ON s.id = o.source_id
           WHERE o.canonical_observation_id = quota_observation.id
             AND o.source_offset <= s.scanned_bytes)`
      : "SELECT COUNT(*) AS c FROM quota_observation",
  ).get().c);
  const coverage = readLocalIndexCoverage(database);
  const impacts = readLocalIndexCacheImpacts(database, {
    nowMs,
    pricer,
    declaredSpeedBaselines: options.declaredSpeedBaselines ?? [],
    committedOnly: provisional,
  });
  return {
    status: "available",
    errorCode: null,
    commitSeq,
    buildInProgress: provisional,
    coveredAt: {
      startAt: isoOrNull(usage.firstObservedMs),
      endAt: isoOrNull(usage.lastObservedMs),
    },
    usageEvents: usage.usageEvents,
    quotaObservations,
    ...coverage,
    latestExportableRecordAt: isoOrNull(usage.lastObservedMs),
    tools: readLocalIndexTools(database),
    toolCoverageStatus: localIndexToolProvenanceComplete(database) ? "complete" : "partial",
    toolCoverageBlockReason: localIndexToolProvenanceComplete(database)
      ? null
      : "tool_provenance_incomplete",
    usage: usage.usage,
    cacheSwitchImpact: impacts.cacheSwitchImpact,
    cacheContinuityImpact: impacts.cacheContinuityImpact,
    timeline: {
      ...usage.timeline,
      quota,
      sparkQuota,
    },
    expandedBuckets: usage.expandedBuckets,
    readWallMs: performance.now() - startedAt,
  };
}
