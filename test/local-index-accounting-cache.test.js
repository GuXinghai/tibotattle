import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { addUsdStrings, priceCodexUsageEvent } from "@app-usagemonitor/accounting";

import {
  buildLocalIndexAccountingCache,
  createLocalIndexAccountingScan,
  localIndexCalibrationSource,
  refreshLocalIndexAccountingCache,
} from "../src/local-index-accounting-cache.js";
import { rebuildRollups } from "../src/local-index-rollup.js";
import { describeLocalIndexGeneration, readLocalIndexCompanionProjection } from "../src/local-index-companion-source.js";
import { readLocalIndexReport, readLocalIndexReportMetadata } from "../src/local-index-report.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import {
  assertReplaySafeAccountingCache,
  buildReplaySafeAccountingCache,
  readReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const END_MS = Date.parse("2026-09-01T00:00:00.000Z");

test("stage observers preserve the entire accounting cache and report the deep build boundaries", async t => {
  const workspace = createWorkspace({ files: 3, events: 600, days: 35 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "timed-accounting.sqlite");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile, secretFile: workspace.secretFile, workerCount: 1 });
  const generation = (await readLocalIndexCompanionProjection({ indexFile, nowMs: END_MS })).generation;
  const options = { indexFile, codexHome: workspace.codexHome, expectedGeneration: generation, now: () => END_MS };
  const reference = await buildLocalIndexAccountingCache(options);
  const spans = [];
  let monotonic = 0;
  const measured = await buildLocalIndexAccountingCache({ ...options,
    monotonicClock: () => ++monotonic, onTiming: event => { spans.push(event); throw new Error("synthetic observer failure"); } });
  assert.deepEqual(measured, reference);
  assert.deepEqual(spans.map(row => row.stage), ["accounting_scan", "accounting_corpus_open", "accounting_fit",
    "accounting_weekly_origins", "accounting_weekly_intervals", "accounting_transitions", "accounting_corpus_finish", "accounting_finalize"]);
  assert.ok(spans.every(row => row.wallMs === 1 && row.outcome === "completed"));
});

test("accounting metadata matches the full report across future, zero, provisional and empty evidence", async t => {
  const workspace = createWorkspace({ files: 3, events: 200, days: 40 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "metadata.sqlite");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
    secretFile: workspace.secretFile, workerCount: 1 });
  const database = new DatabaseSync(indexFile);
  try {
    const rows = database.prepare("SELECT event_key FROM usage_event ORDER BY observed_at_ms LIMIT 6").all();
    for (const [index, at] of [END_MS + 300_000, END_MS + 300_001,
      END_MS - 90 * 86400_000, END_MS + 60 * 86400_000].entries()) {
      database.prepare("UPDATE usage_event SET observed_at_ms=? WHERE event_key=?").run(at, rows[index].event_key);
    }
    for (const [index, value] of [null, 0].entries()) {
      database.prepare(`UPDATE usage_event SET tokens_in_uncached=?,tokens_in_cache_read=?,
        tokens_in_cache_write=?,tokens_out_text=?,tokens_out_reasoning=?,tokens_out_combined=?
        WHERE event_key=?`).run(value, value, value, value, value, value, rows[4 + index].event_key);
    }
    rebuildRollups(database);
    const clocks = [END_MS, END_MS + 1, END_MS - 90 * 86400_000, END_MS + 60 * 86400_000];
    assert.deepEqual(readLocalIndexReportMetadata(database, { nowMs: END_MS }).coveredAt, {
      startAt: new Date(END_MS - 90 * 86400_000).toISOString(),
      endAt: new Date(END_MS + 300_000).toISOString(),
    });
    assert.equal(readLocalIndexReportMetadata(database, { nowMs: END_MS + 1 }).coveredAt.endAt,
      new Date(END_MS + 300_001).toISOString());
    const check = () => {
      for (const nowMs of clocks) {
        const report = readLocalIndexReport(database, { nowMs });
        const metadata = readLocalIndexReportMetadata(database, { nowMs });
        assert.deepEqual(metadata, Object.fromEntries(Object.keys(metadata).map(key => [key, report[key]])));
        const seq = Number(database.prepare("SELECT commit_seq FROM store_state").get().commit_seq);
        assert.deepEqual(describeLocalIndexGeneration(database, metadata, seq),
          describeLocalIndexGeneration(database, report, seq));
      }
    };
    check();
    database.exec("UPDATE source SET scanned_bytes=0 WHERE id=(SELECT MIN(id) FROM source)");
    check();
    database.exec(`INSERT INTO source_diagnostic(source_id,code,count)
      VALUES ((SELECT MIN(id) FROM source),'toolRecordsSkipped',1)
      ON CONFLICT(source_id,code) DO UPDATE SET count=1`);
    check();
    assert.equal(readLocalIndexReportMetadata(database, { nowMs: END_MS }).toolCoverageStatus, "partial");
    database.exec("DELETE FROM usage_event");
    rebuildRollups(database);
    check();
    assert.deepEqual(readLocalIndexReportMetadata(database, { nowMs: END_MS }).coveredAt,
      { startAt: null, endAt: null });
    assert.equal(readLocalIndexReportMetadata(database, { nowMs: END_MS }).usageEvents, 0);
    assert.throws(() => readLocalIndexReportMetadata(database, { nowMs: NaN }), /finite epoch/);
    database.exec("INSERT INTO rollup_context_start(start_tokens) VALUES(987654321)");
    assert.throws(() => readLocalIndexReportMetadata(database, { nowMs: END_MS }), { code: "local_index_rollup_basis_stale" });
    assert.throws(() => readLocalIndexReport(database, { nowMs: END_MS }), { code: "local_index_rollup_basis_stale" });
  } finally { database.close(); }
});
const NOW_MS = END_MS + 3_600_000;

test("v2 accounting preserves nullable components, output conflicts and provenance coverage", async () => {
  const workspace = createWorkspace({ files: 1, events: 100, days: 1 });
  const cases = [
    { name: "observed-zero", values: [0, 0, 0, 1_000, 0, null], context: null, flags: 0, status: "fully_priced" },
    { name: "missing-input-context", values: [null, 10_000, 0, 1_000, 0, null], context: null, flags: 0, status: "unpriced" },
    { name: "missing-input-known-context", values: [null, 10_000, 0, 1_000, 0, null], context: 300_000, flags: 0, status: "partially_priced" },
    { name: "combined-only", values: [10_000, 0, 0, null, null, 1_000], context: 10_000, flags: 0, status: "fully_priced" },
    { name: "missing-output", values: [10_000, 0, 0, null, null, null], context: 10_000, flags: 0, status: "partially_priced" },
    { name: "partial-flag", values: [10_000, 0, 0, 1_000, 0, null], context: 10_000, flags: 1, status: "partially_priced" },
    { name: "assumed-cache-write", values: [10_000, 0, 0, 1_000, 0, null], context: 10_000, flags: 4, status: "partially_priced" },
    { name: "output-conflict", values: [10_000, 0, 0, 1_000, 0, 1_001], context: 10_000, flags: 0, status: "partially_priced" },
  ];
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile, secretFile: workspace.secretFile, workerCount: 1 });
    const database = new DatabaseSync(indexFile);
    try {
      database.exec("INSERT OR IGNORE INTO model(model_id, recognition) VALUES ('gpt-5.5', 'recognized')");
      database.exec(`UPDATE usage_event SET flags = 0, total_input_context = NULL,
        tokens_in_uncached = 0, tokens_in_cache_read = 0, tokens_in_cache_write = 0,
        tokens_out_text = 0, tokens_out_reasoning = 0, tokens_out_combined = NULL,
        model_id = (SELECT id FROM model WHERE model_id = 'gpt-5.5')`);
      const keys = database.prepare("SELECT event_key, observed_at_ms FROM usage_event ORDER BY observed_at_ms, event_key LIMIT ?").all(cases.length + 1);
      const update = database.prepare(`UPDATE usage_event SET
        tokens_in_uncached = ?, tokens_in_cache_read = ?, tokens_in_cache_write = ?,
        tokens_out_text = ?, tokens_out_reasoning = ?, tokens_out_combined = ?,
        total_input_context = ?, flags = ?, observed_at_ms = ? WHERE event_key = ?`);
      for (const [i, fixture] of cases.entries()) {
        fixture.timestamp = new Date(Number(keys[i].observed_at_ms)).toISOString();
        update.run(...fixture.values, fixture.context, fixture.flags, Date.parse(fixture.timestamp), keys[i].event_key);
      }
      // A status-only observation has no spend. Unknown quantities stay NULL
      // and do not create either a priced event or a zero-cost usage event.
      update.run(null, null, null, null, null, null, null, 8, keys.at(-1).observed_at_ms, keys.at(-1).event_key);
      rebuildRollups(database);
    } finally { database.close(); }

    const rows = [];
    await createLocalIndexAccountingScan({ indexFile })({ startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-02T00:00:00.000Z", onUsage: row => { rows.push(row); } });
    assert.equal(rows.length, cases.length);
    assert.equal(rows[0].components.input_uncached_tokens, 0);
    assert.equal(rows[0].componentAvailability.input_uncached_tokens, true);
    assert.equal(rows[1].components.input_uncached_tokens, null);
    assert.equal(rows[1].componentAvailability.input_uncached_tokens, false);
    assert.equal(rows[3].components.output_text_tokens, null);
    assert.equal(rows[3].components.output_combined_tokens, 1_000);
    assert.equal(rows[5].pricingEvidenceIncomplete, true);
    assert.equal(rows[6].components.input_cache_write_tokens, 0);
    assert.equal(rows[6].componentAvailability.input_cache_write_tokens, false);
    assert.equal(rows[7].components.output_combined_tokens, null);
    assert.equal(rows[7].pricingEvidenceIncomplete, true);

    const generation = (await readLocalIndexCompanionProjection({ indexFile, nowMs: NOW_MS })).generation;
    const cache = await buildLocalIndexAccountingCache({ indexFile,
      expectedGeneration: { id: generation.id, fingerprint: generation.fingerprint }, now: () => NOW_MS });
    assertReplaySafeAccountingCache(cache);
    const period = cache.periods.find(row => row.id === "all");
    assert.deepEqual(period.pricingCoverage, { fullyPricedEvents: 2, partiallyPricedEvents: 5, unpricedEvents: 1 });
    assert.deepEqual(cache.history.period.pricingCoverage, period.pricingCoverage);
    assert.deepEqual(period.byModel[0].pricingCoverage, period.pricingCoverage);
    let expectedTotal = "0";
    const names = ["input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens", "output_reasoning_tokens", "output_combined_tokens"];
    for (const fixture of cases) {
      const components = Object.fromEntries(names.map((name, i) => [name, fixture.values[i]]));
      delete components.output_combined_tokens;
      if (fixture.name === "combined-only") { components.output_text_tokens = 1_000; components.output_reasoning_tokens = 0; }
      if (fixture.name === "assumed-cache-write") components.input_cache_write_tokens = null;
      const expected = priceCodexUsageEvent({ timestamp: fixture.timestamp, model: "gpt-5.5", components,
        ...(fixture.context === null ? {} : { totalInputContextTokens: fixture.context }) });
      if (!["partial-flag", "output-conflict"].includes(fixture.name)) assert.equal(expected.coverageStatus, fixture.status, fixture.name);
      expectedTotal = addUsdStrings(expectedTotal, expected.totalUsd);
    }
    assert.equal(period.apiPriceEquivalentUsdExact, expectedTotal);
    assert.equal(cache.history.period.apiPriceEquivalentUsdExact, expectedTotal);
    assert.equal(period.byModel[0].apiPriceEquivalentUsd, Number(expectedTotal));
    assert.equal(period.componentCosts.output_combined_tokens.tokens, 1_000);
    assert.equal(cache.timeline.reduce((n, row) => n + row.usageEvents, 0), cases.length);
  } finally { workspace.cleanup(); }
});

test("v2 context preserves unknown and observed zero while refusing legacy zero substitution", async () => {
  assert.throws(() => createLocalIndexAccountingScan({ indexFile: "synthetic.sqlite", contextBehavior: "legacy_zero" }), /source_native/);
  const workspace = createWorkspace({ files: 1, events: 4, days: 1 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile, secretFile: workspace.secretFile, workerCount: 1 });
    const database = new DatabaseSync(indexFile);
    try {
      database.exec("UPDATE usage_event SET total_input_context = NULL");
      database.exec("UPDATE usage_event SET total_input_context = 0 WHERE event_key = (SELECT event_key FROM usage_event ORDER BY event_key LIMIT 1)");
      rebuildRollups(database);
    } finally { database.close(); }
    const rows = [];
    await createLocalIndexAccountingScan({ indexFile })({ startAt: "2026-08-01T00:00:00.000Z", endAt: "2026-09-02T00:00:00.000Z", onUsage: row => { rows.push(row); } });
    assert.ok(rows.some(row => row.totalInputContextTokens === 0));
    assert.ok(rows.some(row => !Object.hasOwn(row, "totalInputContextTokens")));
    assert.equal(rows.filter(row => row.totalInputContextTokens === 0).length, 1);
  } finally { workspace.cleanup(); }
});

test("the v2 cache is bound to the generation the companion projection names", async () => {
  const workspace = createWorkspace({ variety: true, files: 24, events: 900, days: 8, seed: 31 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const g2 = (await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs: NOW_MS })).generation;
    const actual = await buildLocalIndexAccountingCache({
      indexFile: v2File,
      expectedGeneration: { id: g2.id, fingerprint: g2.fingerprint },
      now: () => NOW_MS,
    });
    assertReplaySafeAccountingCache(actual);

    assert.equal(actual.sourceDescriptor.mode, "unified");
    assert.equal(actual.sourceDescriptor.generation, String(g2.id));
    assert.equal(actual.sourceDescriptor.generationFingerprint, g2.fingerprint);
    assert.equal(actual.history.status, "available");
    assert.equal(actual.periods.length, 4);
    assert.ok(actual.history.period.byModel.length > 0, "the history period holds events");
    assert.equal(actual.weeklyCalibrationInput.source, "unified_index");
  } finally {
    workspace.cleanup();
  }
});

test("a store that committed since the generation was read fails closed", async () => {
  const workspace = createWorkspace({ files: 10, events: 300, days: 5, seed: 32 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const before = (await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs: NOW_MS })).generation;
    appendSyntheticCodexEvents(workspace.receipt.sources.slice(0, 2), {
      seed: 9, events: 3, fillerBytesPerEvent: 100, atMs: Date.parse("2026-09-02T00:00:00Z"),
    });
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    await assert.rejects(
      buildLocalIndexAccountingCache({
        indexFile: v2File,
        expectedGeneration: { id: before.id, fingerprint: before.fingerprint },
        now: () => NOW_MS,
      }),
      (error) => error.code === "accounting_unified_generation_mismatch",
    );
    const after = (await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs: NOW_MS })).generation;
    const cache = await buildLocalIndexAccountingCache({
      indexFile: v2File,
      expectedGeneration: { id: after.id, fingerprint: after.fingerprint },
      now: () => NOW_MS,
    });
    assert.equal(cache.sourceDescriptor.generation, String(after.id));
  } finally {
    workspace.cleanup();
  }
});

test("the published cache is readable only against the generation it was built for", async () => {
  const workspace = createWorkspace({ files: 10, events: 300, days: 5, seed: 33 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    const stateFile = join(workspace.state, "collector.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const generation = (await readLocalIndexCompanionProjection({
      indexFile: v2File, nowMs: NOW_MS,
    })).generation;
    const expectedGeneration = { id: generation.id, fingerprint: generation.fingerprint };
    const published = await refreshLocalIndexAccountingCache({
      stateFile, indexFile: v2File, expectedGeneration, now: () => NOW_MS,
    });
    assert.equal(published.sourceDescriptor.generation, String(generation.id));

    const read = await readReplaySafeAccountingCache({
      stateFile, sourceMode: "unified", expectedGeneration,
    });
    assert.equal(read.status, "available");
    assert.deepEqual(read.cache.periods, published.periods);

    const stale = await readReplaySafeAccountingCache({
      stateFile,
      sourceMode: "unified",
      expectedGeneration: { id: generation.id + 1, fingerprint: generation.fingerprint },
    });
    assert.notEqual(stale.status, "available");
  } finally {
    workspace.cleanup();
  }
});


test("weighted accounting scan preserves canonical cache output and exact boundary evidence", async () => {
  const workspace = createWorkspace({ files: 1, events: 120, days: 1 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
      secretFile: workspace.secretFile, workerCount: 1 });
    const database = new DatabaseSync(indexFile);
    const base = Date.parse("2026-08-31T12:00:00.000Z");
    try {
      // Multiple events per identical key prove this exercises aggregation.
      // Separate buckets carry mixtures the v1 key cannot safely distinguish.
      database.exec(`UPDATE usage_event SET flags = 0, total_input_context = 10000,
        tokens_in_uncached = 10001, tokens_in_cache_read = 1003, tokens_in_cache_write = 0,
        tokens_out_text = 7, tokens_out_reasoning = 3, tokens_out_combined = NULL`);
      const rows = database.prepare("SELECT event_key FROM usage_event ORDER BY event_key").all();
      const update = database.prepare(`UPDATE usage_event SET observed_at_ms = ?, flags = ?,
        total_input_context = ?, tokens_in_uncached = ?, tokens_out_combined = ? WHERE event_key = ?`);
      for (const [i, row] of rows.entries()) {
        const bucket = Math.floor(i / 13);
        update.run(base + bucket * 900000 + (i % 13) * 1000,
          bucket === 2 && i % 2 ? 1 : bucket === 3 && i % 2 ? 4 : 0,
          bucket === 4 ? 300000 : bucket === 5 ? null : 10001,
          bucket === 5 && i % 2 ? null : 10001,
          bucket === 6 && i % 2 ? 1101 : null, row.event_key);
      }
      rebuildRollups(database);
    } finally { database.close(); }
    const baselineAt = base + 900000 + 4500;
    const declaredSpeedBaselines = [{ mode: "fast", firstSeenAt: new Date(baselineAt).toISOString(),
      lastSeenAt: new Date(baselineAt + 2000).toISOString() }];
    const scan = createLocalIndexAccountingScan({ indexFile });
    const exactRows = [];
    const groups = [];
    const request = { startAt: new Date(base - 1).toISOString(), endAt: new Date(NOW_MS).toISOString(),
      declaredSpeedBaselines };
    await scan({ ...request, onUsage: row => { exactRows.push(row); } });
    await scan({ ...request, onUsageGroup: row => { groups.push(row); } });
    assert.ok(groups.length < exactRows.length, "whole safe buckets reduce physical projections");
    assert.equal(groups.reduce((n, row) => n + (row.eventCount ?? 1), 0), exactRows.length);
    for (const bucket of [1, 2, 3, 6]) {
      const rows = groups.filter(row => row.timestampMs >= base + bucket * 900000
        && row.timestampMs < base + (bucket + 1) * 900000);
      assert.equal(rows.length, 13, `bucket ${bucket} keeps exact events`);
      assert.ok(rows.every(row => row.eventCount === undefined));
    }
    const generation = (await readLocalIndexCompanionProjection({ indexFile, nowMs: NOW_MS })).generation;
    const options = { sourceMode: "unified", expectedGeneration: generation,
      now: () => NOW_MS, codexHome: workspace.codexHome,
      declaredSpeedBaselines, calibrationSource: localIndexCalibrationSource({ indexFile }) };
    const reference = await buildReplaySafeAccountingCache({ ...options,
      scan: ({ onUsageGroup: _group, indexedHistory, ...request }) => scan({ ...request,
        indexedHistory: indexedHistory === undefined ? undefined : { onUsage: indexedHistory.onUsage } }) });
    let weightedRows = 0;
    const actual = await buildReplaySafeAccountingCache({ ...options,
      scan: request => scan({ ...request, onUsageGroup: row => {
        if (row.eventCount > 1) weightedRows += 1;
        return request.onUsageGroup(row);
      } }),
    });
    assert.ok(weightedRows > 0, "canonical cache builder consumes weighted groups");
    assert.deepEqual(actual.periods, reference.periods);
    assert.deepEqual(actual.history, reference.history);
    assert.deepEqual(actual.timeline, reference.timeline);
    assert.deepEqual(actual.sparkTimeline, reference.sparkTimeline);

    const controller = new AbortController();
    let delivered = 0;
    await assert.rejects(scan({ ...request, signal: controller.signal, onUsageGroup: () => {
      delivered += 1;
      controller.abort();
    } }), error => error.code === "accounting_refresh_aborted");
    assert.equal(delivered, 1, "cancellation stops delivery before the next group");
    const callbackFailure = new Error("synthetic callback failure");
    await assert.rejects(scan({ ...request, onUsageGroup: () => { throw callbackFailure; } }),
      error => error === callbackFailure);
    const recovered = [];
    await scan({ ...request, onUsageGroup: row => { recovered.push(row); } });
    assert.equal(recovered.length, groups.length, "failed readers leave the committed facts reusable");
  } finally { workspace.cleanup(); }
});
