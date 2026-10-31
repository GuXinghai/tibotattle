import { compact } from "./ui-format.js";

export function createQuotaTimelineLookup(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError("Quota timeline rows must be an array.");
  }
  const entries = rows.flatMap((row, sourceIndex) => {
    const timestampMs = Date.parse(row?.observedAt);
    return Number.isFinite(timestampMs)
      ? [{ row, sourceIndex, timestampMs }]
      : [];
  }).sort((left, right) => (
    left.timestampMs - right.timestampMs
    || left.sourceIndex - right.sourceIndex
  )).map(({ row, timestampMs }) => Object.freeze({ row, timestampMs }));

  return Object.freeze({
    size: entries.length,
    atOrBefore(timestampMs) {
      if (typeof timestampMs !== "number" || Number.isNaN(timestampMs)) {
        return null;
      }
      let lower = 0;
      let upper = entries.length;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (entries[middle].timestampMs <= timestampMs) {
          lower = middle + 1;
        } else {
          upper = middle;
        }
      }
      return lower === 0 ? null : entries[lower - 1];
    },
    // The forward complement of atOrBefore: the earliest observation at or
    // after the instant. A rolling window whose start edge falls inside a
    // collection silence has no backward observation to anchor on, but often
    // has one just inside the window; the caller can anchor there and shrink
    // the window to the actually-measured span instead of discarding it.
    atOrAfter(timestampMs) {
      if (typeof timestampMs !== "number" || Number.isNaN(timestampMs)) {
        return null;
      }
      let lower = 0;
      let upper = entries.length;
      while (lower < upper) {
        const middle = lower + Math.floor((upper - lower) / 2);
        if (entries[middle].timestampMs < timestampMs) {
          lower = middle + 1;
        } else {
          upper = middle;
        }
      }
      return lower === entries.length ? null : entries[lower];
    }
  });
}

// A fresh index or an authoritatively selected full accounting rebuild has a
// four-hour server-side cold-work bound. Keep the browser attached for that
// bound plus one minute so progress and Cancel stay usable; this does not
// extend the companion's own deadline, and ordinary cache-hit refreshes still
// settle at their five-minute server bound.
export const LOCAL_REFRESH_POLLING_WINDOW_MS = 241 * 60 * 1_000;

export function createRefreshPollingBudget({
  now = () => Date.now(),
  windowMs = LOCAL_REFRESH_POLLING_WINDOW_MS,
  settlementGraceMs = 30 * 1_000,
  maximumContinuations = 2
} = {}) {
  if (typeof now !== "function"
      || !Number.isSafeInteger(windowMs)
      || windowMs < 1_000
      || !Number.isSafeInteger(settlementGraceMs)
      || settlementGraceMs < 1_000
      || !Number.isSafeInteger(maximumContinuations)
      || maximumContinuations < 1) {
    throw new TypeError("Refresh polling budget is invalid.");
  }
  let deadlineMs = now() + windowMs;
  let continuations = 0;
  return Object.freeze({
    hasTime() {
      return now() < deadlineMs;
    },
    remainingMs() {
      return Math.max(0, deadlineMs - now());
    },
    noteSettling() {
      // A terminal timeout has already ended the accepted worker pass. Give
      // its checkpoint a short settlement grace, even if the original cold
      // scan budget still had hours remaining.
      deadlineMs = now() + settlementGraceMs;
    },
    canContinue() {
      return continuations < maximumContinuations;
    },
    noteContinuation() {
      if (continuations >= maximumContinuations) return false;
      continuations += 1;
      deadlineMs = now() + windowMs;
      return true;
    },
    get continuations() {
      return continuations;
    }
  });
}

/**
 * Describe the quick-result phase without claiming that the loaded overview
 * contains a numeric headline. A successful overview response can still be a
 * truthful unavailable/withheld state, so transport success alone must never
 * become "headline ready" or "verified numbers" copy.
 */
export function refreshQuickResultStatus({
  dashboardLoaded = false,
  elapsedLabel = "",
} = {}) {
  const boundedElapsedLabel = typeof elapsedLabel === "string"
    ? elapsedLabel.trim()
    : "";
  if (dashboardLoaded) {
    return boundedElapsedLabel.length > 0
      ? `Local summary updated · checking full history… ${boundedElapsedLabel}`
      : "Local summary updated · checking full history…";
  }
  return boundedElapsedLabel.length > 0
    ? `Preparing local summary… ${boundedElapsedLabel}`
    : "Preparing local summary…";
}

/** A count-free work stage, never proof of fresh or completed accounting. */
export function refreshAccountingStatus({ progress, elapsedLabel = "" } = {}) {
  if (progress === null || typeof progress !== "object"
      || Array.isArray(progress)
      || Object.keys(progress).length !== 2
      || !Object.hasOwn(progress, "kind")
      || !Object.hasOwn(progress, "status")
      || progress.kind !== "accounting"
      || progress.status !== "calculating") return null;
  const boundedElapsedLabel = typeof elapsedLabel === "string"
    ? elapsedLabel.trim()
    : "";
  return boundedElapsedLabel.length > 0
    ? `Calculating accounting… ${boundedElapsedLabel}`
    : "Calculating accounting…";
}

export function refreshNeedsContinuation({
  outcome,
  errorCode = null,
  progress = null,
} = {}) {
  if (progress?.status !== "bounded_pause") return false;
  return outcome === "succeeded"
    || (outcome === "failed" && errorCode === "refresh_timed_out");
}

function historyProgressNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function historyProgressToken(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    ? value
    : null;
}

export const HISTORY_INFORMATIONAL_GAP_MAX_SHARE = 0.01;

/**
 * A terminal history gap may use the quiet informational treatment only when
 * the published receipt is coherent, current accounting is available, and
 * the excluded share is immaterial. Everything else remains a warning.
 */
export function historyCoverageNoticeKind({
  history = null,
  accountingProjection = null,
} = {}) {
  const sourceCount = historyProgressNumber(history?.sourceCount);
  const indexedSourceCount = historyProgressNumber(
    history?.indexedSourceCount,
  );
  const pendingSourceCount = historyProgressNumber(
    history?.pendingSourceCount,
  );
  const skippedSourceCount = historyProgressNumber(
    history?.skippedSourceCount,
  );
  const informational = history?.status === "partial"
    && history?.phase === "partial_terminal"
    && accountingProjection?.status === "available"
    && sourceCount !== null
    && sourceCount > 0
    && indexedSourceCount !== null
    && indexedSourceCount > 0
    && pendingSourceCount === 0
    && skippedSourceCount !== null
    && skippedSourceCount > 0
    && indexedSourceCount + skippedSourceCount === sourceCount
    && skippedSourceCount / sourceCount
      <= HISTORY_INFORMATIONAL_GAP_MAX_SHARE;
  return informational ? "info" : "warning";
}

/**
 * Decide whether the browser may automatically start another archive-index
 * pass. A terminal partial generation is useful verified evidence, but never
 * advancing work. An incomplete pass may continue only when its closed,
 * content-free receipt differs from the receipt visible before the last pass.
 */
export function historyIndexContinuationDecision({
  history = null,
  generation = null,
  generationFingerprint = null,
  previousReceipt = null,
} = {}) {
  const safeHistory = history !== null
      && typeof history === "object"
      && !Array.isArray(history)
    ? history
    : null;
  const indexedSourceCount = historyProgressNumber(
    safeHistory?.indexedSourceCount,
  );
  const sourceCount = historyProgressNumber(safeHistory?.sourceCount);
  const receipt = safeHistory === null
    ? null
    : JSON.stringify([
      typeof safeHistory.phase === "string" ? safeHistory.phase : null,
      indexedSourceCount,
      historyProgressNumber(safeHistory.indexedBytes),
      sourceCount,
      historyProgressNumber(safeHistory.sourceBytes),
      historyProgressToken(generation),
      historyProgressToken(generationFingerprint),
    ]);
  const terminalGap = safeHistory?.status === "partial"
    && safeHistory?.phase === "partial_terminal";
  const incomplete = safeHistory?.status !== "complete"
    && !terminalGap
    && safeHistory?.phase !== "aggregate_unavailable"
    && indexedSourceCount !== null
    && sourceCount !== null
    && sourceCount > 0
    && indexedSourceCount < sourceCount;
  return Object.freeze({
    incomplete,
    receipt,
    terminalGap,
    shouldContinue: incomplete && receipt !== previousReceipt,
  });
}

export function formatTokenTotal(usage) {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) {
    return compact(null);
  }
  let total = 0;
  // This legacy projection has one combined cached-input field and split text /
  // reasoning output. Every component must be present: an omitted component is
  // unknown evidence, not a zero contribution. Combined output is intentionally
  // not added a second time when split components are available.
  for (const key of [
    "inputUncachedTokens",
    "inputCachedTokens",
    "outputTextTokens",
    "outputReasoningTokens",
  ]) {
    const value = usage[key];
    if (!Number.isSafeInteger(value) || value < 0) return compact(null);
    total += value;
    if (!Number.isSafeInteger(total)) return compact(null);
  }
  return compact(total);
}

// Crockford base32 without I, L, O and U, so a reference read aloud or
// retyped into a support conversation cannot be confused with 1 or 0.
const DIAGNOSTIC_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DIAGNOSTIC_REFERENCE_SYMBOLS = 6;
const DIAGNOSTIC_REFERENCE_PREFIX = "TT-";
export const DIAGNOSTIC_REFERENCE_PATTERN =
  /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u;
// Fixed, content-free journey names. A note may only be filed against one of
// these, so the local log can never accumulate a free-form label.
export const DIAGNOSTIC_SURFACES = Object.freeze(["local_refresh"]);
const DIAGNOSTIC_SURFACE_SET = new Set(DIAGNOSTIC_SURFACES);
// A request reference is a UUID, never an account or session identifier.
const SERVICE_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Fixed identifier-shaped error codes cannot carry content or a private path.
// They are used for classification and are never rendered as copy.
const DIAGNOSTIC_CODE_PATTERN =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;

/**
 * Mint one short support reference for a user-visible failure.
 *
 * The value is pure WebCrypto randomness. It is never derived from a
 * participant id, an error body, a hostname, or a timestamp, so it correlates
 * a support conversation with one local log line and discloses nothing else.
 */
export function createDiagnosticReference(cryptoImpl = globalThis.crypto) {
  const bytes = cryptoImpl.getRandomValues(
    new Uint8Array(DIAGNOSTIC_REFERENCE_SYMBOLS)
  );
  let reference = DIAGNOSTIC_REFERENCE_PREFIX;
  // 256 is an exact multiple of 32, so the remainder stays uniform.
  for (const byte of bytes) {
    reference += DIAGNOSTIC_REFERENCE_ALPHABET[byte % 32];
  }
  return reference;
}

export function diagnosticSurface(candidate) {
  return DIAGNOSTIC_SURFACE_SET.has(candidate) ? candidate : "";
}

/**
 * A service may return a UUID requestId in an error body. Surfacing it lets a
 * support conversation join the local reference to one server-side record;
 * anything that is not exactly that shape is discarded.
 */
export function serviceRequestId(candidate) {
  return typeof candidate === "string"
    && SERVICE_REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : "";
}

export function diagnosticErrorCode(candidate) {
  return typeof candidate === "string" && DIAGNOSTIC_CODE_PATTERN.test(candidate)
    ? candidate
    : "";
}

/**
 * The trailing sentence appended to every user-visible failure.
 *
 * It carries only identifiers this page minted or validated: the local
 * reference, and the service request id when the service supplied one. The
 * local-log claim is emitted only when the awaited companion response confirms
 * that the same reference was recorded.
 */
export function diagnosticReferenceSentence({
  reference,
  requestId = "",
  writtenToLocalLog = false
} = {}) {
  if (!DIAGNOSTIC_REFERENCE_PATTERN.test(reference ?? "")) return "";
  if (writtenToLocalLog !== true) return `Reference ${reference}.`;
  const service = serviceRequestId(requestId);
  return service === ""
    ? `Reference ${reference}, also written to the local diagnostics log.`
    : `Reference ${reference} · service request ${service}. Both are written to the local diagnostics log.`;
}

// --- Deviation-period detector ---------------------------------------------
//
// A deviation period is a SUSTAINED stretch where the re-anchored cumulative
// drift — the running sum of each non-overlapping bucket's observed-minus-priced
// quota movement, restarted at every reset boundary or track change, exactly
// the `cumulativeResidual` series `liveTimelinePoints` draws and the signed AUC
// in src/simple-quota-gradient.js integrates — moves materially away from zero
// and stays there. It is deliberately NOT a single spike: a short excursion
// that returns to zero, or a +spike immediately cancelled by a -spike, must not
// be reported. The detector reads the same live timeline points the residual
// chart uses (each carries `cumulativeResidual` and, at a fresh anchor, a
// `driftReanchor` flag) and returns an ordered list of periods.

// |cumulative drift| must exceed this, in percentage points, for a bucket to
// count as diverging. Pinned to the 5 pp minimum displayed span the weekly
// calibration contract already treats as the smallest movement worth reading
// (WEEKLY_CALIBRATION_MINIMUM_DISPLAYED_SPAN_PP in localization.js): a drift
// smaller than the smallest span we will draw is not a finding.
export const DEVIATION_DRIFT_THRESHOLD_PP = 5;
// A run must persist at least this long before it is a "period" rather than a
// transient. The residual series is a 3-hour rolling window, so a genuine
// sustained disagreement outlives a large share of that window; two hours is
// long enough that a single window's settling cannot manufacture a period, and
// short enough to catch a real half-window run.
export const DEVIATION_MIN_DURATION_MS = 2 * 60 * 60 * 1_000;
// Same-sign runs separated only by a brief sub-threshold dip (no reset, no data
// gap between them) are one period, not two. 45 minutes is three 15-minute
// buckets — long enough to bridge a shallow wobble, short enough that a real
// return to zero still ends the period.
export const DEVIATION_MERGE_GAP_MS = 45 * 60 * 1_000;
function deviationNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function deviationNonNegative(value) {
  const number = deviationNumberOrNull(value);
  return number === null || number < 0 ? 0 : number;
}

function deviationPointMs(point) {
  const stamped = point?.timestampMs;
  if (typeof stamped === "number" && Number.isFinite(stamped)) return stamped;
  return Date.parse(point?.timestamp ?? "");
}

// The signed observed-minus-priced area, in pp·hours, over the period's points.
// Trapezoidal over the per-window residual, matching buildRollingResidual's
// signed AUC in src/simple-quota-gradient.js so the two statistics agree.
function deviationSignedAuc(points) {
  let area = 0;
  for (let index = 1; index < points.length; index += 1) {
    const prior = points[index - 1];
    const current = points[index];
    if (prior.residual === null || current.residual === null) continue;
    const elapsedHours = (current.timestampMs - prior.timestampMs) / 3_600_000;
    if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) continue;
    area += elapsedHours * (prior.residual + current.residual) / 2;
  }
  return area;
}

// Within one drift segment (no reset, no gap), the maximal same-sign runs whose
// |drift| exceeds the threshold, merging two same-sign runs separated only by a
// brief sub-threshold dip. A sign flip between two runs is never bridged, so a
// spike that cancels can never merge into its own rebound.
function deviationSegmentExcursions(segment, { thresholdPp, mergeGapMs }) {
  const runs = [];
  let run = null;
  for (const point of segment) {
    const sign = point.drift > thresholdPp ? 1
      : point.drift < -thresholdPp ? -1
        : 0;
    if (sign === 0) {
      run = null;
      continue;
    }
    if (run && run.sign === sign) {
      run.points.push(point);
    } else {
      run = { sign, points: [point] };
      runs.push(run);
    }
  }
  const merged = [];
  for (const candidate of runs) {
    const last = merged.at(-1);
    if (last
        && last.sign === candidate.sign
        && candidate.points[0].timestampMs
          - last.points.at(-1).timestampMs <= mergeGapMs) {
      last.points.push(...candidate.points);
    } else {
      merged.push({ sign: candidate.sign, points: [...candidate.points] });
    }
  }
  return merged;
}

// Aggregate the exact usage buckets whose end falls inside the period. This is
// the only per-period contributor evidence available client-side: cost, token
// volume, usage-change count, and the unpriced-change share. The per-period
// model and speed MIX is not in the timeline payload — those breakdowns exist
// only at the whole-selected-period grain (byModel/bySpeed) — so the renderer
// layers the range-level dominant model/speed on top, clearly marked as
// range context rather than a period-specific claim.
function deviationBucketContributors(buckets, startMs, endMs) {
  let costUsd = 0;
  let totalTokens = 0;
  let usageEvents = 0;
  let unpricedEvents = 0;
  let bucketCount = 0;
  for (const bucket of buckets) {
    if (bucket.endMs < startMs || bucket.endMs > endMs) continue;
    costUsd += bucket.cost;
    totalTokens += bucket.tokens;
    usageEvents += bucket.events;
    unpricedEvents += bucket.unpriced;
    bucketCount += 1;
  }
  return {
    costUsd,
    totalTokens,
    usageEvents,
    unpricedEvents,
    pricedEvents: Math.max(0, usageEvents - unpricedEvents),
    unpricedEventShare: usageEvents > 0 ? unpricedEvents / usageEvents : null,
    bucketCount,
  };
}

/**
 * Find the sustained periods where observed quota movement persistently
 * disagrees with priced (cost-implied) usage.
 *
 * @param {Array} points  Live timeline points, each `{ timestampMs, timestamp,
 *   cumulativeResidual, residual, driftReanchor }`. A null/absent
 *   `cumulativeResidual` is a data gap that ends any run; a `driftReanchor`
 *   point starts a fresh segment (a reset boundary or track change), which ends
 *   the preceding period by construction.
 * @param {Object} [options]
 * @param {Array}  [options.usageBuckets]  Raw `data.timeline.usage` buckets,
 *   used only to attach the exact per-period contributor totals.
 * @returns {{ periods: Array, totalFound: number, truncated: boolean,
 *   thresholdPp: number, minDurationMs: number, hasDriftSeries: boolean }}
 */
export function detectDeviationPeriods(points, {
  usageBuckets = [],
  thresholdPp = DEVIATION_DRIFT_THRESHOLD_PP,
  minDurationMs = DEVIATION_MIN_DURATION_MS,
  mergeGapMs = DEVIATION_MERGE_GAP_MS,
  // Preserve the full ranked result for pageable consumers. Callers that need
  // a diagnostic bound can still pass an explicit finite cap.
  maxPeriods = Number.POSITIVE_INFINITY,
} = {}) {
  const series = (Array.isArray(points) ? points : [])
    .map((point) => ({
      timestampMs: deviationPointMs(point),
      timestamp: typeof point?.timestamp === "string" ? point.timestamp : null,
      drift: deviationNumberOrNull(point?.cumulativeResidual),
      residual: deviationNumberOrNull(point?.residual),
      reanchor: point?.driftReanchor === true,
    }))
    .filter((point) => Number.isFinite(point.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  // Whether any drift evidence exists at all separates "nothing diverged" from
  // "this view carries no cumulative-drift series to judge" — the historical
  // artifact view has no per-window reset anchors, so it can only ever report
  // the latter, and the panel must not read it as a clean bill of health.
  const hasDriftSeries = series.some((point) => point.drift !== null);

  // Split into segments at data gaps (null drift) and reset re-anchors.
  const segments = [];
  let segment = [];
  for (const point of series) {
    if (point.drift === null) {
      if (segment.length) segments.push(segment);
      segment = [];
      continue;
    }
    if (point.reanchor && segment.length) {
      segments.push(segment);
      segment = [];
    }
    segment.push(point);
  }
  if (segment.length) segments.push(segment);

  const buckets = (Array.isArray(usageBuckets) ? usageBuckets : [])
    .map((bucket) => ({
      endMs: Date.parse(bucket?.endAt ?? ""),
      cost: deviationNonNegative(bucket?.apiPriceEquivalentUsd),
      tokens: deviationNonNegative(bucket?.totalTokens),
      events: deviationNonNegative(bucket?.usageEvents),
      unpriced: deviationNonNegative(bucket?.pricingCoverage?.unpricedEvents),
    }))
    .filter((bucket) => Number.isFinite(bucket.endMs));

  const found = [];
  for (const currentSegment of segments) {
    for (const run of deviationSegmentExcursions(currentSegment, {
      thresholdPp,
      mergeGapMs,
    })) {
      const runPoints = run.points;
      const startMs = runPoints[0].timestampMs;
      const endMs = runPoints.at(-1).timestampMs;
      const durationMs = endMs - startMs;
      if (durationMs < minDurationMs) continue;
      let peakDriftPp = 0;
      for (const point of runPoints) {
        if (Math.abs(point.drift) > Math.abs(peakDriftPp)) {
          peakDriftPp = point.drift;
        }
      }
      found.push({
        startAt: runPoints[0].timestamp,
        endAt: runPoints.at(-1).timestamp,
        startMs,
        endMs,
        durationMs,
        directionSign: run.sign,
        direction: run.sign > 0 ? "under_costed" : "over_costed",
        peakDriftPp,
        absPeakDriftPp: Math.abs(peakDriftPp),
        netDriftPp: runPoints.at(-1).drift - runPoints[0].drift,
        signedAucPpHours: deviationSignedAuc(runPoints),
        pointCount: runPoints.length,
        contributors: deviationBucketContributors(buckets, startMs, endMs),
      });
    }
  }

  found.sort((left, right) => right.absPeakDriftPp - left.absPeakDriftPp);
  return {
    periods: found.slice(0, maxPeriods),
    totalFound: found.length,
    truncated: found.length > maxPeriods,
    thresholdPp,
    minDurationMs,
    hasDriftSeries,
  };
}
