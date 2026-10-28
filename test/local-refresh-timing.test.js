import test from "node:test";
import assert from "node:assert/strict";
import { createLocalRefreshTimer, createLocalRefreshTimingRecorder, reportLocalRefreshReuseDiagnostic, reportLocalRefreshOriginDiagnostic, LOCAL_REFRESH_TIMING_STAGES } from "../src/local-refresh-timing.js";
import { LocalCompanionRefreshController } from "../src/local-companion-refresh.js";

test("monotonic timing keeps inclusive spans, isolates snapshots and freezes settlement", async () => {
  let ms = 0;
  const clock = () => ms;
  const recorder = createLocalRefreshTimingRecorder({ clock });
  const timer = createLocalRefreshTimer({ clock, onTiming: recorder.record });
  await timer.measure("refresh_runner", async () => {
    ms += 3;
    timer.measureSync("quota_collect", () => { ms += 7; });
    await timer.measure("index_refresh", async () => { ms += 11; });
  });
  assert.equal(recorder.snapshot().totalMs, null, "a running total is not a completion claim or a changing join receipt");
  recorder.finish();
  const value = recorder.snapshot();
  assert.equal(value.totalMs, 21);
  assert.deepEqual(value.stages.map(row => [row.stage, row.wallMs]), [["refresh_runner", 21], ["quota_collect", 7], ["index_refresh", 11]]);
  value.stages[0].wallMs = 999;
  ms += 100;
  recorder.record({ stage: "index_refresh", wallMs: 100, outcome: "completed" });
  recorder.finish();
  assert.equal(recorder.snapshot().stages[0].wallMs, 21);
  assert.equal(recorder.snapshot().totalMs, 21);
});

test("errors and aborts preserve identity, and diagnostic observers cannot affect work", async () => {
  let ms = 0;
  const recorder = createLocalRefreshTimingRecorder({ clock: () => ms });
  const timer = createLocalRefreshTimer({ clock: () => ms, onTiming: recorder.record });
  const error = new Error("synthetic failure"), abort = Object.assign(new Error("synthetic abort"), { name: "AbortError" });
  await assert.rejects(timer.measure("accounting_scan", async () => { ms += 5; throw error; }), value => value === error);
  assert.throws(() => timer.measureSync("accounting_scan", () => { ms += 2; throw abort; }), value => value === abort);
  assert.deepEqual(recorder.snapshot().stages, [{ stage: "accounting_scan", wallMs: 7, calls: 2, failed: 1, cancelled: 1 }]);
  for (const onTiming of [() => { throw error; }, async () => { throw error; }]) {
    assert.equal(await createLocalRefreshTimer({ onTiming }).measure("accounting_fit", () => 42), 42);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("timings reject private, unknown, excessive or invalid input and never invent a clock reading", async () => {
  let ms = 10;
  const recorder = createLocalRefreshTimingRecorder({ clock: () => ms });
  for (const value of [
    { stage: "private/source", wallMs: 1, outcome: "completed" },
    { stage: "quota_collect", wallMs: 1, outcome: "completed", path: "synthetic-private" },
    { stage: "quota_collect", wallMs: -1, outcome: "completed" },
    { stage: "quota_collect", wallMs: Infinity, outcome: "completed" },
    { stage: "quota_collect", wallMs: 86400001, outcome: "completed" },
    { stage: "quota_collect", wallMs: 1, outcome: "unknown" },
  ]) recorder.record(value);
  const timer = createLocalRefreshTimer({ onTiming: recorder.record, clock: () => ms });
  timer.measureSync("quota_collect", () => { ms = 9; });
  ms = NaN;
  await timer.measure("index_refresh", async () => 42);
  recorder.finish();
  assert.deepEqual(recorder.snapshot(), { schemaVersion: "local-refresh-timing-v1", totalMs: null, stages: [], reuse: [], origins: [] });
  assert.throws(() => timer.start("unknown"), TypeError);
});

test("controller reports measured collection, publication and reload across isolated runs", async () => {
  let ms = 0;
  const controller = new LocalCompanionRefreshController({
    monotonicClock: () => ms,
    dataStore: { publishQuota: async () => { ms += 2; return { published: true }; }, reload: async () => { ms += 11; } },
    runner: async ({ onTiming, onQuotaReady, onReuseDiagnostic, onOriginDiagnostic }) => {
      reportLocalRefreshReuseDiagnostic(onReuseDiagnostic, "proof_before", "origins_unknown");
      reportLocalRefreshOriginDiagnostic(onOriginDiagnostic, "proof_before", "thread_row_missing", 1);
      const timer = createLocalRefreshTimer({ onTiming, clock: () => ms });
      await timer.measure("quota_collect", async () => { ms += 5; });
      await onQuotaReady({ recordWritten: true });
      await timer.measure("index_refresh", async () => { ms += 7; });
      return {};
    },
  });
  for (let run = 0; run < 2; run++) {
    controller.start({ mode: "overview" });
    await controller.whenSettled();
    const status = controller.getStatus();
    assert.equal(status.status, "succeeded");
    assert.equal(status.timing.totalMs, 25);
    assert.deepEqual(status.timing.reuse, [{ phase: "proof_before", code: "origins_unknown", calls: 1 }]);
    assert.deepEqual(status.timing.origins, [{ phase: "proof_before", code: "thread_row_missing", count: 1 }]);
    assert.deepEqual(Object.fromEntries(status.timing.stages.map(row => [row.stage, row.wallMs])), {
      refresh_runner: 14, quota_collect: 5, quota_publish: 2, index_refresh: 7, snapshot_reload: 11,
    });
    assert.ok(status.timing.stages.every(row => row.calls === 1));
    assert.ok(status.timing.stages.every(row => LOCAL_REFRESH_TIMING_STAGES.includes(row.stage)));
  }
});

test("origin counters reject unknown, private, unbounded and late evidence", async () => {
  const recorder = createLocalRefreshTimingRecorder();
  for (const value of [
    { phase: "lookup", code: "known", count: 1 },
    { phase: "proof_before", code: "private", count: 1 },
    { phase: "proof_before", code: "known", count: 1, id: "private" },
    { phase: "proof_before", code: "known", count: 25_001 },
    { phase: "proof_before", code: "known", count: -1 },
    { phase: "proof_before", code: "known", count: 0.5 },
  ]) recorder.recordOrigin(value);
  assert.deepEqual(recorder.snapshot().origins, []);
  recorder.recordOrigin({ phase: "proof_before", code: "unknown_with_usage", count: 0 });
  recorder.recordOrigin({ phase: "proof_before", code: "known", count: 25_000 });
  recorder.recordOrigin({ phase: "proof_before", code: "known", count: 1 });
  assert.deepEqual(recorder.snapshot().origins.map(row => row.count), [0, 25_000]);
  const snapshot = recorder.snapshot(); snapshot.origins[0].count = 999;
  recorder.finish(); recorder.recordOrigin({ phase: "proof_after", code: "known", count: 1 });
  assert.equal(recorder.snapshot().origins.length, 2);
  assert.equal(recorder.snapshot().origins[0].count, 0);
  reportLocalRefreshOriginDiagnostic(async () => { throw Error("private"); }, "proof_before", "known", 1);
  await new Promise(resolve => setImmediate(resolve));
});

test("reuse reasons are closed, bounded, isolated and cannot interfere with operations", async () => {
  const recorder = createLocalRefreshTimingRecorder();
  recorder.recordReuse({ phase: "lookup", code: "private-source" });
  recorder.recordReuse({ phase: "private-thread", code: "expired" });
  recorder.recordReuse({ phase: "lookup", code: "expired", path: "private" });
  assert.deepEqual(recorder.snapshot().reuse, []);
  for (let i = 0; i < 100; i++) reportLocalRefreshReuseDiagnostic(recorder.recordReuse, "lookup", "expired");
  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.reuse, [{ phase: "lookup", code: "expired", calls: 100 }]);
  snapshot.reuse[0].code = "private";
  recorder.finish();
  reportLocalRefreshReuseDiagnostic(recorder.recordReuse, "lookup", "reused");
  assert.deepEqual(recorder.snapshot().reuse, [{ phase: "lookup", code: "expired", calls: 100 }]);
  for (const observer of [() => { throw Error("private"); }, async () => { throw Error("private"); }]) {
    reportLocalRefreshReuseDiagnostic(observer, "lookup", "expired");
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("detailed startup diagnostics retain only fixed stage and reason codes", () => {
  const recorder = createLocalRefreshTimingRecorder();
  for (const code of ["rescan_response_reconciliation", "rescan_same_size_changed"]) {
    reportLocalRefreshReuseDiagnostic(recorder.recordReuse, "index", code);
  }
  reportLocalRefreshReuseDiagnostic(recorder.recordReuse, "lookup", "inputs_revision_changed");
  reportLocalRefreshReuseDiagnostic(recorder.recordReuse, "index", "private/path");
  assert.deepEqual(recorder.snapshot().reuse.map(row => row.code),
    ["rescan_response_reconciliation", "rescan_same_size_changed", "inputs_revision_changed"]);
});
