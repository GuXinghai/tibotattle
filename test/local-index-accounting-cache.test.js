import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { addUsdStrings, priceCodexUsageEvent } from "@app-usagemonitor/accounting";

import {
  buildLocalIndexAccountingCache,
  createLocalIndexAccountingScan,
  refreshLocalIndexAccountingCache,
} from "../src/local-index-accounting-cache.js";
import { readLocalIndexCompanionProjection } from "../src/local-index-companion-source.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import {
  assertReplaySafeAccountingCache,
  readReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const END_MS = Date.parse("2026-09-01T00:00:00.000Z");
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
