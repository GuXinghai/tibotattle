import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshLocalIndex } from "../../src/local-index-refresh.js";
import { readLocalIndexCompanionProjection } from "../../src/local-index-companion-source.js";
import { createLocalIndexBackend } from "../../src/local-index-backend.js";
import { openLocalIndexStore } from "../../src/local-index-store.js";
import assert from "node:assert/strict";
import { createCachedLocalUnifiedProjectionReader, selectSharedWorkUsageSnapshot } from "./server.js";
import { createWorkUsageService } from "../../src/application/work-usage.js";
import { WORK_USAGE_SCHEMA } from "../../src/reporting/work-usage.js";

const generation = `generation-v2-${"a".repeat(64)}`;
const options = nowMs => ({ mode: "full", nowMs, indexFile: "/private/index.sqlite", codexHome: "/private/codex", includeWorkUsage: true });
function combined(nowMs, marker = 1) {
  return {
    companion: { status: "available", generation: { fingerprint: generation }, marker },
    workUsage: { status: "available", asOfMs: nowMs, periods: Object.fromEntries(
      [["24h", 86400000], ["7d", 7 * 86400000], ["30d", 30 * 86400000], ["all", null]].map(([id, duration]) => [id, {
        fromMs: duration === null ? 0 : Math.max(0, nowMs - duration), toMs: nowMs,
        scopes: [{ id: "account-a", status: "available" }, { id: "unknown", status: "unavailable" }],
        snapshots: Object.fromEntries(["account-a", "unknown"].map(scope => [scope, {
          status: "available", scope, scopes: [], cells: [], models: [], threadLookup: {}, metadata: {}, marker,
        }])),
      }]),
    ) },
  };
}
function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test("each work-usage timestamp builds fresh while one result selects every period and scope", async () => {
  let reads = 0;
  let fingerprint = generation;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => { reads++; return combined(o.nowMs, reads); },
    readGeneration: async () => fingerprint,
    validUntil: async o => o.nowMs + 1000,
  });
  const first = await reader(options(100));
  first.workUsage.periods.all.snapshots["account-a"].marker = 999;
  const afterMutation = await reader(options(100));
  assert.equal(afterMutation.workUsage.periods.all.snapshots["account-a"].marker, 2);
  for (const period of ["24h", "7d", "30d", "all"]) {
    for (const scope of ["account-a", "unknown"]) {
      const value = selectSharedWorkUsageSnapshot(afterMutation, { period, scope });
      assert.equal(value.marker, 2);
      assert.equal(value.toMs, 100);
      assert.equal(value.scope, scope);
    }
  }
  assert.equal(reads, 2);
  assert.throws(() => selectSharedWorkUsageSnapshot(first, { period: "all", scope: "other" }), { code: "work_usage_scope_unavailable" });
  assert.equal(selectSharedWorkUsageSnapshot(first, { period: "all" }).scope, "unknown");
  const newer = await reader(options(150));
  assert.equal(newer.workUsage.asOfMs, 150);
  assert.equal(newer.workUsage.periods.all.snapshots["account-a"].marker, 3);
  assert.equal(reads, 3);
  await reader(options(1100));
  assert.equal(reads, 4);
  fingerprint = `generation-v2-${"b".repeat(64)}`;
  await reader(options(1101));
  assert.equal(reads, 5);
});

test("a deferred work-usage read never serves a prior completed full result", async () => {
  const modes = [];
  let fingerprint = generation;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => {
      modes.push(o.mode);
      return o.mode === "full" ? combined(o.nowMs, modes.length) : { companion: { status: "deferred" } };
    },
    readGeneration: async () => fingerprint,
    validUntil: async o => o.nowMs + 1000,
  });
  const deferred = nowMs => ({ ...options(nowMs), mode: "deferred" });

  // Nothing completed yet: the deferred read stays deferred and builds nothing.
  assert.equal((await reader(deferred(50))).companion.status, "deferred");
  assert.deepEqual(modes, ["deferred"]);

  // A full result is usable for its original request but is not reused by a
  // later deferred read because work usage includes external metadata.
  await reader(options(100));
  const served = await reader(deferred(150));
  assert.equal(served.companion.status, "deferred");
  assert.deepEqual(modes, ["deferred", "full", "deferred"]);

  assert.equal((await reader(deferred(1100))).companion.status, "deferred");
  await reader(options(1200));
  fingerprint = `generation-v2-${"b".repeat(64)}`;
  assert.equal((await reader(deferred(1250))).companion.status, "deferred");
  assert.deepEqual(modes, ["deferred", "full", "deferred", "deferred", "full", "deferred"]);
});

test("concurrent work-usage reads coalesce only when their timestamps match", async () => {
  const gate = latch(); let reads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => { reads++; await gate.promise; return combined(o.nowMs); },
    readGeneration: async () => generation, validUntil: async () => 1000,
  });
  const a = reader(options(100)); const b = reader(options(101)); const c = reader(options(100));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  gate.resolve();
  const results = await Promise.all([a, b, c]);
  assert.equal(reads, 2);
  assert.deepEqual(results.map(r => r.workUsage.asOfMs), [100, 101, 100]);
});

test("cancelling one subscriber preserves another; cancelling every subscriber prevents publication", async () => {
  let gate = latch(); let reads = 0; let buildSignal;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async (o, controls) => { reads++; buildSignal = controls.signal; await gate.promise; return combined(o.nowMs, reads); },
    readGeneration: async () => generation, validUntil: async o => o.nowMs + 100,
  });
  const controller = new AbortController();
  const a = reader(options(100), { signal: controller.signal });
  const b = reader(options(100));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(a, { code: "local_unified_companion_projection_aborted" });
  assert.equal(buildSignal.aborted, false);
  gate.resolve(); await b;
  gate = latch();
  const last = new AbortController();
  const c = reader(options(200), { signal: last.signal });
  await new Promise(resolve => setImmediate(resolve));
  last.abort();
  await assert.rejects(c, { code: "local_unified_companion_projection_aborted" });
  assert.equal(buildSignal.aborted, true);
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await reader(options(201));
  assert.equal(reads, 3);
});

test("service reports cached accounting bounds and passes the selected period", async () => {
  let input;
  const service = createWorkUsageService({ clock: () => 1000,
    build: async query => { input = query; return selectSharedWorkUsageSnapshot(combined(900), query); },
    enrich: async () => ({}),
  });
  try {
    const query = { schemaVersion: WORK_USAGE_SCHEMA, period: "all" };
    const pending = await service.query(query);
    await new Promise(resolve => setImmediate(resolve));
    const result = await service.query({ ...query, snapshotId: pending.refreshSnapshotId ?? pending.snapshotId });
    assert.equal(input.period, "all");
    assert.equal(result.status, "available");
    assert.equal(result.fromMs, 0);
    assert.equal(result.toMs, 900);
  } finally { service.close(); }
});

test("temporary work failure is retried and bounded failure codes survive selection", async () => {
  let reads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => {
      const value = combined(o.nowMs);
      if (++reads === 1) value.workUsage = { status: "unavailable", errorCode: "work_usage_capacity_exceeded" };
      return value;
    },
    readGeneration: async () => generation, validUntil: async () => Infinity,
  });
  const failed = await reader(options(100));
  assert.throws(() => selectSharedWorkUsageSnapshot(failed, { period: "all" }), { code: "work_usage_capacity_exceeded" });
  assert.equal((await reader(options(101))).workUsage.status, "available");
  assert.equal(reads, 2);
});

test("selectors isolate dashboard and work shapes across fresh work-usage timestamps", async () => {
  let reads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => { reads++; return combined(o.nowMs, reads); },
    readGeneration: async () => generation, validUntil: async () => Infinity,
  });
  const dashboard = await reader(options(100), { selectProjection: p => p.companion });
  assert.equal(dashboard.status, "available");
  assert.equal(Object.hasOwn(dashboard, "workUsage"), false);
  dashboard.marker = 999;
  const work = await reader(options(101), { selectProjection: p => selectSharedWorkUsageSnapshot(p, { period: "all", scope: "account-a" }) });
  assert.equal(Object.hasOwn(work, "companion"), false);
  assert.equal(work.marker, 2);
  assert.equal(reads, 2);
});


test("real index work validity stays measured while each work projection is rebuilt", async t => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  for (const observedAt of [now - 86400000, now, now + 100]) {
    const root = await mkdtemp(join(tmpdir(), "work-cache-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "sessions"));
    const id = "10000000-0000-4000-8000-000000000001";
    const rows = [
      { type: "session_meta", timestamp: new Date(observedAt - 1000).toISOString(), payload: { id, session_id: id, originator: "codex_cli_rs", thread_source: "user" } },
      { type: "turn_context", timestamp: new Date(observedAt - 1000).toISOString(), payload: { model: "gpt-5.6-sol" } },
      { type: "event_msg", timestamp: new Date(observedAt).toISOString(), payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      } } },
    ];
    await writeFile(join(root, "sessions", `rollout-2026-09-01T12-00-00-${id}.jsonl`), rows.map(JSON.stringify).join("\n") + "\n");
    const indexFile = join(root, "index.sqlite");
    await refreshLocalIndex({ codexHome: root, indexFile, workerCount: 1 });
    // The generation descriptor the companion projection publishes for this store.
    const descriptor = (await readLocalIndexCompanionProjection({ indexFile, nowMs: observedAt, codexHome: root })).generation;
    assert.ok(descriptor);
    const database = openLocalIndexStore(indexFile, { readOnly: true });
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 1);
    database.close();
    let reads = 0;
    // Preserve the real index's membership boundary proof independently of
    // completed projection reuse, which is disabled for work-usage reads.
    const backend = createLocalIndexBackend({ indexFile });
    const validUntil = nowMs => backend.projectionReader.validUntil({
      indexFile,
      generationFingerprint: descriptor.fingerprint,
      nowMs,
      includeWorkUsage: true,
    });
    const boundary = observedAt < now ? now + 1 : observedAt + 1;
    assert.equal(await validUntil(now), boundary);
    assert.equal(await validUntil(boundary - 1), boundary);
    assert.ok(await validUntil(boundary) > boundary);

    const reader = createCachedLocalUnifiedProjectionReader({
      ...backend.projectionReader,
      reader: async o => {
        reads++;
        const result = combined(o.nowMs);
        result.companion.generation = descriptor;
        return result;
      },
    });
    const request = time => ({ ...options(time), indexFile, codexHome: root });
    await reader(request(now));
    await reader(request(boundary - 1));
    assert.equal(reads, 2);
    await reader(request(boundary));
    assert.equal(reads, 3);
  }
});

test("related periods rebuild work usage while preserving the selected snapshot anchor", async () => {
  let now = 10 * 86400000;
  let reads = 0;
  const cached = createCachedLocalUnifiedProjectionReader({
    readGeneration: async () => generation,
    validUntil: async o => o.nowMs + 1,
    reader: async o => { reads++; now += 60000; return combined(o.nowMs); },
  });
  const service = createWorkUsageService({ clock: () => now,
    build: async (q, controls) => selectSharedWorkUsageSnapshot(await cached(options(q.toMs), controls), q),
  });
  async function settle(query) {
    const pending = await service.query({ schemaVersion: WORK_USAGE_SCHEMA, ...query });
    await new Promise(resolve => setImmediate(resolve));
    return service.query({ schemaVersion: WORK_USAGE_SCHEMA, period: query.period, snapshotId: pending.refreshSnapshotId ?? pending.snapshotId });
  }
  try {
    let report = await settle({ period: "7d" });
    const originalAsOf = report.toMs;
    let expectedReads = 1;
    for (const period of ["30d", "all", "24h", "7d"]) {
      report = await settle({ period, sourceSnapshotId: report.snapshotId });
      expectedReads++;
      assert.equal(report.status, "available");
      assert.equal(report.toMs, originalAsOf);
      assert.equal(reads, expectedReads);
    }
    const fresh = await settle({ period: "7d" });
    expectedReads++;
    assert.equal(fresh.status, "available");
    assert.ok(fresh.toMs > originalAsOf);
    assert.equal(reads, expectedReads);
  } finally { service.close(); }
});


test("closing the shared reader aborts work and prevents builds after asynchronous generation lookup", async () => {
  let releaseGeneration;
  let calls = 0, closes = 0;
  const implementation = async () => { calls++; return combined(); };
  implementation.close = async () => { closes++; };
  const reader = createCachedLocalUnifiedProjectionReader({ reader: implementation,
    readGeneration: () => new Promise(resolve => { releaseGeneration = resolve; }),
    validUntil: async () => Infinity });
  const pending = reader({ indexFile: "/synthetic", mode: "full", includeWorkUsage: true, nowMs: 1 });
  await reader.close();
  releaseGeneration(generation);
  await assert.rejects(pending, { code: "local_unified_companion_projection_aborted" });
  await assert.rejects(reader({ mode: "deferred" }), { code: "local_unified_companion_projection_aborted" });
  await reader.close();
  assert.equal(calls, 0);
  assert.equal(closes, 1);
});

test("exact reporting windows preserve anchors while completed work projections stay fresh", async () => {
  let reads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => { reads++; return combined(o.nowMs, reads); },
    readGeneration: async () => generation,
    validUntil: async o => o.nowMs + 1000,
  });
  const read = async end => selectSharedWorkUsageSnapshot(await reader({ ...options(end), exactWindow: true }), { period: 'all', scope: 'account-a' });
  assert.equal((await read(100)).toMs, 100);
  assert.equal((await read(100)).toMs, 100);
  assert.equal(reads, 2);
  assert.equal((await read(101)).toMs, 101);
  assert.equal(reads, 3);
  assert.equal((await read(100)).toMs, 100);
  assert.equal(reads, 4);
});

test("identical exact-window work reads coalesce only while the build is in flight", async () => {
  const gate = latch();
  let reads = 0;
  const reader = createCachedLocalUnifiedProjectionReader({
    reader: async o => { reads++; await gate.promise; return combined(o.nowMs, reads); },
    readGeneration: async () => generation,
    validUntil: async o => o.nowMs + 1000,
  });
  const exact = () => ({ ...options(100), exactWindow: true });
  const first = reader(exact());
  const second = reader(exact());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.workUsage.asOfMs, b.workUsage.asOfMs], [100, 100]);
  assert.equal(reads, 1);

  const afterCompletion = await reader(exact());
  assert.equal(afterCompletion.workUsage.asOfMs, 100);
  assert.equal(reads, 2, "settled work is not reused, even for the same exact anchor");
});

test("warming every period rebuilds work usage but preserves selected and exact snapshot identities", async () => {
  let reads = 0;
  const now = 40 * 86400000;
  const cached = createCachedLocalUnifiedProjectionReader({
    readGeneration: async () => generation,
    validUntil: async o => o.nowMs + 1,
    reader: async o => { reads++; return combined(o.nowMs); },
  });
  const service = createWorkUsageService({ clock: () => now,
    build: async (q, controls) => selectSharedWorkUsageSnapshot(await cached(options(q.toMs), controls), q),
  });
  const query = q => service.query({ schemaVersion: WORK_USAGE_SCHEMA, ...q });
  async function ready(q) {
    const pending = await query(q);
    await new Promise(resolve => setImmediate(resolve));
    return query({ period: q.period, snapshotId: pending.snapshotId });
  }
  try {
    const selected = await ready({ period: "7d" });
    let expectedReads = 1;
    let previous = null;
    for (const period of ["24h", "30d", "all"]) {
      const warmed = await ready({ period, sourceSnapshotId: selected.snapshotId });
      expectedReads++;
      assert.equal(warmed.status, "available");
      assert.equal(warmed.toMs, selected.toMs);
      assert.equal(reads, expectedReads, "each work-usage projection is freshly built");
      assert.equal((await query({ period: "7d", snapshotId: selected.snapshotId })).status, "available");
      if (previous) await assert.rejects(query({ period: previous.period, snapshotId: previous.id }),
        { code: "work_usage_snapshot_expired" });
      previous = { period, id: warmed.snapshotId };
    }
  } finally { service.close(); await cached.close(); }
});
