import { DEFAULT_UNKNOWN_SPEED_POLICY, validateUnknownSpeedPolicy, unknownSpeedScenario, unknownSpeedCalibrationOptions } from "./unknown-speed-policy.js";
import { openLocalIndexStore, readCommitSeq } from "./local-index-store.js";
import { REPLAY_SAFE_CALIBRATION_INTERNALS } from "./replay-safe-accounting-cache.js";
import { readCodexLocalThreadUsageRelations } from "./platform/index.js";
import { buildWeeklyApiIntervals, unavailableWeeklyApiIntervals } from "./weekly-api-intervals.js";
import { speedApiPrice } from "./speed-api-cost.js";
import { createLocalRefreshTimer } from "./local-refresh-timing.js";

const {
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
  fitPlanCompositionsFromCorpus,
  historicalPlanComparisonReceipts,
  fixedError,
  planScopedTimelineReceipt,
  projectBoundedWeeklyCalibrationSummary,
  safeModel,
  throwIfAborted,
  transitionResourceLimits,
  transitionUsageProjection,
  weeklyRateLimitProjection,
} = REPLAY_SAFE_CALIBRATION_INTERNALS;

// ---------------------------------------------------------------------------
// Layer C over the local index store.
//
// The calibration corpus, the composition fit and the weekly derivation are
// unchanged: they consume a streaming corpus object. This opener supplies one
// from the store's committed facts under a single read snapshot, so none of
// the generation fencing the shipping index needs applies (a commit cannot
// change what an open read transaction sees).
//
// Row attribution (plan label and usage interval) is computed once, in SQL,
// by window functions over each source's byte order, and kept in the same thin
// typed columns the shipping corpus uses.
// ---------------------------------------------------------------------------

const LOCAL_INDEX_ATTRIBUTION_BASES = ["unavailable", "same_record", "conflicted"];
const LOCAL_INDEX_INTERVAL_BASES = [
  "unavailable",
  "previous_session_record",
  "previous_source_record",
];
// (source id, source offset, observed ms) stamp per retained row.
const LOCAL_INDEX_USAGE_STAMP_BYTES = 24;
const LOCAL_INDEX_MINIMUM_MS = -8_640_000_000_000_000;
// Conservative real size of one resident compact row (the byte meter charges
// less); rows stay resident only when this many bytes per event fit.
const LOCAL_INDEX_RESIDENT_ROW_BYTES = 700;

export async function openLocalIndexCalibrationCorpus({
  indexFile,
  endMs,
  limits,
  declaredSpeedBaselines = [],
  signal = null,
  checkRuntimeMemory = () => {},
  onTiming = null, monotonicClock = undefined,
}) {
  const timing = createLocalRefreshTimer({onTiming,clock:monotonicClock});
  let database;
  try {
    database = openLocalIndexStore(indexFile, { readOnly: true });
  } catch {
    return null;
  }
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    try { database.exec("COMMIT"); } catch { /* no transaction left open */ }
    try { database.close(); } catch { /* a close failure cannot widen the handle */ }
  };
  try {
    database.exec("BEGIN");
    const commitSeq = readCommitSeq(database);
    const usageGraceMs = endMs + 5 * 60_000;
    const price = createAccountingPricer();
    let weeklyApiOrigins = new Map();
    const weeklyApiAccountScopes=new Map(database.prepare("SELECT id,status,scope_local FROM account_scope").all()
      .map(row=>[Number(row.id),row.status==='available'&&row.scope_local!==null?Number(row.id):null]));
    const planEvidence = calibrationPlanEvidence({ ordered: true, maximum: limits.weeklySnapshots });
    let processed = 0;
    const cadence = async () => {
      processed += 1;
      if (processed % ACCOUNTING_RSS_CHECK_INTERVAL === 0) {
        throwIfAborted(signal);
        checkRuntimeMemory();
        await cooperativeYield();
      }
    };
    const nullableTokenValue = (value) => (
      value !== null && value !== undefined
        && Number.isSafeInteger(Number(value)) && Number(value) >= 0
        ? Number(value)
        : null
    );
    const tokenValue = (value) => nullableTokenValue(value) ?? 0;
    // Same predicate as the shipping corpus: eventProjection returns null only
    // for an all-zero component total, and Spark rows are excluded.
    const retainedByLightFilter = (row) => {
      if (!Number.isSafeInteger(Number(row.observed_at_ms))) return false;
      const anyTokens = tokenValue(row.tokens_in_uncached) > 0
        || tokenValue(row.tokens_in_cache_read) > 0
        || tokenValue(row.tokens_in_cache_write) > 0
        || tokenValue(row.tokens_out_text) > 0
        || tokenValue(row.tokens_out_reasoning) > 0
        || tokenValue(row.tokens_out_combined) > 0;
      return anyTokens && safeModel(row.model_id) !== SPARK_MODEL;
    };

    const usageCount = Number(database.prepare(`
      SELECT COUNT(*) AS c FROM usage_event u JOIN source s ON s.id = u.source_id
      WHERE u.observed_at_ms <= ? AND u.source_offset <= s.scanned_bytes`)
      .get(usageGraceMs)?.c ?? 0);
    if (usageCount === 0) {
      dispose();
      return null;
    }
    const stampBytes = usageCount * LOCAL_INDEX_USAGE_STAMP_BYTES;
    if (!Number.isSafeInteger(stampBytes) || stampBytes > limits.retainedBytes) {
      throw fixedError("accounting_transition_memory_budget_exceeded");
    }
    checkRuntimeMemory(stampBytes);
    const stampedMs = new Float64Array(usageCount);
    const stampedSource = new Float64Array(usageCount);
    const stampedOffset = new Float64Array(usageCount);
    const memoBasis = new Uint8Array(usageCount);
    const memoPlan = new Int32Array(usageCount);
    const memoIntervalMs = new Float64Array(usageCount);
    const memoIntervalBasis = new Uint8Array(usageCount);
    const memoPlanTable = [];
    const memoPlanIndex = new Map();

    // One ordered pass: stamps and attribution together. LAG runs over every
    // committed event of a source, whatever its date, because a predecessor
    // dated after the request is itself evidence (a reversed clock).
    const openStatement = database.prepare(`
      WITH ordered AS (
        SELECT u.source_id, u.source_offset, u.session_id, u.account_scope_id, u.observed_at_ms,
               u.model_id AS model_ref, u.tier_id,
               u.tokens_in_uncached, u.tokens_in_cache_read, u.tokens_in_cache_write,
               u.tokens_out_text, u.tokens_out_reasoning, u.tokens_out_combined,
               u.total_input_context,
               LAG(u.observed_at_ms) OVER source_order AS source_previous_ms
        FROM usage_event u JOIN source s ON s.id = u.source_id
        WHERE u.source_offset <= s.scanned_bytes
        WINDOW source_order AS (PARTITION BY u.source_id ORDER BY u.source_offset)
      )
      SELECT o.source_id, o.source_offset, o.session_id, o.account_scope_id, o.observed_at_ms,
             m.model_id AS model_id, t.codex_speed_mode AS codex_speed_mode,
             t.api_service_tier AS api_service_tier,
             o.tokens_in_uncached, o.tokens_in_cache_read, o.tokens_in_cache_write,
             o.tokens_out_text, o.tokens_out_reasoning, o.tokens_out_combined,
             o.total_input_context, o.source_previous_ms,
             CASE WHEN o.session_id IN (SELECT value FROM json_each(?)) THEN (
               SELECT MAX(p.observed_at_ms) FROM usage_event p
                JOIN source ps ON ps.id = p.source_id
                WHERE p.session_id = o.session_id AND p.source_id <> o.source_id
                  AND p.source_offset <= ps.scanned_bytes
                  AND p.observed_at_ms >= COALESCE(o.source_previous_ms, ?)
                  AND p.observed_at_ms < o.observed_at_ms) END AS session_before_ms
      FROM ordered o
      JOIN model m ON m.id = o.model_ref
      JOIN tier_semantics t ON t.id = o.tier_id
      WHERE o.observed_at_ms <= ?
      ORDER BY o.observed_at_ms, o.source_id, o.source_offset`);
    // The distinct admitted plans reported on each record, once for the whole
    // pass. One is the row's label; more than one is a conflict, whichever
    // plans they are. Keyed by (source, offset); the instant must agree too.
    const recordPlans = new Map();
    for (const planRow of database.prepare(`
      SELECT source_id, source_offset, observed_at_ms,
             MIN(plan_type) AS plan_first, COUNT(DISTINCT plan_type) AS plan_count
      FROM quota_occurrence
      WHERE provider = 'openai_codex' AND admission = 'admitted'
        AND plan_type IS NOT NULL AND plan_type <> 'unknown'
      GROUP BY source_id, source_offset, observed_at_ms`).iterate()) {
      const key = `${planRow.source_id}:${planRow.source_offset}`;
      const known = recordPlans.get(key);
      // The same record at two instants is two records: keep both by instant.
      if (known === undefined) {
        recordPlans.set(key, [planRow]);
      } else {
        known.push(planRow);
      }
    }
    // Sessions spread over several sources need the cross-source lookback;
    // for every other session it is provably empty and is not evaluated.
    const spanningSessions = JSON.stringify(database.prepare(`
      SELECT session_id FROM source WHERE session_id IS NOT NULL
      GROUP BY session_id HAVING COUNT(*) > 1`).all().map((row) => Number(row.session_id)));
    // Real cost of a resident compact row is about twice what the byte meter
    // charges for it; only keep them when even that fits the budget.
    const residentRows = usageCount * (LOCAL_INDEX_RESIDENT_ROW_BYTES + LOCAL_INDEX_USAGE_STAMP_BYTES + 14)
      <= limits.retainedBytes
      ? []
      : null;
    let retainedUsageEvents = 0;
    for (const row of openStatement.iterate(spanningSessions, LOCAL_INDEX_MINIMUM_MS, usageGraceMs)) {
      await cadence();
      if (!retainedByLightFilter(row)) continue;
      if (retainedUsageEvents >= usageCount) {
        throw fixedError("accounting_unified_generation_changed");
      }
      const position = retainedUsageEvents;
      const observedMs = Number(row.observed_at_ms);
      stampedMs[position] = observedMs;
      stampedSource[position] = Number(row.source_id);
      stampedOffset[position] = Number(row.source_offset);
      // Plan: the one distinct admitted plan reported on this very record.
      const planned = recordPlans.get(`${row.source_id}:${row.source_offset}`)
        ?.find((candidate) => Number(candidate.observed_at_ms) === observedMs);
      const planCount = planned === undefined ? 0 : Number(planned.plan_count);
      let basis = 0;
      let planIndex = -1;
      if (planCount === 1) {
        basis = 1;
        const planType = typeof planned.plan_first === "string" && planned.plan_first.length <= 64
          ? planned.plan_first : "unknown";
        planIndex = memoPlanIndex.get(planType) ?? -1;
        if (planIndex === -1) {
          planIndex = memoPlanTable.push(planType) - 1;
          memoPlanIndex.set(planType, planIndex);
        }
      } else if (planCount > 1) {
        basis = 2;
      }
      // Interval: physical order can positively reveal a reversed clock; do
      // not hide it by choosing some earlier wall-clock record.
      const sourcePreviousMs = row.source_previous_ms === null
        ? null : Number(row.source_previous_ms);
      let intervalMs = Number.NaN;
      let intervalBasis = 0;
      if (sourcePreviousMs === null || sourcePreviousMs <= observedMs) {
        let previousMs = row.session_before_ms === null
          ? null : Number(row.session_before_ms);
        // Equal-time order is meaningful inside one source only.
        if (sourcePreviousMs !== null
            && (previousMs === null || sourcePreviousMs >= previousMs)) {
          previousMs = sourcePreviousMs;
        }
        if (previousMs !== null) {
          intervalMs = previousMs;
          intervalBasis = 1;
        }
      }
      memoBasis[position] = basis + 1;
      memoPlan[position] = planIndex;
      memoIntervalMs[position] = intervalMs;
      memoIntervalBasis[position] = intervalBasis;
      if (residentRows !== null) {
        const projected = projectUsageRow(row, position);
        // The light filter refuses exactly the rows that project to null, so a
        // null here means the facts moved under the read.
        if (projected === null) throw fixedError("accounting_unified_generation_changed");
        residentRows.push(Object.freeze(projected));
      }
      retainedUsageEvents += 1;
    }
    if (retainedUsageEvents === 0) {
      dispose();
      return null;
    }
    const usageMs = stampedMs.subarray(0, retainedUsageEvents);
    const usageSource = stampedSource.subarray(0, retainedUsageEvents);
    const usageOffset = stampedOffset.subarray(0, retainedUsageEvents);
    const firstUsageMs = usageMs[0];
    const usageMetadataBytes = stampedMs.byteLength + stampedSource.byteLength
      + stampedOffset.byteLength + memoBasis.byteLength + memoPlan.byteLength
      + memoIntervalMs.byteLength + memoIntervalBasis.byteLength;
    if (usageMetadataBytes > limits.retainedBytes) {
      throw fixedError("accounting_transition_memory_budget_exceeded");
    }
    // What the cache records, and its validator recomputes, is the meter the
    // shipping corpus charges per row. The budget checks in this module use
    // the real resident size, which is the stricter of the two.
    const meteredUsageMetadataBytes = usageCount * STREAMED_USAGE_STAMP_BYTES
      + retainedUsageEvents * STREAMED_USAGE_MEMO_BYTES;
    throwIfAborted(signal);
    checkRuntimeMemory();

    // Quota snapshots: admitted occurrences of the primary pool, collapsed to
    // the first and last observation of each unchanged (window, percent) run.
    const snapshotStatement = database.prepare(`
      SELECT q.observed_at_ms, q.slot, q.plan_type, q.used_percent,
             q.resets_at_ms, q.duration_mins, q.provider
      FROM quota_occurrence q JOIN source s ON s.id = q.source_id
      WHERE q.limit_id = 'codex' AND q.admission = 'admitted'
        AND q.source_offset <= s.scanned_bytes
        AND q.observed_at_ms >= ? AND q.observed_at_ms <= ?
      ORDER BY q.observed_at_ms, q.source_id, q.source_offset, q.slot_order`);
    const weeklyRateLimitSnapshots = [];
    let firstSnapshotMs = null;
    const groupRuns = new Map();
    let lastObservedPlan = null;
    let retainedInputBudgetExceeded = false;
    const reserveSnapshotRetention = () => {
      const retainedSnapshots = weeklyRateLimitSnapshots.length + 1;
      if (retainedSnapshots > limits.weeklySnapshots
          || usageMetadataBytes + retainedSnapshots * COMPACT_SNAPSHOT_RETAINED_BYTES
            > limits.retainedBytes) {
        retainedInputBudgetExceeded = true;
        return false;
      }
      return true;
    };
    const emit = (pending) => {
      if (!reserveSnapshotRetention()) return;
      weeklyRateLimitSnapshots.push(weeklyRateLimitProjection({
        timestamp: new Date(pending.observedMs).toISOString(),
        timestampMs: pending.observedMs,
        window: {
          provider: "openai_codex",
          planType: pending.planType,
          limitId: "codex",
          slot: pending.slot,
          windowDurationMins: pending.durationMins,
          resetsAt: pending.resetsAtSec,
          usedPercent: pending.usedPercent,
        },
      }));
    };
    for (const row of snapshotStatement.iterate(-1, endMs)) {
      if (retainedInputBudgetExceeded) break;
      await cadence();
      const observedMs = Number(row.observed_at_ms);
      planEvidence.observe({
        timestampMs: observedMs,
        window: { provider: row.provider, limitId: "codex", planType: row.plan_type },
      });
      if (typeof row.plan_type === "string" && row.plan_type !== "unknown") {
        if (lastObservedPlan !== null && row.plan_type !== lastObservedPlan) {
          for (const run of groupRuns.values()) if (run.pending) emit(run.pending);
          groupRuns.clear();
        }
        lastObservedPlan = row.plan_type;
      }
      const durationMins = Number(row.duration_mins);
      if (!ALLOWANCE_HISTORY_WINDOW_MINUTES.has(durationMins)
          || row.resets_at_ms === null || row.used_percent === null) continue;
      const resetsAtSec = Math.floor(Number(row.resets_at_ms) / 1_000);
      const usedPercent = Number(row.used_percent);
      if (!Number.isSafeInteger(observedMs)
          || !Number.isSafeInteger(resetsAtSec)
          || resetsAtSec <= 0
          || !Number.isFinite(usedPercent)) continue;
      if (firstSnapshotMs === null) firstSnapshotMs = observedMs;
      const projected = {
        observedMs,
        slot: row.slot,
        planType: typeof row.plan_type === "string" && row.plan_type.length > 0
          ? row.plan_type
          : "unknown",
        durationMins,
        usedPercent,
        resetsAtSec,
      };
      // Slot is a UI role, not identity: a run of identical displayed states
      // that crosses the slot flip is one run of the same window.
      const groupKey = `${projected.planType}\0${durationMins}\0${resetsAtSec}`;
      const run = groupRuns.get(groupKey);
      if (run !== undefined && run.usedPercent === usedPercent) {
        run.pending = projected;
        continue;
      }
      if (run?.pending) emit(run.pending);
      emit(projected);
      groupRuns.set(groupKey, { usedPercent, pending: null });
    }
    for (const run of groupRuns.values()) {
      if (run.pending) emit(run.pending);
    }
    if (retainedInputBudgetExceeded || weeklyRateLimitSnapshots.length === 0) {
      dispose();
      return null;
    }
    throwIfAborted(signal);
    checkRuntimeMemory();
    const coveredStartMs = firstSnapshotMs === null
      ? firstUsageMs
      : Math.min(firstUsageMs, firstSnapshotMs);

    // Re-read a retained range by key. Rows the open pass refused are refused
    // again by the shared predicate, so the stream yields exactly the retained
    // rows between its bounds.
    function projectUsageRow(row, position) {
      return timing.measureSync("corpus_project",()=>projectUsageRowCore(row,position),{aggregate:true});
    }
    function projectUsageRowCore(row, position) {
      const observedMs = Number(row.observed_at_ms);
      if (!Number.isSafeInteger(observedMs) || !retainedByLightFilter(row)) return null;
      const basisIndex = memoBasis[position];
      const planIndex = memoPlan[position];
      const intervalMs = memoIntervalMs[position];
      const rawEvent = {
        timestamp: new Date(observedMs).toISOString(),
        planAttribution: {
          basis: LOCAL_INDEX_ATTRIBUTION_BASES[basisIndex - 1],
          planType: planIndex < 0 ? null : memoPlanTable[planIndex],
          planVariant: null,
        },
        usageIntervalStartedAt: Number.isNaN(intervalMs)
          ? null
          : new Date(intervalMs).toISOString(),
        usageIntervalBasis: LOCAL_INDEX_INTERVAL_BASES[memoIntervalBasis[position]],
        model: row.model_id,
        ...(row.total_input_context === null
          ? {}
          : { totalInputContextTokens: Number(row.total_input_context) }),
        components: {
          input_uncached_tokens: nullableTokenValue(row.tokens_in_uncached),
          input_cache_read_tokens: nullableTokenValue(row.tokens_in_cache_read),
          input_cache_write_tokens: nullableTokenValue(row.tokens_in_cache_write),
          output_text_tokens: nullableTokenValue(row.tokens_out_text),
          output_reasoning_tokens: nullableTokenValue(row.tokens_out_reasoning),
          output_combined_tokens: nullableTokenValue(row.tokens_out_combined),
        },
        tierSemantics: {
          codexSpeedMode: row.codex_speed_mode,
          apiServiceTier: row.api_service_tier,
        },
      };
      const event = eventProjection(rawEvent, price);
      if (event === null || event.isSpark) return null;
      event.declaredSpeed = event.speed === "unknown"
        ? declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown"
        : "unknown";
      const projected = transitionUsageProjection(rawEvent, event);
      const apiPrice=speedApiPrice(event.speedPricingEvent,event.speedPricingComponents,event.priced,
        event.declaredSpeed==='unknown'?'standard':event.declaredSpeed,event.speedPricer);
      const sessionId=Number(row.session_id),accountScope=weeklyApiAccountScopes.get(Number(row.account_scope_id))??null;
      const apiInfo={apiUsd:apiPrice.totalUsd,apiCoverage:apiPrice.coverageStatus,
        priceCardIds:apiPrice.selectedPriceCardIds??[],
        unknownSpeed:event.speed==='unknown'&&event.declaredSpeed==='unknown'};
      // Process-local metadata only; compact corpus and persisted accounting
      // contracts retain their existing 21 cells.
      Object.defineProperty(projected, "weeklyApiOrigin", { get: () => ({...weeklyApiOrigins.get(sessionId),
        ...apiInfo,accountScope}) });
      return projected;
    }
    const pageSql = (lowerOperator) => database.prepare(`
      SELECT u.source_id, u.source_offset, u.session_id, u.account_scope_id, u.observed_at_ms, m.model_id AS model_id,
             t.codex_speed_mode AS codex_speed_mode, t.api_service_tier AS api_service_tier,
             u.tokens_in_uncached, u.tokens_in_cache_read, u.tokens_in_cache_write,
             u.tokens_out_text, u.tokens_out_reasoning, u.tokens_out_combined,
             u.total_input_context
      FROM usage_event u
      JOIN source s ON s.id = u.source_id
      JOIN model m ON m.id = u.model_id
      JOIN tier_semantics t ON t.id = u.tier_id
      WHERE u.source_offset <= s.scanned_bytes
        AND (u.observed_at_ms, u.source_id, u.source_offset) ${lowerOperator} (?, ?, ?)
        AND (u.observed_at_ms, u.source_id, u.source_offset) <= (?, ?, ?)
      ORDER BY u.observed_at_ms, u.source_id, u.source_offset
      LIMIT ${UNIFIED_CALIBRATION_READ_BATCH_ROWS}`);
    const firstPage = pageSql(">=");
    const nextPage = pageSql(">");
    const streamProjectedRange = async (low, high, consume) => {
      if (closed) throw fixedError("accounting_calibration_corpus_unavailable");
      if (residentRows !== null) {
        for (let position = low; position < high; position += 1) {
          await timing.measure("corpus_cadence",()=>cadence(),{aggregate:true});
          await timing.measure("corpus_consume",()=>consume(residentRows[position]),{aggregate:true});
        }
        timing.flush();
        return;
      }
      const bound = [usageMs[high - 1], usageSource[high - 1], usageOffset[high - 1]];
      let cursor = [usageMs[low], usageSource[low], usageOffset[low]];
      let statement = firstPage;
      let served = 0;
      try {
        for (;;) {
          const batch = timing.measureSync("corpus_sql",()=>statement.all(...cursor, ...bound),{aggregate:true});
          if (batch.length === 0) break;
          for (const row of batch) {
            await timing.measure("corpus_cadence",()=>cadence(),{aggregate:true});
            const projected = projectUsageRow(row, low + served);
            if (projected === null) continue;
            served += 1;
            await timing.measure("corpus_consume",()=>consume(projected),{aggregate:true});
          }
          const last = batch.at(-1);
          cursor = [Number(last.observed_at_ms), Number(last.source_id), Number(last.source_offset)];
          statement = nextPage;
          if (batch.length < UNIFIED_CALIBRATION_READ_BATCH_ROWS) break;
        }
      } catch (error) {
        if (error?.name === "AbortError"
            || (typeof error?.code === "string" && error.code.startsWith("accounting_"))) {
          throw error;
        }
        throw fixedError("accounting_calibration_corpus_unavailable");
      }
      if (served !== high - low) {
        throw fixedError("accounting_unified_generation_changed");
      }
      timing.flush();
    };
    timing.flush();
    return {
      commitSeq,
      coveredAt: {
        startAt: new Date(coveredStartMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
      },
      retainedUsageEvents,
      usageMetadataCapacity: usageCount,
      usageMetadataBytes: meteredUsageMetadataBytes,
      weeklyRateLimitSnapshots,
      planAttribution: planEvidence.finish(),
      loadWeeklyApiOrigins: async (codexHome) => {
        const sessions = database.prepare("SELECT id, session_uuid FROM session LIMIT 25001").all();
        if (sessions.length > 25_000) throw fixedError("weekly_api_resource_limit");
        const selected = sessions.filter(row => typeof row.session_uuid === "string"
          && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(row.session_uuid));
        const relations = codexHome ? await readCodexLocalThreadUsageRelations(codexHome,
          selected.map(row => row.session_uuid), { signal,includeOriginEvidence:true,diagnosticTimer:timing }) : new Map();
        timing.flush();
        weeklyApiOrigins = new Map(selected.map(row => [Number(row.id), {
          autoReview: relations.get(row.session_uuid)?.autoReview === true,
          originKnown: relations.get(row.session_uuid)?.originKnown === true,
        }]));
      },
      usageMs,
      metrics: ((retainedWeeklySnapshots) => () => ({
        retainedUsageEvents,
        weeklySnapshots: retainedWeeklySnapshots,
        commitSeq,
      }))(weeklyRateLimitSnapshots.length),
      readUsageSlice: async (low, high) => {
        if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)
            || low < 0 || high > retainedUsageEvents || low >= high) {
          throw new TypeError("Calibration usage slice bounds are invalid");
        }
        if (high - low > limits.usageEvents) {
          throw fixedError("accounting_transition_derivation_limit_exceeded");
        }
        checkRuntimeMemory((high - low) * COMPACT_USAGE_RETAINED_BYTES);
        const rows = [];
        await streamProjectedRange(low, high, (row) => rows.push(row));
        return rows;
      },
      forEachRetainedUsage: async (consume) => {
        await streamProjectedRange(0, retainedUsageEvents, consume);
      },
      finish: async () => { dispose(); },
      dispose,
    };
  } catch (error) {
    dispose();
    if (error?.name === "AbortError") {
      throw fixedError("accounting_refresh_aborted", "AbortError");
    }
    if (typeof error?.code === "string" && error.code.startsWith("accounting_")) {
      throw error;
    }
    return null;
  }
}

/**
 * Layer C: composition fit, weekly calibration, allowance capacity and the
 * plan-scoped timeline, from an opened full-history calibration corpus.
 *
 * The same computation `buildReplaySafeAccountingCache` runs on the shipping
 * index's corpus, with the corpus supplied by the caller.
 */
export async function buildCalibrationLayer({
  calibrationCorpus,
  endMs,
  limits = transitionResourceLimits(null),
  declaredSpeedBaselines = [],
  unknownSpeedPolicy = DEFAULT_UNKNOWN_SPEED_POLICY,
  signal = null,
  checkRuntimeMemory = () => {},
  sourceMode = "unified",
  generation = null,
  generationFingerprint = null,
  codexHome = null,
} = {}) {
  unknownSpeedPolicy = validateUnknownSpeedPolicy(unknownSpeedPolicy);
  const baselines = Array.isArray(declaredSpeedBaselines) ? declaredSpeedBaselines : [];
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
  try {
    if (!Array.isArray(calibrationAttribution.summary.planTypes)
        || calibrationAttribution.summary.planTypes.length > 16) {
      throw fixedError("accounting_transition_derivation_limit_exceeded");
    }
    // The composition fit is optional enrichment: a failure completes the
    // layer with `composition: null` and records why.
    try {
      const fits = await fitPlanCompositionsFromCorpus({
        forEachUsageRow: calibrationCorpus.forEachRetainedUsage,
        weeklyRateLimitSnapshots: calibrationCorpus.weeklyRateLimitSnapshots,
        endMs,
        signal,
        checkRuntimeMemory,
        planAttributionIndex: calibrationAttribution.index,
        declaredSpeedBaselines: baselines,
        unknownSpeedPolicy,
      }, calibrationAttribution.summary.planTypes, calibrationAttribution.summary.latestPlanType);
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
    try {
      if (sourceMode === "unified" && generation != null && generationFingerprint != null) {
        await calibrationCorpus.loadWeeklyApiOrigins?.(codexHome);
        weeklyApiIntervals = await buildWeeklyApiIntervals({ corpus:calibrationCorpus,endMs,
          generation,fingerprint:generationFingerprint,signal });
      }
    } catch (error) {
      throwIfAborted(signal);
      weeklyApiIntervals = unavailableWeeklyApiIntervals(/^weekly_api_[a-z_]{1,64}$/.test(error?.code ?? "")
        ? error.code : "weekly_api_projection_failed");
    }
    try {
      transitionSeries = await deriveBoundedWeeklyCalibrationSeries({
        startAt: calibrationCoveredAt.startAt,
        endAt: calibrationCoveredAt.endAt,
        usageCorpus: {
          count: calibrationCorpus.retainedUsageEvents,
          usageMs: calibrationCorpus.usageMs,
          readSlice: calibrationCorpus.readUsageSlice,
        },
        rateLimitSnapshots: calibrationCorpus.weeklyRateLimitSnapshots,
        diagnostics: {},
        signal,
        resourceCheck: checkRuntimeMemory,
        planAttributionIndex: calibrationAttribution.index,
        limits,
      });
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
  } catch (error) {
    calibrationCorpus.dispose();
    throw error;
  }
  const corpusMetrics = calibrationCorpus.metrics();
  await calibrationCorpus.finish();
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
      deduplicatedRateLimitSnapshots: transitionSeries.deduplicatedSnapshotCount,
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
  const allowanceScenarios = { [selectedScenario]: {
    basis: codexPrimaryAllowanceBasis(selectedScenario, unknownSpeedPolicy),
    calibration: projectBoundedWeeklyCalibrationSummary(allowanceCapacityDataset, calibrationOptions),
  } };
  const selectedAllowanceCalibration = allowanceScenarios[selectedScenario].calibration;
  const fiveHourAllowanceCalibration = projectBoundedWeeklyCalibrationSummary(
    allowanceCapacityDataset, { ...calibrationOptions, windowDurationMinutes: FIVE_HOUR_WINDOW_MINUTES },
  );
  const capacityPlanScope = {
    methodVersion: PLAN_SCOPED_ATTRIBUTION_METHOD_VERSION,
    basisId: allowanceScenarios[selectedScenario].basis.basisId,
    planType: selectedAllowanceCalibration.selectedPlanType,
    basisFamilyId: allowanceScenarios[selectedScenario].basis.basisFamilyId,
    cohortId: calibrationCohortId(selectedAllowanceCalibration),
  };
  const allowanceCapacityByScenario = {
    schemaVersion: ALLOWANCE_CAPACITY_SCHEMA_VERSION,
    basisFamilyId: allowanceScenarios[selectedScenario].basis.basisFamilyId,
    planScope: capacityPlanScope,
    unknownSpeedPolicy,
    selectedScenario,
    scenarios: allowanceScenarios,
  };
  const planScopedTimeline = planScopedTimelineReceipt({
    draft: planScopedTimelineDraft,
    sourceMode,
    generation,
    generationFingerprint,
    capacityPlanScope,
  });
  const historicalPlanComparisons = historicalPlanComparisonReceipts(
    historicalPlanDrafts, allowanceCapacityByScenario,
    { sourceMode, generation, generationFingerprint },
  );
  return {
    unknownSpeedPolicy,
    historicalPlanComparisons,
    weeklyApiIntervals,
    weeklyCalibration,
    allowanceCapacityByScenario,
    fiveHourAllowanceCalibration,
    planScopedTimeline,
    weeklyCalibrationInput: {
      status: "complete",
      encoding: "accounting_streamed_v1",
      usageMetadataCapacity: calibrationCorpus.usageMetadataCapacity,
      usageMetadataBytes: calibrationCorpus.usageMetadataBytes,
      source: "unified_index",
      coveredAt: calibrationCoveredAt,
      retainedUsageEvents,
      retainedWeeklySnapshots,
      estimatedRetainedBytes: calibrationRetainedBytes,
      limits,
    },
    corpusMetrics,
  };
}

/**
 * An in-process memo of Layer C.
 *
 * The layer is a pure function of one committed snapshot of the store, the
 * declared-speed ledger, the clock and the limits, so a result is reusable for
 * exactly that key and for nothing else: a refresh that commits changes
 * `commit_seq`, and a ledger edit changes the canonical ledger text. The clock
 * is part of the key as given; the caller chooses how coarsely to quantize
 * it, and that choice is its own staleness policy.
 *
 * Nothing is persisted. A stored ledger-derived value would outlive the ledger
 * it came from (gate C1); a process-local entry cannot.
 */
export function createCalibrationLayerMemo({
  maximumEntries = 4,
  open = openLocalIndexCalibrationCorpus,
  build = buildCalibrationLayer,
} = {}) {
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
    throw new TypeError("maximumEntries must be a positive integer");
  }
  const entries = new Map();
  const pending = new Map();

  async function read({
    indexFile,
    endMs,
    limits = transitionResourceLimits(null),
    declaredSpeedBaselines = [],
    signal = null,
    ...rest
  }) {
    const database = openLocalIndexStore(indexFile, { readOnly: true });
    let commitSeq;
    try {
      commitSeq = readCommitSeq(database);
    } finally {
      database.close();
    }
    const key = JSON.stringify([
      indexFile, commitSeq, endMs, limits, declaredSpeedBaselines,
    ]);
    if (entries.has(key)) {
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return { layer: value, memoized: true, commitSeq };
    }
    // A second caller with the same key shares the computation in flight.
    if (pending.has(key)) {
      return { layer: await pending.get(key), memoized: true, commitSeq };
    }
    const work = (async () => {
      const corpus = await open({
        indexFile, endMs, limits, declaredSpeedBaselines, signal,
      });
      if (corpus === null) return null;
      return build({
        calibrationCorpus: corpus, endMs, limits, declaredSpeedBaselines, signal, ...rest,
      });
    })();
    pending.set(key, work);
    try {
      const layer = await work;
      if (layer !== null) {
        entries.set(key, layer);
        while (entries.size > maximumEntries) entries.delete(entries.keys().next().value);
      }
      return { layer, memoized: false, commitSeq };
    } finally {
      pending.delete(key);
    }
  }

  return { read, clear: () => entries.clear(), size: () => entries.size };
}
