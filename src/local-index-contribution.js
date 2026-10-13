import {
  createTelemetryV1IndexReaderFromSource,
} from "./contribution/telemetry-v1-chunks.js";
import {
  createTelemetryV11ReaderFromSource,
  localTelemetryV11Failure,
} from "./local-index-contribution-attribution.js";
import { readCommitSeq } from "./local-index-store.js";

// Contribution reads over the local index store.
//
// The record rules (bounds, exclusions, ordering, digests, plan eras) live in
// the contribution owner's readers and are shared; this module supplies them
// the store's committed facts in the row shapes they consume. Because the
// rules are not duplicated, equal facts give byte-identical chunks, and the
// continuity of hosted identifiers is a property of the facts, not of this
// module.
//
// Everything is read at or below each source's cursor: a parallel build's
// provisional facts are never contributed.

const COMMITTED = "u.source_offset <= src.scanned_bytes";

/**
 * The per-row parser label the shipping index records, rebuilt from the
 * store's provenance flags: the label is a closed vocabulary that the v1.0
 * stamp and the v1.2 boundary evidence read.
 */
function parserLabelSql(alias, base) {
  const literal = `'${String(base).replaceAll("'", "''")}'`;
  return `${literal}
    || CASE WHEN (${alias}.flags & 2) != 0 THEN '-parent-model' ELSE '' END
    || CASE WHEN (${alias}.flags & 1) != 0 THEN '-partial' ELSE '' END
    || CASE WHEN (${alias}.flags & 4) != 0 THEN '-cache-write-zero' ELSE '' END`;
}

/** Row source for the v1.0 chunk derivation. */
export function createLocalIndexTelemetryV1Source(database, {
  outcomeUnknownOrdinal,
  parserVersionBase,
}) {
  if (!Number.isSafeInteger(outcomeUnknownOrdinal) || typeof parserVersionBase !== "string") {
    throw new TypeError("outcome ordinal and parser version base are required");
  }
  const label = parserLabelSql("u", parserVersionBase);
  const usage = database.prepare(`
    SELECT u.event_key AS event_key,
           u.observed_at_ms AS observed_at_ms,
           ses.session_local AS session_local,
           ses.session_uuid AS session_uuid,
           m.model_id AS model_id,
           t.api_service_tier AS api_service_tier,
           t.billing_surface AS billing_surface,
           t.codex_speed_mode AS codex_speed_mode,
           sc.agent_scope AS agent_scope,
           sc.surface AS surface,
           u.reasoning_effort AS reasoning_effort,
           ${outcomeUnknownOrdinal} AS outcome,
           u.tokens_in_uncached AS tokens_in_uncached,
           u.tokens_in_cache_read AS tokens_in_cache_read,
           u.tokens_in_cache_write AS tokens_in_cache_write,
           u.tokens_out_text AS tokens_out_text,
           u.tokens_out_reasoning AS tokens_out_reasoning,
           u.tokens_out_combined AS tokens_out_combined,
           u.total_input_context AS total_input_context,
           ${label} AS parser_version
    FROM usage_event u
    JOIN source src ON src.id = u.source_id
    JOIN session ses ON ses.id = u.session_id
    JOIN model m ON m.id = u.model_id
    JOIN tier_semantics t ON t.id = u.tier_id
    JOIN surface_class sc ON sc.id = u.surface_id
    WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ? AND ${COMMITTED}
    ORDER BY u.observed_at_ms, u.event_key`);
  const quota = database.prepare(`
    SELECT observed_at_ms, limit_id, slot, plan_type, used_percent,
           resets_at_ms, duration_mins
    FROM quota_observation
    WHERE observed_at_ms >= ? AND observed_at_ms < ?
    ORDER BY observed_at_ms, limit_id, slot`);
  const sessionFirsts = database.prepare(`
    SELECT ses.session_local AS session_local,
           MIN(u.observed_at_ms) AS first_ms,
           ses.session_uuid AS session_uuid
    FROM usage_event u
    JOIN source src ON src.id = u.source_id
    JOIN session ses ON ses.id = u.session_id
    WHERE ${COMMITTED}
    GROUP BY u.session_id
    ORDER BY first_ms, ses.session_local`);
  const toolClasses = database.prepare(`
    SELECT ses.session_local AS session_local, f.tool_class AS tool_class,
           COUNT(*) AS count
    FROM tool_class_fact f
    JOIN source src ON src.id = f.source_id
    JOIN session ses ON ses.id = f.session_id
    WHERE f.source_offset <= src.scanned_bytes
    GROUP BY f.session_id, f.tool_class
    ORDER BY ses.session_local, f.tool_class`);
  const sessionModels = database.prepare(`
    SELECT ses.session_local AS session_local, m.model_id AS model_id
    FROM usage_event u
    JOIN source src ON src.id = u.source_id
    JOIN session ses ON ses.id = u.session_id
    JOIN model m ON m.id = u.model_id
    WHERE ${COMMITTED}
    GROUP BY u.session_id, m.model_id
    ORDER BY ses.session_local, m.model_id`);
  const days = database.prepare(`
    SELECT DISTINCT day FROM (
      SELECT date(u.observed_at_ms / 1000, 'unixepoch') AS day
      FROM usage_event u JOIN source src ON src.id = u.source_id
      WHERE ${COMMITTED}
      UNION
      SELECT date(observed_at_ms / 1000, 'unixepoch') AS day FROM quota_observation
    )
    ORDER BY day`);
  return Object.freeze({
    usageRows: (startMs, endMs) => usage.iterate(startMs, endMs),
    quotaRows: (startMs, endMs) => quota.iterate(startMs, endMs),
    sessionFirsts: () => sessionFirsts.all(),
    toolClassRows: () => toolClasses.all(),
    sessionModelRows: () => sessionModels.all(),
    days: () => days.all().map((row) => row.day),
  });
}

/**
 * Plan label and usage interval of one usage row, by the rules the shipping
 * index's attribution reader applies: the one distinct admitted plan reported
 * on the very record is its label; the interval starts at the latest earlier
 * record of the session (another source) or, failing that or when the same
 * source holds a later-or-equal one, at the previous record of the source. A
 * predecessor dated after the row is a reversed clock and yields no interval.
 */
export function createLocalIndexUsageAttributionReader(database) {
  const sources = new Map();
  for (const row of database.prepare(
    "SELECT id, source_local, source_ordinal, session_id, scanned_bytes FROM source",
  ).iterate()) {
    sources.set(Buffer.from(row.source_local).toString("hex"), {
      id: Number(row.id),
      ordinal: Number(row.source_ordinal),
      sessionId: row.session_id === null ? null : Number(row.session_id),
      scannedBytes: Number(row.scanned_bytes),
    });
  }
  const sessions = new Map();
  const sessionId = (local) => {
    const key = Buffer.from(local).toString("hex");
    if (!sessions.has(key)) {
      const found = database.prepare("SELECT id FROM session WHERE session_local = ?")
        .get(Buffer.from(local));
      sessions.set(key, found === undefined ? null : Number(found.id));
    }
    return sessions.get(key);
  };
  const plans = database.prepare(`
    SELECT DISTINCT plan_type FROM quota_occurrence
    WHERE source_id = ? AND source_offset = ? AND observed_at_ms = ?
      AND provider = 'openai_codex' AND admission = 'admitted'
      AND plan_type IS NOT NULL AND plan_type <> 'unknown'
    ORDER BY plan_type LIMIT 2`);
  const sourceBefore = database.prepare(`
    SELECT source_offset, observed_at_ms FROM usage_event
    WHERE source_id = ? AND source_offset < ?
    ORDER BY source_offset DESC LIMIT 1`);
  const sessionBefore = database.prepare(`
    SELECT MAX(p.observed_at_ms) AS observed_at_ms
    FROM usage_event p JOIN source ps ON ps.id = p.source_id
    WHERE p.session_id = ? AND p.source_id <> ?
      AND p.source_offset <= ps.scanned_bytes
      AND p.observed_at_ms >= ? AND p.observed_at_ms < ?`);
  const MINIMUM_MS = -8_640_000_000_000_000;
  return Object.freeze({
    read(row) {
      const result = {
        planAttribution: { basis: "unavailable", planType: null, planVariant: null },
        usageIntervalStartedAt: null,
        usageIntervalBasis: "unavailable",
      };
      const sourceLocal = row?.source_local;
      if (!(sourceLocal instanceof Uint8Array) || sourceLocal.length !== 32
          || !Number.isSafeInteger(row.source_offset) || row.source_offset < 0
          || !Number.isSafeInteger(row.source_ordinal) || row.source_ordinal < 0) {
        return result;
      }
      const member = sources.get(Buffer.from(sourceLocal).toString("hex"));
      if (member === undefined || member.ordinal !== row.source_ordinal
          || row.source_offset > member.scannedBytes) return result;
      const observedMs = Number(row.observed_at_ms);
      const observedPlans = plans.all(member.id, row.source_offset, observedMs)
        .map((value) => value.plan_type);
      if (observedPlans.length === 1) {
        result.planAttribution.basis = "same_record";
        result.planAttribution.planType = observedPlans[0];
      } else if (observedPlans.length > 1) {
        result.planAttribution.basis = "conflicted";
      }
      const before = sourceBefore.get(member.id, row.source_offset);
      const sourcePreviousMs = before === undefined ? null : Number(before.observed_at_ms);
      // Physical order can positively reveal a reversed clock. Do not hide
      // that contradiction by picking some earlier wall-clock timestamp.
      if (sourcePreviousMs !== null && sourcePreviousMs > observedMs) return result;
      const rowSession = sessionId(row.session_local);
      // One source belongs to one session; the row's session must be it.
      const lineage = rowSession !== null && rowSession === member.sessionId;
      let previousMs = null;
      let basis = "unavailable";
      if (lineage) {
        const other = sessionBefore.get(
          rowSession, member.id,
          sourcePreviousMs === null ? MINIMUM_MS : sourcePreviousMs,
          observedMs,
        );
        previousMs = other?.observed_at_ms === null || other === undefined
          ? null : Number(other.observed_at_ms);
        if (sourcePreviousMs !== null
            && (previousMs === null || sourcePreviousMs >= previousMs)) {
          previousMs = sourcePreviousMs;
        }
        if (previousMs !== null) basis = "previous_session_record";
      }
      if (previousMs === null && sourcePreviousMs !== null) {
        previousMs = sourcePreviousMs;
        basis = "previous_source_record";
      }
      if (previousMs !== null) {
        result.usageIntervalStartedAt = new Date(previousMs).toISOString();
        result.usageIntervalBasis = basis;
      }
      return result;
    },
  });
}

/** Row source for the v1.1 attribution reader. */
export function createLocalIndexTelemetryV11Source(database, ports) {
  const { outcomeName, reasoningEffortName, fallbackParserVersion } = ports;
  const label = parserLabelSql("u", ports.parserVersionBase);
  const quotaSql = `
    SELECT src.source_local AS source_local, q.source_offset AS source_offset,
           src.source_ordinal AS source_ordinal, q.observed_at_ms AS observed_at_ms,
           q.plan_type AS plan_type, q.provider AS provider, q.limit_id AS limit_id,
           q.slot AS slot, q.slot_order AS slot_order, q.used_percent AS used_percent,
           q.resets_at_ms AS resets_at_ms, q.duration_mins AS duration_mins
    FROM quota_occurrence q JOIN source src ON src.id = q.source_id
    WHERE q.admission = 'admitted' AND q.source_offset <= src.scanned_bytes`;
  const quotaDay = database.prepare(`${quotaSql}
    AND q.observed_at_ms >= ? AND q.observed_at_ms < ?
    ORDER BY q.observed_at_ms, src.source_local, q.source_offset, q.slot_order LIMIT ?`);
  const allQuota = database.prepare(`${quotaSql}
    ORDER BY q.observed_at_ms, src.source_local, q.source_offset, q.slot_order`);
  const usageRaw = database.prepare(`
    SELECT u.event_key AS event_key, src.source_local AS source_local,
           u.source_offset AS source_offset, src.source_ordinal AS source_ordinal,
           ses.session_local AS session_local, u.observed_at_ms AS observed_at_ms
    FROM usage_event u
    JOIN source src ON src.id = u.source_id
    JOIN session ses ON ses.id = u.session_id
    WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ? AND ${COMMITTED}
    ORDER BY u.observed_at_ms, u.event_key LIMIT ?`);
  const usageEvidence = database.prepare(`
    SELECT u.event_key AS event_key, src.source_local AS source_local,
           u.source_offset AS source_offset, src.source_ordinal AS source_ordinal,
           ses.session_local AS session_local, u.observed_at_ms AS observed_at_ms,
           ${label} AS parser_version,
           CASE WHEN b.source_id IS NULL THEN NULL ELSE u.event_key END
             AS boundary_event_key,
           b.compaction_before AS compaction_before,
           b.turn_context_before AS turn_context_before,
           b.compacted_at_ms AS compacted_at_ms,
           ses.session_local AS boundary_session_local,
           ${label} AS boundary_parser_version,
           src.source_local AS evidence_source_local,
           u.source_offset AS evidence_source_offset,
           src.source_ordinal AS evidence_source_ordinal
    FROM usage_event u
    JOIN source src ON src.id = u.source_id
    JOIN session ses ON ses.id = u.session_id
    LEFT JOIN usage_event_boundary b
      ON b.source_id = u.source_id AND b.source_offset = u.source_offset
    WHERE u.observed_at_ms >= ? AND u.observed_at_ms < ? AND ${COMMITTED}
    ORDER BY u.observed_at_ms, u.event_key LIMIT ?`);
  const quotaDays = database.prepare(`
    SELECT DISTINCT date(q.observed_at_ms / 1000, 'unixepoch') AS day
    FROM quota_occurrence q JOIN source src ON src.id = q.source_id
    WHERE q.admission = 'admitted' AND q.source_offset <= src.scanned_bytes
    ORDER BY day`);
  const canonicalCount = database.prepare(`
    SELECT COUNT(*) AS count FROM quota_observation
    WHERE observed_at_ms >= ? AND observed_at_ms < ?`);
  const dataVersion = () => Number(database.prepare("PRAGMA data_version").get().data_version);

  return Object.freeze({
    snapshot(read) {
      database.exec("SAVEPOINT telemetry_v11_attribution_read");
      try {
        const commitSeq = readCommitSeq(database);
        const key = `${commitSeq}:${dataVersion()}`;
        const result = read({ id: commitSeq, key });
        database.exec("RELEASE telemetry_v11_attribution_read");
        return result;
      } catch (error) {
        database.exec("ROLLBACK TO telemetry_v11_attribution_read");
        database.exec("RELEASE telemetry_v11_attribution_read");
        if (typeof error?.code === "string" && error.code.startsWith("local_telemetry_v11_")) throw error;
        throw localTelemetryV11Failure("index_unavailable");
      }
    },
    initialize(descriptor, bounds) {
      const count = (sql) => Number(database.prepare(sql).get().count);
      if (count("SELECT COUNT(*) AS count FROM session") > bounds.sessions
          || count(`SELECT COUNT(*) AS count FROM (
               SELECT 1 FROM usage_event GROUP BY session_id, model_id)`) > bounds.sessionModels
          || count(`SELECT COUNT(*) AS count FROM (
               SELECT 1 FROM tool_class_fact GROUP BY session_id, tool_class)`) > bounds.toolClasses) {
        throw localTelemetryV11Failure("corpus_limit_exceeded");
      }
      return {
        base: createTelemetryV1IndexReaderFromSource(
          createLocalIndexTelemetryV1Source(database, ports),
          { outcomeName, reasoningEffortName, fallbackParserVersion },
        ),
        usage: createLocalIndexUsageAttributionReader(database),
      };
    },
    allQuotaRows: () => allQuota.iterate(),
    quotaDayRows: (descriptor, start, end, limit) => quotaDay.all(start, end, limit),
    usageRawRows: (descriptor, start, end, limit) => usageRaw.all(start, end, limit),
    usageEvidenceRows: (descriptor, start, end, limit) => usageEvidence.all(start, end, limit),
    quotaDays: () => quotaDays.all().map((row) => row.day),
    canonicalQuotaCount: (start, end) => Number(canonicalCount.get(start, end).count),
  });
}

/** The v1.0 chunk reader over the store. */
export function createLocalIndexTelemetryV1IndexReader(database, ports) {
  const { outcomeName, reasoningEffortName, fallbackParserVersion } = ports;
  return createTelemetryV1IndexReaderFromSource(
    createLocalIndexTelemetryV1Source(database, ports),
    { outcomeName, reasoningEffortName, fallbackParserVersion },
  );
}

/** The v1.1/v1.2 attribution reader over the store. */
export function createLocalIndexTelemetryV11Reader(database, ports = {}) {
  return createTelemetryV11ReaderFromSource(
    createLocalIndexTelemetryV11Source(database, ports),
    { accountMarkers: ports.accountMarkers ?? [], limits: ports.limits ?? {} },
  );
}
