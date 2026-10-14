import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { localCodexLogScanner } from "../src/local-node-runtime.js";
import { extractRolloutUsage } from "../src/local-index-extract.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION, isLocalUnifiedIndexBoundaryParserVersion } from "../src/codex-usage-vocabulary.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { countRows, refreshCodexHome, withReadOnlyStore } from "./helpers/local-index-rollout-store.js";
import { usageProjection } from "../src/local-companion-usage-model.js";
import { cumulativeSnapshotKey, normalizeTokenUsage } from "../src/providers/codex/logs.js";

const stamp = (second) => `2026-09-03T12:00:${String(second).padStart(2, "0")}.000Z`;
const vector = (input, cached = 0) => ({ input_tokens: input, cached_input_tokens: cached,
  cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0,
  total_tokens: input + 10 });
const line = (second, type, payload, extra = {}) => JSON.stringify({ timestamp: stamp(second), type, payload, ...extra });
const count = (second, total, last) => line(second, "event_msg", { type: "token_count",
  info: { total_token_usage: total, last_token_usage: last } });
const header = [line(0, "session_meta", { id: "synthetic-compatibility" }),
  line(0, "turn_context", { model: "gpt-6-astra", effort: "low" })];

async function fixture(lines) {
  const root = await mkdtemp(join(tmpdir(), "codex-usage-compatibility-"));
  await mkdir(join(root, "sessions"));
  const path = join(root, "sessions", "rollout-2026-09-03T12-00-00-compatibility.jsonl");
  await writeFile(path, `${[...header, ...lines].join("\n")}\n`);
  return { root, path };
}

// The v2 store's parser label for a source last reparsed at `revision`.
const parserAt = (revision) => `local-index-rollout-typed-v1+unified-rollout-typed-v` + revision;

function rows(file) {
  return withReadOnlyStore(file, (database) => database.prepare(`SELECT tokens_in_uncached, tokens_in_cache_read,
    tokens_in_cache_write, tokens_out_text, tokens_out_reasoning
    FROM usage_event ORDER BY observed_at_ms`).all().map((row) => ({ ...row })));
}

// The stored usage facts in the shape the assertions below read: exact totals
// and components, with missing evidence kept as null.
function uploadedUsage(file) {
  return withReadOnlyStore(file, (database) => database.prepare(`SELECT total_input_context, tokens_in_uncached,
    tokens_in_cache_write, tokens_out_text, tokens_out_combined
    FROM usage_event ORDER BY observed_at_ms, event_key`).all().map((row) => ({
    totalInputContextTokens: row.total_input_context,
    components: {
      inputUncachedTokens: row.tokens_in_uncached,
      inputCacheWriteTokens: row.tokens_in_cache_write,
      outputTextTokens: row.tokens_out_text,
      outputCombinedTokens: row.tokens_out_combined,
    },
  })));
}

// Rewrites a store the way an older reparse left it: derived columns and the
// source's parser label. Only tests write through this handle.
function rewriteStore(file, statements) {
  const database = openLocalIndexStore(file);
  try { for (const statement of statements) database.exec(statement); } finally { database.close(); }
}

test("exact selected totals survive serial, worker, incremental and replayed refresh without duplicate output", async () => {
  const first = { ...vector(100, 60), cache_write_input_tokens: 20, reasoning_output_tokens: 4 };
  const second = { ...vector(250, 160), cache_write_input_tokens: 40,
    output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 280 };
  const value = await fixture([count(1, first, first)]);
  const incremental = join(value.root, "incremental.sqlite");
  try {
    await refreshCodexHome(value.root, { indexFile: incremental });
    // No last sample: the second selected usage must be the cumulative delta,
    // never the whole cumulative context or a reconstructed split sum.
    await appendFile(value.path, `${count(2, second, null)}\n`);
    await refreshCodexHome(value.root, { indexFile: incremental });
    const expected = uploadedUsage(incremental);
    assert.equal(expected.length, 2);
    assert.deepEqual(expected.map((event) => event.totalInputContextTokens), [100, 150]);
    assert.deepEqual(expected.map((event) => event.components.outputCombinedTokens), [10, 20]);
    assert.deepEqual(expected.map((event) => event.components.inputCacheWriteTokens), [20, 20]);
    const event = expected[0];
    const projected = { observedAt: stamp(1), model: "gpt-6-astra",
      totalInputContextTokens: event.totalInputContextTokens,
      components: { input_uncached_tokens: 20, input_cache_read_tokens: 60, input_cache_write_tokens: 20,
        output_text_tokens: 6, output_reasoning_tokens: 4, output_combined_tokens: 10 } };
    assert.deepEqual(usageProjection(projected), usageProjection({ ...projected,
      components: { ...projected.components, output_combined_tokens: 0 } }),
    "complete splits and their combined alias produce the same token and price totals");

    for (const workerCount of [1, 2]) {
      const indexFile = join(value.root, `full-${workerCount}.sqlite`);
      await refreshCodexHome(value.root, { indexFile, workerCount });
      assert.deepEqual(uploadedUsage(indexFile), expected);
    }
    await refreshCodexHome(value.root, { indexFile: incremental });
    assert.deepEqual(uploadedUsage(incremental), expected, "replay cannot add the combined alias twice");

    rewriteStore(incremental, [
      "UPDATE usage_event SET total_input_context=NULL, tokens_out_combined=NULL",
      `UPDATE source SET parser_version='${parserAt(15)}'`,
    ]);
    const refreshed = await refreshCodexHome(value.root, { indexFile: incremental });
    assert.equal(refreshed.sourcesRescanned, 1);
    assert.deepEqual(uploadedUsage(incremental), expected, "present v15 sources regain exact totals with stable event IDs");
  } finally { await rm(value.root, { recursive: true }); }
});

test("raw totals stay independent of missing splits and contradictory evidence is withheld", async () => {
  const samples = [
    { input_tokens: 100, output_tokens: 10 },
    // Output-only usage is still a selected token-count record, but it does
    // not create a positive-input boundary relation.
    { input_tokens: 0, output_tokens: 10, total_tokens: 10 },
    { total_tokens: 110 },
    { input_tokens: 100, cached_input_tokens: 120, output_tokens: 10, reasoning_output_tokens: 12 },
    { input_tokens: 100, cache_write_input_tokens: 101, output_tokens: 10 },
    { input_tokens: 100, cached_input_tokens: 90, cache_write_input_tokens: 20, output_tokens: 10 },
    { input_tokens: 100, output_tokens: 0, total_tokens: 100 },
  ];
  const value = await fixture(samples.map((sample, index) => count(index + 1, null, sample)));
  try {
    const indexFile = join(value.root, "index.sqlite");
    await refreshCodexHome(value.root, { indexFile, workerCount: 2 });
    const events = uploadedUsage(indexFile);
    // The total-only snapshot is not a usage row because it has no selected
    // input/output fields. The output-only row remains a fact, while the
    // continuity lens accepts positive-input requests only. The retained rows
    // prove that exact totals survive missing or contradictory components.
    assert.deepEqual(events.map((event) => [event.totalInputContextTokens, event.components.outputCombinedTokens]),
      [[100, 10], [0, 10], [null, null], [null, 10], [null, 10], [100, 0]]);
    assert.ok(events.every((event) => event.components.inputUncachedTokens === null));
    assert.ok(events.every((event) => event.components.outputTextTokens === null));
    assert.equal(events[0].components.inputCacheWriteTokens, null);
  } finally { await rm(value.root, { recursive: true }); }
});

test("rotated v15 sources preserve their recorded null totals and provenance", async () => {
  const value = await fixture([count(1, vector(100), vector(100))]);
  const indexFile = join(value.root, "index.sqlite");
  try {
    await refreshCodexHome(value.root, { indexFile });
    rewriteStore(indexFile, [
      "UPDATE usage_event SET total_input_context=NULL, tokens_out_combined=NULL",
      `UPDATE source SET parser_version='${parserAt(15)}'`,
    ]);
    await rm(value.path);
    const refreshed = await refreshCodexHome(value.root, { indexFile });
    // The vanished source keeps its facts and its recorded label; nothing reparses.
    assert.equal(refreshed.sourcesRescanned, 0);
    assert.equal(refreshed.sourcesAbsent, 1);
    const events = uploadedUsage(indexFile);
    assert.equal(events.length, 1);
    assert.equal(events[0].totalInputContextTokens, null);
    assert.equal(events[0].components.outputCombinedTokens, null);
    assert.equal(withReadOnlyStore(indexFile, (retained) => retained
      .prepare("SELECT parser_version FROM source").get().parser_version), parserAt(15));
  } finally { await rm(value.root, { recursive: true }); }
});

test("missing cache components remain null; explicit zero remains observed across full, worker and incremental indexing", async () => {
  const sparse = { input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 };
  const first = count(1, sparse, sparse);
  const second = count(2, { ...vector(200), output_tokens: 20, total_tokens: 220 }, vector(100));
  const value = await fixture([first]);
  const incremental = join(value.root, "incremental.sqlite");
  try {
    await refreshCodexHome(value.root, { indexFile: incremental });
    withReadOnlyStore(incremental, (cursorDb) => {
      assert.equal(cursorDb.prepare("SELECT carry_total_cached FROM source").get().carry_total_cached, null);
      assert.equal(cursorDb.prepare("SELECT carry_total_cache_write FROM source").get().carry_total_cache_write, null);
    });
    await appendFile(value.path, `${second}\n`);
    await refreshCodexHome(value.root, { indexFile: incremental });
    const expected = [
      { tokens_in_uncached: null, tokens_in_cache_read: null, tokens_in_cache_write: null, tokens_out_text: 10, tokens_out_reasoning: 0 },
      { tokens_in_uncached: 100, tokens_in_cache_read: 0, tokens_in_cache_write: 0, tokens_out_text: 10, tokens_out_reasoning: 0 },
    ];
    assert.deepEqual(rows(incremental), expected);
    for (const workerCount of [1, 2]) {
      const indexFile = join(value.root, `full-${workerCount}.sqlite`);
      await refreshCodexHome(value.root, { indexFile, workerCount });
      assert.deepEqual(rows(indexFile), expected);
    }
    await refreshCodexHome(value.root, { indexFile: incremental });
    assert.deepEqual(rows(incremental), expected, "replay is unchanged");

    // Reproduce the old zero-filled derived cache, then verify parser reparse
    // replaces only this derived evidence without deleting the database.
    rewriteStore(incremental, [
      "UPDATE usage_event SET tokens_in_uncached=100, tokens_in_cache_read=0, tokens_in_cache_write=0",
      `UPDATE source SET parser_version='${parserAt(11)}'`,
    ]);
    const refreshed = await refreshCodexHome(value.root, { indexFile: incremental });
    assert.equal(refreshed.sourcesRescanned, 1);
    assert.deepEqual(rows(incremental), expected);
    assert.equal(LOCAL_UNIFIED_INDEX_PARSER_VERSION, "unified-rollout-typed-v19");
  } finally { await rm(value.root, { recursive: true }); }
});
test("unknown and inconsistent cache evidence stays null apart from the approved cache-write assumption", async () => {
  const bad = [
    { ...vector(100), cached_input_tokens: null },
    { ...vector(100), cache_write_input_tokens: null },
    { ...vector(100, 90), cache_write_input_tokens: 20 },
  ];
  const value = await fixture([...bad.map((usage, index) => count(index + 1, null, usage)),
    count(4, null, {}), count(5, null, { input_tokens: null, output_tokens: null })]);
  try {
    const events = [];
    await extractRolloutUsage(value.path, { size: (await stat(value.path)).size, onEvent: (event) => events.push(event) });
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.components.inputUncachedTokens), [null, 100, null]);
    assert.equal(events[0].components.inputCacheReadTokens, null);
    assert.equal(events[1].components.inputCacheWriteTokens, 0);
    assert.deepEqual(events.map((event) => event.cacheWriteAssumedZero === true), [false, true, false]);
    assert.equal(events[2].components.inputCacheReadTokens, null);
    // The raw provider adapter retains missingness; the typed index records
    // the product assumption explicitly after selecting the charged usage.
    const provider = [];
    await localCodexLogScanner.scanCodexLogEvents({ codexHome: value.root, startAt: stamp(0), endAt: stamp(59), onUsage: (event) => provider.push(event) });
    assert.equal(provider.length, 3);
    assert.equal(provider.every((event) => event.componentAvailability.input_uncached_tokens === false), true);
  } finally { await rm(value.root, { recursive: true }); }
});

test("nullable evidence retains legacy lineage snapshot identity for rotated parents", async () => {
  const sparse = { input_tokens: 100, total_tokens: 100 };
  const value = await fixture([count(1, sparse, sparse)]);
  try {
    const snapshots = new Set();
    const collected = [];
    await extractRolloutUsage(value.path, { size: (await stat(value.path)).size,
      collectSnapshots: snapshots, onEvent: (event) => collected.push(event) });
    const legacy = cumulativeSnapshotKey(normalizeTokenUsage(sparse), normalizeTokenUsage(sparse));
    assert.deepEqual([...snapshots], [legacy]);
    assert.equal(collected[0].components.inputCacheReadTokens, null);
    const replay = [];
    const outcome = await extractRolloutUsage(value.path, { size: (await stat(value.path)).size,
      isFork: true, inheritedSnapshots: new Set([legacy]), onEvent: (event) => replay.push(event) });
    assert.deepEqual(replay, []);
    assert.equal(outcome.diagnostics.forkReplayEventsSkipped, 1);
  } finally { await rm(value.root, { recursive: true }); }
});

test("response totals/checkpoint copies are not additive usage and authored configuration is not applied effort evidence", async () => {
  // #41912 continues emitting legacy token_count. Response, turn and thread
  // totals overlap; a checkpoint copy is not a new response. Until a reviewed
  // response reconciliation contract exists, legacy rows remain authoritative.
  const response = { thread_id: "private-thread-canary", turn_id: "private-turn-canary",
    session_id: "private-root-canary", root_turn_id: "private-root-turn-canary", response_id: "private-response-canary",
    usage: vector(999), turn_token_usage: vector(1999), thread_token_usage: vector(2999) };
  const value = await fixture([
    line(1, "token_usage_record", response),
    line(2, "response_item", { type: "configuration_update", reasoning: { effort: "high" } },
      { metadata: { client_authored: false, harness_authored_configuration: true } }),
    line(3, "response_item", { type: "configuration_update", reasoning: { effort: "private-custom-canary" } }),
    count(4, vector(100, 80), vector(100, 80)),
    line(5, "compacted", { latest_token_usage_record: response }),
    line(6, "token_usage_record", response),
    count(7, { ...vector(200, 160), output_tokens: 20, total_tokens: 220 }, vector(100, 80)),
  ]);
  try {
    const extracted = [];
    await extractRolloutUsage(value.path, { size: (await stat(value.path)).size, onEvent: (event) => extracted.push(event) });
    assert.equal(extracted.length, 2);
    assert.deepEqual(extracted.map((event) => event.reasoningEffort), ["low", "low"]);
    assert.deepEqual(extracted.map((event) => event.components.inputCacheReadTokens), [80, 80]);
    assert.equal(JSON.stringify(extracted).includes("private-"), false);
    const provider = [];
    await localCodexLogScanner.scanCodexLogEvents({ codexHome: value.root, startAt: stamp(0), endAt: stamp(59), onUsage: (event) => provider.push(event) });
    assert.equal(provider.length, 2);
    assert.equal(provider.reduce((sum, event) => sum + event.raw.input_tokens, 0), 200);
    const onlyResponse = await fixture([line(1, "token_usage_record", response), line(2, "compacted", { latest_token_usage_record: response })]);
    try {
      const absent = [];
      await extractRolloutUsage(onlyResponse.path, { size: (await stat(onlyResponse.path)).size, onEvent: (event) => absent.push(event) });
      assert.deepEqual(absent, [], "unsupported response-only evidence is unavailable, not a fabricated zero event");
    } finally { await rm(onlyResponse.root, { recursive: true }); }
  } finally { await rm(value.root, { recursive: true }); }
});


test("thread and applied-turn tier evidence agrees across scanner, full and incremental index", async () => {
  const value = await fixture([
    line(0, "turn_context", { model: "gpt-6-astra", service_tier: "default" }),
    count(1, vector(100), vector(100)),
    line(2, "event_msg", { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } }),
    count(3, vector(200), vector(100)),
    line(4, "turn_context", { model: "gpt-6-astra", service_tier: "ultrafast" }),
    count(5, vector(300), vector(100)),
    line(6, "turn_context", { model: "gpt-6-astra", service_tier: null }),
    count(7, vector(400), vector(100)),
  ].map((record) => record.replaceAll("2026-09-03", "2026-09-29")));
  const expected = ["standard", "fast", "ultrafast", "unknown"];
  const readModes = (file) => withReadOnlyStore(file, (db) => db.prepare(`SELECT codex_speed_mode, tier_source FROM usage_event
    JOIN tier_semantics ON tier_semantics.id = usage_event.tier_id ORDER BY observed_at_ms`).all());
  try {
    const events = [];
    await localCodexLogScanner.scanCodexLogEvents({ codexHome: value.root,
      startAt: "2026-09-03T00:00:00.000Z", endAt: "2026-09-30T00:00:00.000Z",
      onUsage: (event) => events.push(event) });
    assert.deepEqual(events.map((event) => event.tierSemantics.codexSpeedMode), expected);
    for (const name of ["full", "incremental"]) {
      const indexFile = join(value.root, `${name}.sqlite`);
      await refreshCodexHome(value.root, { indexFile });
      const modes = readModes(indexFile);
      assert.deepEqual(modes.map((row) => row.codex_speed_mode), expected);
      assert.deepEqual(modes.map((row) => row.tier_source), ["turn_override", "rollout_thread_settings", "turn_override", "turn_override"]);
      await refreshCodexHome(value.root, { indexFile });
      assert.deepEqual(readModes(indexFile), modes);
      assert.equal(rows(indexFile).length, 4);
    }
  } finally { await rm(value.root, { recursive: true }); }
});
test("model catalog repair reparses retained Sol 6.1 sources once without changing token evidence", async () => {
  const selected = vector(100, 90);
  const value = await fixture([
    line(0, "turn_context", { model: "gpt-6.1-sol", effort: "low" }),
    count(1, selected, selected),
  ].map((record) => record.replaceAll("2026-09-03", "2026-09-29")));
  const indexFile = join(value.root, "index.sqlite");
  try {
    await refreshCodexHome(value.root, { indexFile });
    const initialTokens = rows(indexFile);
    // Reproduce the prior catalog's derived unknown model, preserving source
    // and occurrence identity. A price refresh alone cannot restore this id.
    rewriteStore(indexFile, [
      "INSERT OR IGNORE INTO model(model_id, recognition) VALUES ('unknown', 'unrecognized')",
      "UPDATE usage_event SET model_id = (SELECT id FROM model WHERE model_id = 'unknown')",
      `UPDATE source SET parser_version = '${parserAt(18)}'`,
    ]);
    const repaired = await refreshCodexHome(value.root, { indexFile });
    assert.equal(repaired.sourcesRescanned, 1);
    assert.deepEqual(rows(indexFile), initialTokens);
    withReadOnlyStore(indexFile, (current) => {
      assert.deepEqual({ ...current.prepare(`SELECT model.model_id, recognition FROM model
        JOIN usage_event ON usage_event.model_id = model.id`).get() }, {
        model_id: "gpt-6.1-sol", recognition: "recognized",
      });
    });
    const projected = usageProjection({ observedAt: "2026-09-29T12:00:01.000Z", model: "gpt-6.1-sol",
      totalInputContextTokens: 100, components: { input_uncached_tokens: 10, input_cache_read_tokens: 90,
        input_cache_write_tokens: 0, output_text_tokens: 10, output_reasoning_tokens: 0, output_combined_tokens: 10 } });
    assert.equal(projected.model, "gpt-6.1-sol");
    assert.equal(projected.apiPriceEquivalentUsd, 0.000129);
    const replay = await refreshCodexHome(value.root, { indexFile });
    assert.equal(replay.sourcesRescanned, 0);
    assert.equal(replay.unchanged, true);
    withReadOnlyStore(indexFile, (db) => assert.equal(countRows(db, "usage_event"), 1));
    assert.deepEqual(rows(indexFile), initialTokens);
  } finally { await rm(value.root, { recursive: true }); }
});
test("v19 keeps reviewed historical boundary provenance and refuses unqualified variants", () => {
  for (const version of [15, 16, 17, 18, 19]) {
    for (const suffix of ["", "-partial", "-parent-model", "-parent-model-partial"]) {
      const parser = `unified-rollout-typed-v${version}${suffix}`;
      assert.equal(isLocalUnifiedIndexBoundaryParserVersion(parser), true, parser);
      assert.equal(isLocalUnifiedIndexBoundaryParserVersion(`${parser}-cache-write-zero`),
        version >= 16, `${parser}-cache-write-zero`);
    }
  }
  for (const parser of [null, undefined, "", "unified-rollout-typed-v14",
    "unified-rollout-typed-v20", "unified-rollout-typed-v018",
    "unified-rollout-typed-v18-future", "unified-rollout-typed-v18 ",
    "unified-rollout-typed-v18-partial-parent-model"]) {
    assert.equal(isLocalUnifiedIndexBoundaryParserVersion(parser), false, String(parser));
  }
});
