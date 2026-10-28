import { createHash } from "node:crypto";
import { DEFAULT_UNKNOWN_SPEED_POLICY, unknownSpeedCalculationIdentity } from "./unknown-speed-policy.js";
import { createLocalRefreshTimer, reportLocalRefreshReuseDiagnostic, reportLocalRefreshOriginDiagnostic } from "./local-refresh-timing.js";
import { lstatSync } from "node:fs";
import { readCodexLocalThreadUsageRelations } from "./platform/index.js";
import { readLocalIndexGenerationIdentity } from "./local-index-companion-source.js";
import { readLocalIndexCoverage } from "./local-index-report.js";
import { openLocalIndexStore, readCalculationRevision, withReadSnapshot } from "./local-index-store.js";
import { serializeLocalCollectorAccountingCache, writeLocalCollectorAccountingCache } from "./local-collector-state.js";
import { assertReplaySafeAccountingCache, REPLAY_SAFE_CALIBRATION_INTERNALS } from "./replay-safe-accounting-cache.js";

const { throwIfAborted } = REPLAY_SAFE_CALIBRATION_INTERNALS;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameGeneration = (a, b) => a?.id === b?.id && a?.fingerprint === b?.fingerprint;
const fileIdentity = path => {
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink() ? [stat.dev, stat.ino, stat.birthtimeMs] : null;
};
function relevantBaselines(windows, range) {
  return (Array.isArray(windows) ? windows : []).flatMap(window => {
    const start = Date.parse(window?.firstSeenAt), end = Date.parse(window?.lastSeenAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end
        || Object.keys(window).sort().join() !== "firstSeenAt,lastSeenAt,mode"
        || new Date(start).toISOString() !== window.firstSeenAt
        || new Date(end).toISOString() !== window.lastSeenAt
        || !["standard", "fast", "ultrafast"].includes(window?.mode)
        || range.first === null || end < range.first || start > range.last) return [];
    return [[window.mode, Math.max(start, range.first), Math.min(end, range.last)]];
  });
}

// Proofs and calculation components live only in the refresh runner's process.
// In particular, neither session identities nor an origin/ledger proof is stored.
export function createLocalIndexAccountingReuse({
  indexFile, codexHome, stateFile,
  readOrigins = readCodexLocalThreadUsageRelations,
  readIdentity = readLocalIndexGenerationIdentity,
  write = writeLocalCollectorAccountingCache,
} = {}) {
  let retained = null;

  async function readProof({ generation, declaredSpeedBaselines = [], unknownSpeedPolicy = DEFAULT_UNKNOWN_SPEED_POLICY, signal = null, onTiming = null, monotonicClock = undefined,
    onReuseDiagnostic = null, onOriginDiagnostic = null, diagnosticPhase = "proof_before" }) {
    const report = code => reportLocalRefreshReuseDiagnostic(onReuseDiagnostic, diagnosticPhase, code);
    const timing = createLocalRefreshTimer({ onTiming, clock: monotonicClock });
    if (!indexFile || !stateFile) { report("context_unavailable"); return null; }
    throwIfAborted(signal);
    let database;
    let snapshot;
    const fileKey = fileIdentity(indexFile);
    if (fileKey === null) { report("file_unavailable"); return null; }
    const finishIndex = timing.start("proof_index_read");
    let indexError = null;
    try {
      database = openLocalIndexStore(indexFile, { readOnly: true });
      snapshot = withReadSnapshot(database, ({ commitSeq }) => {
        const sessions = database.prepare(`SELECT s.id, s.session_uuid,
          EXISTS(SELECT 1 FROM usage_event u WHERE u.session_id=s.id) AS has_usage
          FROM session s ORDER BY s.id LIMIT 25001`).all();
        if (sessions.length > 25_000) return null;
        const ids = sessions.filter(row => typeof row.session_uuid === "string"
          && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(row.session_uuid));
        const diagnostics = Object.fromEntries(database.prepare(`SELECT code, SUM(count) AS count
          FROM source_diagnostic GROUP BY code ORDER BY code`).all().map(row => [row.code, Number(row.count)]));
        return { invalidSessions: ids.length !== sessions.length, id: commitSeq, calculationRevision: readCalculationRevision(database),
          coverage: readLocalIndexCoverage(database), sessions: ids, diagnostics,
          usageRange: database.prepare(`SELECT
            (SELECT MIN(observed_at_ms) FROM usage_event) AS first,
            (SELECT MAX(observed_at_ms) FROM usage_event) AS last`).get(),
          committedAtMs: Number(database.prepare("SELECT MAX(committed_at_ms) AS at FROM commit_log WHERE seq <= ?").get(commitSeq)?.at ?? 0) };
      });
    } catch (error) { indexError = error; throw error; }
    finally {
      try { database?.close(); }
      catch (error) { indexError = error; throw error; }
      finally { finishIndex(indexError); }
    }
    if (!snapshot) { report("session_limit"); return null; }
    if (snapshot.invalidSessions) { report("origins_unavailable"); return null; }
    if (snapshot.id !== generation?.id) { report("generation_changed"); return null; }
    const evidence = snapshot.sessions.length === 0 ? { complete: true, relations: new Map() }
      : await timing.measure("proof_origins", () => readOrigins(codexHome, snapshot.sessions.map(row => row.session_uuid),
      { signal, includeOriginEvidence: true, withOriginReadReceipt: true, diagnosticTimer: timing, onOriginDiagnostic: value =>
        reportLocalRefreshOriginDiagnostic(onOriginDiagnostic, diagnosticPhase, value?.code, value?.count) }));
    timing.flush();
    throwIfAborted(signal);
    // Only a complete, guarded read can distinguish an absent row from an unread store.
    const relations = evidence?.relations;
    if (evidence?.complete !== true || !(relations instanceof Map)) { report("origins_unavailable"); return null; }
    if (snapshot.sessions.some(row => {
      const value = relations.get(row.session_uuid);
      return !value || typeof value.originKnown !== "boolean" || typeof value.autoReview !== "boolean"
        || (!value.originKnown && value.autoReview);
    })) { report("origins_unavailable"); return null; }
    const unresolved = snapshot.sessions.filter(row => relations.get(row.session_uuid)?.originKnown !== true);
    reportLocalRefreshOriginDiagnostic(onOriginDiagnostic, diagnosticPhase, "unknown_with_usage", unresolved.filter(row => row.has_usage).length);
    reportLocalRefreshOriginDiagnostic(onOriginDiagnostic, diagnosticPhase, "unknown_without_usage", unresolved.filter(row => !row.has_usage).length);
    const originKey = digest(snapshot.sessions.map(row => {
      const relation = relations.get(row.session_uuid);
      return [Number(row.id), relation.originKnown ? relation.autoReview ? "auto_review" : "normal" : "unknown"];
    }));
    const identity = readIdentity({ indexFile });
    if (!sameGeneration(identity, generation) || identity.calculationRevision !== snapshot.calculationRevision
        || digest(fileKey) !== digest(fileIdentity(indexFile))) { report("identity_changed"); return null; }
    report("proof_available");
    return { ...snapshot, sessions: undefined, fileKey, fingerprint: identity.fingerprint,
      unknownSpeedPolicyIdentity: unknownSpeedCalculationIdentity(unknownSpeedPolicy),
      components: { file: digest(fileKey), revision: snapshot.calculationRevision,
        baselines: digest(relevantBaselines(declaredSpeedBaselines, snapshot.usageRange)),
        origins: originKey, policy: unknownSpeedCalculationIdentity(unknownSpeedPolicy) },
      key: digest([fileKey, snapshot.calculationRevision,
        relevantBaselines(declaredSpeedBaselines, snapshot.usageRange), originKey,
        unknownSpeedCalculationIdentity(unknownSpeedPolicy)]) };
  }

  function remember({ cache, before, after, onReuseDiagnostic = null }) {
    const report = code => reportLocalRefreshReuseDiagnostic(onReuseDiagnostic, "remember", code);
    retained = null;
    if (!before || !after) { report("proof_unavailable"); return; }
    if (before.key !== after.key || !sameGeneration(before, after)
        || String(cache?.sourceDescriptor?.generation) !== String(after.id)
        || cache?.sourceDescriptor?.generationFingerprint !== after.fingerprint) { report("proof_changed"); return; }
    try { assertReplaySafeAccountingCache(cache); } catch { report("cache_invalid"); return; }
    try {
      if (unknownSpeedCalculationIdentity(cache.unknownSpeedPolicy) !== after.unknownSpeedPolicyIdentity) {
        report("proof_changed"); return;
      }
    } catch { report("cache_invalid"); return; }
    if (Buffer.byteLength(serializeLocalCollectorAccountingCache(cache))
        > REPLAY_SAFE_CALIBRATION_INTERNALS.MAX_CACHE_BYTES) { report("cache_oversize"); return; }
    // A private clone prevents mutation by a consumer from corrupting the proof.
    retained = { cache: structuredClone(cache), proof: after };
    report("retained");
  }

  async function reuse({ proof, nowMs, maximumAgeMs, signal = null, onReuseDiagnostic = null }) {
    const report = code => reportLocalRefreshReuseDiagnostic(onReuseDiagnostic, "lookup", code);
    throwIfAborted(signal);
    // The durable last-good artifact is retained independently. Drop an
    // unusable process clone before a rebuild so it does not consume that
    // build's RSS budget alongside a second full result. Clearing it also
    // revokes matches(), which authorizes the runner's durable-cache fallback.
    const miss = code => { report(code); retained = null; return null; };
    if (!proof) return miss("proof_unavailable");
    if (!retained) return miss("retained_absent");
    if (proof.key !== retained.proof.key) {
      for (const part of ["file", "revision", "baselines", "origins", "policy"]) {
        if (proof.components?.[part] !== retained.proof.components?.[part]) report(`inputs_${part}_changed`);
      }
      return miss("inputs_changed");
    }
    const previous = retained.cache;
    const evaluatedAt = Date.parse(previous.coveredAt.endAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(maximumAgeMs) || maximumAgeMs < 0
        || nowMs < evaluatedAt) return miss("clock_invalid");
    if (nowMs - evaluatedAt > maximumAgeMs) return miss("expired");
    if (previous.sourceDescriptor.fallbackCount !== 0) return miss("fallback_present");
    if (previous.weeklyApiIntervals?.status !== "available") return miss("intervals_unavailable");
    // This is a newly composed publication of calculations evaluated at the
    // ORIGINAL instant, not a recalculation of moving windows at nowMs.
    assertReplaySafeAccountingCache(previous);
    const stillCurrent = () => {
      try {
        const identity = readIdentity({ indexFile });
        return sameGeneration(identity, proof) && identity.calculationRevision === proof.calculationRevision
          && digest(fileIdentity(indexFile)) === digest(proof.fileKey);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        return false;
      }
    };
    if (sameGeneration(proof, retained.proof)) {
      if (!stillCurrent()) return miss("identity_changed");
      const cache = structuredClone(previous);
      report("reused");
      return cache;
    }
    const cache = structuredClone(previous);
    const coverage = proof.coverage;
    const source = cache.sourceDescriptor;
    source.generation = proof.id;
    source.generationFingerprint = proof.fingerprint;
    Object.assign(source.coverage, {
      generatedAt: proof.committedAtMs > 0 ? new Date(proof.committedAtMs).toISOString() : null,
      sourceCount: coverage.indexedSourceCount, sourceBytes: coverage.indexedSourceBytes,
      skippedSourceCount: coverage.skippedSourceCount, skippedSourceBytes: coverage.skippedSourceBytes,
      skippedThreadCount: coverage.skippedThreadCount,
    });
    for (const value of [cache.history, cache.history.coverage]) {
      value.generation = proof.id;
      value.generationFingerprint = proof.fingerprint;
    }
    for (const value of [cache.planScopedTimeline,
      ...cache.historicalPlanComparisons.map(row => row.planScopedTimeline)]) {
      if (value.status === "available") Object.assign(value.planScope, {
        sourceGeneration: proof.id, sourceGenerationFingerprint: proof.fingerprint,
      });
    }
    Object.assign(cache.weeklyApiIntervals, { sourceGeneration: String(proof.id), sourceFingerprint: proof.fingerprint });
    const { publicDiagnostics, MAX_CACHE_BYTES } = REPLAY_SAFE_CALIBRATION_INTERNALS;
    cache.diagnostics = publicDiagnostics(proof.diagnostics);
    assertReplaySafeAccountingCache(cache);
    if (Buffer.byteLength(serializeLocalCollectorAccountingCache(cache)) > MAX_CACHE_BYTES) { report("cache_oversize"); return null; }
    throwIfAborted(signal);
    if (!stillCurrent()) return miss("identity_changed");
    await write({ stateFile, cache, signal });
    retained = { cache: structuredClone(cache), proof };
    report("republished");
    return cache;
  }

  return { readProof, remember, reuse,
    matches: proof => Boolean(proof && retained && proof.key === retained.proof.key),
  };
}
