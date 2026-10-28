import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createLocalIndexAccountingReuse } from "../src/local-index-accounting-reuse.js";
import { buildLocalIndexAccountingCache } from "../src/local-index-accounting-cache.js";
import { readLocalIndexGenerationIdentity } from "../src/local-index-companion-source.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { assertReplaySafeAccountingCache } from "../src/replay-safe-accounting-cache.js";
import { createWorkspace } from "./helpers/local-index-facts.js";
import { createLocalCollectorRefreshRunner } from "../src/local-companion-refresh.js";
import { captureRuntimeModelEvidence } from "../src/local-index-runtime-model-evidence.js";

const NOW = Date.parse("2026-09-01T01:00:00.000Z");

test("process-local semantic reuse recomposes metadata and preserves the evaluation clock and fences", async t => {
  const workspace = createWorkspace({ files: 1, events: 100, days: 1 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "index.sqlite");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
    secretFile: workspace.secretFile, workerCount: 1 });
  let origin = false, known = true, writes = 0, identityOverride = null, identityError = false;
  const readIdentity = () => {
    if (identityError) throw new Error("synthetic identity read failure");
    return identityOverride ?? readLocalIndexGenerationIdentity({ indexFile });
  };
  const reuse = createLocalIndexAccountingReuse({ indexFile, codexHome: workspace.codexHome,
    stateFile: join(workspace.state, "collector.sqlite"), readIdentity,
    readOrigins: async (_home, ids) => ({ complete: true, relations: new Map(ids.map(id => [id, { autoReview: known && origin, originKnown: known }])) }),
    write: async ({ cache }) => { assertReplaySafeAccountingCache(cache); writes++; },
  });
  const firstGeneration = readIdentity();
  const reasons = [];
  const onReuseDiagnostic = value => reasons.push(value);
  const before = await reuse.readProof({ generation: firstGeneration });
  assert.ok(before);
  const rangeReader = new DatabaseSync(indexFile, { readOnly: true });
  try {
    assert.deepEqual({ ...before.usageRange }, { ...rangeReader.prepare(
      "SELECT MIN(observed_at_ms) AS first,MAX(observed_at_ms) AS last FROM usage_event").get() });
  } finally { rangeReader.close(); }
  assert.equal(await reuse.reuse({ proof: before, nowMs: NOW, maximumAgeMs: 1_800_000, onReuseDiagnostic }), null,
    "restart has no process-local calculation proof");
  assert.deepEqual(reasons.pop(), { phase: "lookup", code: "retained_absent" });
  const cache = await buildLocalIndexAccountingCache({ indexFile, codexHome: workspace.codexHome,
    expectedGeneration: firstGeneration, now: () => NOW });
  reuse.remember({ cache, before, after: await reuse.readProof({ generation: firstGeneration }) });
  const database = new DatabaseSync(indexFile);
  try {
    database.exec("BEGIN; UPDATE source SET mtime_ms=mtime_ms+1; UPDATE store_state SET commit_seq=commit_seq+1 WHERE id=1; COMMIT");
  } finally { database.close(); }
  const generation = readIdentity();
  assert.notEqual(generation.id, firstGeneration.id);
  assert.equal(generation.calculationRevision, firstGeneration.calculationRevision);
  const proof = await reuse.readProof({ generation });
  identityOverride = { ...generation, id: generation.id + 1 };
  assert.equal(await reuse.reuse({ proof, nowMs: NOW + 60_000, maximumAgeMs: 1_800_000 }), null);
  assert.equal(reuse.matches(proof), false, "a failed live fence cannot authorize the runner's durable fallback");
  identityOverride = null;
  reuse.remember({ cache, before, after: before });
  const result = await reuse.reuse({ proof, nowMs: NOW + 60_000, maximumAgeMs: 1_800_000 });
  assert.ok(result);
  assert.equal(writes, 1);
  assert.equal(result.generatedAt, cache.generatedAt);
  assert.deepEqual(result.coveredAt, cache.coveredAt);
  assert.deepEqual(result.periods, cache.periods);
  assert.equal(String(result.sourceDescriptor.generation), String(generation.id));
  assert.equal(String(result.history.generation), String(generation.id));
  assert.equal(result.weeklyApiIntervals.sourceFingerprint, generation.fingerprint);
  const inactiveLedger = [{ mode: "fast", firstSeenAt: "2026-09-02T00:00:00.000Z", lastSeenAt: "2026-09-03T00:00:00.000Z" }];
  assert.equal((await reuse.readProof({ generation, declaredSpeedBaselines: inactiveLedger })).key, proof.key,
    "a baseline observation wholly after source usage does not change calculations");
  assert.ok(await reuse.reuse({ proof, nowMs: NOW + 120_000, maximumAgeMs: 1_800_000 }));
  assert.equal(writes, 1, "same-generation process hits do not republish SQLite");
  assert.equal(String(cache.sourceDescriptor.generation), String(firstGeneration.id), "original artifact is not mutated");
  const remember = () => reuse.remember({ cache: result, before: proof, after: proof });
  assert.equal(await reuse.reuse({ proof, nowMs: NOW + 1_800_001, maximumAgeMs: 1_800_000, onReuseDiagnostic }), null);
  assert.deepEqual(reasons.pop(), { phase: "lookup", code: "expired" });
  assert.equal(reuse.matches(proof), false, "an expired process clone is released before rebuilding");
  remember();
  assert.equal(await reuse.reuse({ proof, nowMs: NOW - 1, maximumAgeMs: 1_800_000 }), null);
  remember();
  origin = true;
  assert.equal(await reuse.reuse({ proof: await reuse.readProof({ generation }), nowMs: NOW + 60_000, maximumAgeMs: 1_800_000 }), null);
  known = false;
  const originCounts = [];
  const unknownProof = await reuse.readProof({ generation, onReuseDiagnostic, onOriginDiagnostic: value => originCounts.push(value) });
  assert.ok(unknownProof);
  assert.notEqual(unknownProof.key, proof.key);
  assert.deepEqual(reasons.pop(), { phase: "proof_before", code: "proof_available" });
  assert.deepEqual(originCounts, [
    { phase: "proof_before", code: "unknown_with_usage", count: 1 },
    { phase: "proof_before", code: "unknown_without_usage", count: 0 },
  ]);
  const october = Date.parse("2026-10-10T03:00:00.000Z");
  const uncertain = await buildLocalIndexAccountingCache({ indexFile, codexHome: workspace.codexHome,
    expectedGeneration: generation, now: () => october });
  uncertain.weeklyApiIntervals.rows = [{ startMs: october - 120_000, endMs: october - 60_000,
    planType: "plus", segment: 1, quotaPp: 1, apiUsd: "1", weeklyUsd: null,
    reason: "review_origin_unresolved", usageEvents: 1, unknownSpeedEvents: 0,
    excludedReviewEvents: 0, excludedReviewUsd: "0", priceCardIds: [] }];
  assertReplaySafeAccountingCache(uncertain);
  reuse.remember({ cache: uncertain, before: unknownProof, after: await reuse.readProof({ generation }) });
  const retainedUnknown = await reuse.reuse({ proof: unknownProof, nowMs: october, maximumAgeMs: 1_800_000 });
  assert.ok(retainedUnknown);
  assert.deepEqual(retainedUnknown.weeklyApiIntervals, uncertain.weeklyApiIntervals);
  assert.equal(retainedUnknown.weeklyApiIntervals.rows[0].reason, "review_origin_unresolved");
  known = true;
  assert.equal(await reuse.reuse({ proof: await reuse.readProof({ generation }), nowMs: october, maximumAgeMs: 1_800_000 }), null,
    "unknown becoming known invalidates reuse");
  known = false;
  reuse.remember({ cache: result, before: proof, after: null, onReuseDiagnostic });
  assert.deepEqual(reasons.pop(), { phase: "remember", code: "proof_unavailable" });
  known = true; origin = false;
  remember();
  const changedLedger = [{ mode: "fast", firstSeenAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-10-01T00:00:00.000Z" }];
  assert.equal(await reuse.reuse({ proof: await reuse.readProof({ generation, declaredSpeedBaselines: changedLedger }),
    nowMs: NOW + 60_000, maximumAgeMs: 1_800_000 }), null);
  identityOverride = { ...generation, id: generation.id + 1 };
  remember();
  assert.equal(await reuse.reuse({ proof, nowMs: NOW + 60_000, maximumAgeMs: 1_800_000 }), null);
  assert.equal(reuse.matches(proof), false, "same-generation fence rejection clears the retained proof too");
  identityOverride = null;
  remember();
  identityError = true;
  assert.equal(await reuse.reuse({ proof, nowMs: NOW + 60_000, maximumAgeMs: 1_800_000 }), null);
  assert.equal(reuse.matches(proof), false, "an unreadable live identity cannot authorize fallback");
  identityError = false;
  const aborted = new AbortController(); aborted.abort();
  remember();
  await assert.rejects(reuse.reuse({ proof, nowMs: NOW, maximumAgeMs: 1_800_000, signal: aborted.signal }), { name: "AbortError" });
  assert.equal(writes, 1);
  identityOverride = null;
  const changed = new DatabaseSync(indexFile);
  try { changed.exec("UPDATE usage_event SET tokens_out_text=COALESCE(tokens_out_text,0)+1"); }
  finally { changed.close(); }
  const materialGeneration = readIdentity();
  assert.notEqual(materialGeneration.calculationRevision, generation.calculationRevision);
  const changeReasons = [];
  assert.equal(await reuse.reuse({ proof: await reuse.readProof({ generation: materialGeneration }),
    nowMs: NOW + 60_000, maximumAgeMs: 1_800_000, onReuseDiagnostic: value => changeReasons.push(value.code) }), null);
  assert.ok(changeReasons.includes("inputs_revision_changed"));
});

test("runtime capture during accounting preserves the proof and the next refresh reuses calculations", async t => {
  const workspace = createWorkspace({ files: 1, events: 100, days: 1 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "index.sqlite");
  const stateFile = join(workspace.state, "collector.sqlite");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
    secretFile: workspace.secretFile, workerCount: 1 });
  const index = new DatabaseSync(indexFile, { readOnly: true });
  let sessions;
  try { sessions = index.prepare("SELECT session_uuid FROM session").all(); }
  finally { index.close(); }
  // Minimal, content-free selected-thread metadata for the runner's real origin reader.
  const metadata = new DatabaseSync(join(workspace.codexHome, "state_5.sqlite"));
  try {
    metadata.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, source TEXT, thread_source TEXT, rollout_path TEXT)");
    const insert = metadata.prepare("INSERT INTO threads VALUES (?,NULL,'cli',NULL)");
    for (const row of sessions) insert.run(row.session_uuid);
  } finally { metadata.close(); }
  const proofReader = createLocalIndexAccountingReuse({ indexFile, stateFile,
    codexHome: workspace.codexHome });
  let rebuilds = 0, nowMs = NOW, buildFailure = null;
  const runner = createLocalCollectorRefreshRunner({
    stateFile, unifiedIndexFile: indexFile, codexHome: workspace.codexHome,
    clock: () => nowMs,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({ rolloutRecordsWritten: 0, filesDiscovered: 1,
      refresh: { attempted: false, recordWritten: false, errorCode: null } }),
    refreshUnifiedIndex: async () => ({ status: "ingested", unchanged: true, generation: {
      ...readLocalIndexGenerationIdentity({ indexFile }), status: "complete",
      discoveryComplete: true, diagnosticsComplete: true, usageProvenanceComplete: true,
      sourceOrderComplete: true, quotaProvenanceComplete: true, toolProvenanceComplete: true,
    } }),
    refreshAccounting: async ({ expectedGeneration }) => {
      try {
        rebuilds++;
        const before = await proofReader.readProof({ generation: expectedGeneration });
        assert.ok(before, "the runner uses real, readable synthetic origin metadata");
        const cache = await buildLocalIndexAccountingCache({ indexFile,
          codexHome: workspace.codexHome, expectedGeneration, now: () => nowMs });
        const captured = await captureRuntimeModelEvidence({ indexFile,
          codexHome: workspace.codexHome, secretFile: workspace.secretFile, now: () => nowMs,
          readBatch: async () => ({ identity: "a".repeat(64), lastId: rebuilds, more: false,
            rows: [{ id: rebuilds, ts: (NOW - 1000) / 1000, ts_nanos: 0,
              thread_id: sessions[0].session_uuid, target: "codex_api::sse::responses", bytes: 200,
              body: "SSE event: " + JSON.stringify({ type: "response.completed", response: {
                id: `synthetic-unmatched-response-${rebuilds}`, status: "completed", model: "gpt-6.1-sol",
              } }),
            }],
          }),
        });
        assert.equal(captured.capturedNow, 1);
        assert.equal(captured.applied, 0);
        const after = await proofReader.readProof({ generation: expectedGeneration });
        assert.equal(after.key, before.key, "unapplied evidence cannot invalidate a completed calculation");
        assert.deepEqual(await buildLocalIndexAccountingCache({ indexFile,
          codexHome: workspace.codexHome, expectedGeneration, now: () => nowMs }), cache);
        return cache;
      } catch (error) { buildFailure = error; throw error; }
    },
  });
  const refresh = async () => { const result = await runner(); assert.ifError(buildFailure); return result; };
  const first = await refresh();
  assert.equal(first.accounting.refreshStatus, "rebuilt");
  nowMs += 60_000;
  const second = await refresh();
  assert.equal(second.accounting.refreshStatus, "reused");
  assert.equal(second.accounting.generatedAt, first.accounting.generatedAt);
  assert.equal(rebuilds, 1);
  const changed = new DatabaseSync(indexFile);
  try { changed.exec("UPDATE usage_event SET tokens_out_text=COALESCE(tokens_out_text,0)+1"); }
  finally { changed.close(); }
  assert.equal((await refresh()).accounting.refreshStatus, "rebuilt", "changed facts still invalidate reuse");
  assert.equal(rebuilds, 2);
});

test("complete unknown origins are stable inputs; per-session changes and incomplete receipts fail closed", async t => {
  const workspace = createWorkspace({ files: 2, events: 10, days: 1 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "index.sqlite");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile, secretFile: workspace.secretFile, workerCount: 1 });
  const generation = readLocalIndexGenerationIdentity({ indexFile });
  let statuses = ["unknown", "normal"], complete = true, idsSeen = [];
  const reuse = createLocalIndexAccountingReuse({ indexFile, codexHome: workspace.codexHome,
    stateFile: join(workspace.state, "collector.sqlite"), readOrigins: async (_home, ids, options) => {
      assert.equal(options.withOriginReadReceipt, true); idsSeen = ids;
      return { complete, relations: new Map(ids.map((id, index) => [id,
        { originKnown: statuses[index] !== "unknown", autoReview: statuses[index] === "auto_review" }])) };
    } });
  const before = await reuse.readProof({ generation });
  assert.equal(idsSeen.length, 2); assert.ok(before);
  assert.equal(idsSeen.some(id => JSON.stringify(before).includes(id)), false);
  const cache = await buildLocalIndexAccountingCache({ indexFile, codexHome: workspace.codexHome,
    expectedGeneration: generation, now: () => NOW });
  reuse.remember({ cache, before, after: await reuse.readProof({ generation }) });
  assert.ok(await reuse.reuse({ proof: before, nowMs: NOW, maximumAgeMs: 1_800_000 }));
  statuses = ["normal", "unknown"];
  const changedUnknownIdentity = await reuse.readProof({ generation });
  assert.notEqual(changedUnknownIdentity.key, before.key);
  assert.equal(await reuse.reuse({ proof: changedUnknownIdentity, nowMs: NOW, maximumAgeMs: 1_800_000 }), null);
  statuses = ["unknown", "unknown"];
  const allUnknown = await reuse.readProof({ generation });
  assert.ok(allUnknown); assert.notEqual(allUnknown.key, before.key);
  reuse.remember({ cache, before: allUnknown, after: await reuse.readProof({ generation }) });
  assert.ok(await reuse.reuse({ proof: allUnknown, nowMs: NOW, maximumAgeMs: 1_800_000 }));
  statuses = ["unknown", "auto_review"];
  assert.equal(await reuse.reuse({ proof: await reuse.readProof({ generation }), nowMs: NOW, maximumAgeMs: 1_800_000 }), null);
  complete = false;
  assert.equal(await reuse.readProof({ generation }), null);
  reuse.remember({ cache, before: allUnknown, after: null });
  assert.equal(reuse.matches(allUnknown), false);
});


test("an empty index with no published generation cannot authorize reuse", async t => {
  const workspace = createWorkspace({ files: 1, events: 1, days: 1 });
  t.after(() => workspace.cleanup());
  const home = join(workspace.root, "empty-codex"); mkdirSync(home);
  const indexFile = join(workspace.state, "empty.sqlite");
  await refreshLocalIndex({ codexHome: home, indexFile, secretFile: workspace.secretFile, workerCount: 1 });
  const generation = readLocalIndexGenerationIdentity({ indexFile });
  let reads = 0;
  const reuse = createLocalIndexAccountingReuse({ indexFile, codexHome: home,
    stateFile: join(workspace.state, "collector.sqlite"), readOrigins: async () => { reads++; throw new Error("unexpected"); } });
  const first = await reuse.readProof({ generation });
  assert.equal(first, null); assert.equal(reads, 0);
});

test("calculation proofs bind the effective unknown-speed assumption, not an inactive input", async t => {
  const workspace = createWorkspace({ files: 1, events: 2, days: 1 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "index.sqlite");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
    secretFile: workspace.secretFile, workerCount: 1 });
  const generation = readLocalIndexGenerationIdentity({ indexFile });
  const reuse = createLocalIndexAccountingReuse({ indexFile, stateFile: join(workspace.state, "collector.sqlite"),
    codexHome: workspace.codexHome, readOrigins: async (_home, ids) => ({ complete: true,
      relations: new Map(ids.map(id => [id, { originKnown: false, autoReview: false }])) }) });
  const proof = policy => reuse.readProof({ generation, unknownSpeedPolicy: policy });
  const standard = await proof({ mode: "standard", customFastRatioBps: null });
  assert.ok(standard);
  assert.equal((await proof({ mode: "standard", customFastRatioBps: 300 })).key, standard.key);
  assert.notEqual((await proof({ mode: "fast", customFastRatioBps: null })).key, standard.key);
  const custom = await proof({ mode: "custom", customFastRatioBps: 300 });
  assert.notEqual(custom.key, standard.key);
  assert.notEqual((await proof({ mode: "custom", customFastRatioBps: 301 })).key, custom.key);
  await assert.rejects(proof({ mode: "custom", customFastRatioBps: null }), /policy is invalid/);
});
