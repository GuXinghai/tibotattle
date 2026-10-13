import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { assessLegacyIndexRetirement, readLegacyOrdinalMap } from "../src/local-index-cutover.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { generateSyntheticCodexCorpus } from "../src/synthetic-codex-rollout-corpus.js";

// The previous index is a file this build no longer writes. These tests lay
// down the tables the cutover reader inspects with plain DDL, using the source
// identities a v2 store assigns to the same rollouts.

function walkFiles(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) found.push(...walkFiles(path));
    else found.push(path);
  }
  return found;
}

function sourcesOf(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare(
      "SELECT source_local, source_ordinal FROM source ORDER BY source_ordinal",
    ).all().map((row) => ({
      sourceLocal: Buffer.from(row.source_local),
      ordinal: Number(row.source_ordinal),
    }));
  } finally {
    database.close();
  }
}

// `cursors` are [sourceLocal, ordinal]; `usage` are [sourceLocal, ordinal, events].
function writeLegacyIndex(file, { cursors = [], usage = [] }) {
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      CREATE TABLE source_cursor (source_local BLOB NOT NULL, source_ordinal INTEGER);
      CREATE TABLE usage_event (source_local BLOB NOT NULL, source_ordinal INTEGER);`);
    const cursor = database.prepare("INSERT INTO source_cursor VALUES (?, ?)");
    for (const [sourceLocal, ordinal] of cursors) cursor.run(sourceLocal, ordinal);
    const event = database.prepare("INSERT INTO usage_event VALUES (?, ?)");
    for (const [sourceLocal, ordinal, events] of usage) {
      for (let index = 0; index < events; index += 1) event.run(sourceLocal, ordinal);
    }
  } finally {
    database.close();
  }
}

// Quota identity as the hosted service hashes it: every input, with the
// source ordinal replaced by `ordinalOf` when one is given.
function quotaIdentity(file, ordinalOf = null) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = database.prepare(`
      SELECT hex(s.source_local) AS source, o.source_offset, o.slot_order,
             s.source_ordinal, o.observed_at_ms, o.limit_id, o.slot, o.used_percent,
             o.resets_at_ms, o.admission
      FROM quota_occurrence o JOIN source s ON s.id = o.source_id
      ORDER BY source, o.source_offset, o.slot_order`).all();
    return rows.map((row) => {
      const ordinal = ordinalOf === null ? row.source_ordinal : ordinalOf.get(row.source.toLowerCase());
      return JSON.stringify(Object.values({ ...row, source_ordinal: ordinal }));
    });
  } finally {
    database.close();
  }
}

test("a carried ordinal map keeps every hosted quota identity input byte-identical", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-index-cutover-"));
  try {
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    const codexHome = join(root, "codex-home");
    generateSyntheticCodexCorpus(codexHome, {
      seed: 11, files: 30, events: 900, days: 6, fillerBytesPerEvent: 120,
      endAt: "2026-09-01T00:00:00.000Z",
    });
    const secretFile = join(state, "local-unified-index-device-salt-v1");
    const reference = join(state, "reference.sqlite");
    await refreshLocalIndex({ codexHome, indexFile: reference, secretFile, workerCount: 1 });
    const sources = sourcesOf(reference);
    assert.ok(sources.length >= 30);

    // The previous index numbered sources in an order a rebuild does not
    // reproduce: rollouts that sort first arrived later. Reverse the ranks so
    // the carried ordinals differ from the sorted ones.
    const legacyOrdinal = new Map(sources.map((source, rank) => [
      Buffer.from(source.sourceLocal).toString("hex"), sources.length - 1 - rank,
    ]));
    const legacy = join(state, "legacy.sqlite");
    writeLegacyIndex(legacy, {
      cursors: sources.map((source) => [
        source.sourceLocal, legacyOrdinal.get(Buffer.from(source.sourceLocal).toString("hex")),
      ]),
    });
    const expectedQuota = quotaIdentity(reference, legacyOrdinal);
    assert.ok(expectedQuota.length > 100);

    const { ordinalSeed, summary } = readLegacyOrdinalMap(legacy);
    assert.equal(summary.conflictingSources, 0);
    assert.equal(summary.duplicatedOrdinals, 0);
    assert.equal(summary.sources, sources.length);

    const unseeded = join(state, "unseeded.sqlite");
    await refreshLocalIndex({ codexHome, indexFile: unseeded, secretFile, workerCount: 1 });
    assert.notDeepEqual(
      quotaIdentity(unseeded), expectedQuota,
      "without the map a rebuild changes ordinals, which is the hosted-identity hazard",
    );

    const seeded = join(state, "seeded.sqlite");
    const result = await refreshLocalIndex({
      codexHome, indexFile: seeded, secretFile, workerCount: 1, ordinalSeed,
    });
    assert.equal(result.sourcesNew, sources.length);
    assert.deepEqual(quotaIdentity(seeded), expectedQuota);

    // Sources that appear after the cutover are numbered above the carried map
    // and never reassigned.
    const ordinals = sourcesOf(seeded).map((source) => source.ordinal);
    assert.equal(new Set(ordinals).size, ordinals.length);
    assert.equal(Math.max(...ordinals), summary.maximumOrdinal);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a damaged ordinal map never creates a duplicate identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-index-cutover-"));
  try {
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    const codexHome = join(root, "codex-home");
    generateSyntheticCodexCorpus(codexHome, {
      seed: 3, files: 6, events: 60, days: 2, fillerBytesPerEvent: 50,
      endAt: "2026-09-01T00:00:00.000Z",
    });
    const secretFile = join(state, "local-unified-index-device-salt-v1");
    const reference = join(state, "reference.sqlite");
    await refreshLocalIndex({ codexHome, indexFile: reference, secretFile, workerCount: 1 });
    const sources = sourcesOf(reference);
    assert.equal(sources.length, 6);

    // Two sources claim ordinal 0.
    const legacy = join(state, "legacy.sqlite");
    writeLegacyIndex(legacy, {
      cursors: sources.map((source, rank) => [source.sourceLocal, rank < 2 ? 0 : rank]),
    });
    const { ordinalSeed, summary } = readLegacyOrdinalMap(legacy);
    // The colliding cursors are left out of the seed and counted.
    assert.ok(summary.conflictingSources + summary.duplicatedOrdinals >= 1);
    assert.ok(ordinalSeed.size < 6);
    assert.equal(new Set(ordinalSeed.values()).size, ordinalSeed.size);
    const store = join(state, "store.sqlite");
    const result = await refreshLocalIndex({
      codexHome, indexFile: store, secretFile, workerCount: 1, ordinalSeed,
    });
    assert.equal(result.sourcesNew, 6);
    const ordinals = sourcesOf(store).map((source) => source.ordinal);
    assert.equal(new Set(ordinals).size, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retirement is assessed read-only and refused for a source the new store lacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-index-retire-"));
  try {
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    const codexHome = join(root, "codex-home");
    generateSyntheticCodexCorpus(codexHome, {
      seed: 21, files: 12, events: 360, days: 4, fillerBytesPerEvent: 80,
      endAt: "2026-09-01T00:00:00.000Z",
    });
    const secretFile = join(state, "local-unified-index-device-salt-v1");
    const first = join(state, "first.sqlite");
    await refreshLocalIndex({ codexHome, indexFile: first, secretFile, workerCount: 1 });

    // A legacy file that holds exactly what the first store holds.
    const counts = new DatabaseSync(first, { readOnly: true });
    const perSource = counts.prepare(`
      SELECT s.source_local AS source_local, s.source_ordinal AS source_ordinal,
             COUNT(u.source_offset) AS events
      FROM source s LEFT JOIN usage_event u
        ON u.source_id = s.id AND u.source_offset <= s.scanned_bytes
      GROUP BY s.id`).all();
    counts.close();
    const legacy = join(state, "legacy.sqlite");
    writeLegacyIndex(legacy, {
      cursors: perSource.map((row) => [row.source_local, row.source_ordinal]),
      usage: perSource.map((row) => [row.source_local, row.source_ordinal, Number(row.events)]),
    });

    const whole = assessLegacyIndexRetirement({ legacyIndexFile: legacy, indexFile: first });
    assert.equal(whole.status, "assessed");
    assert.ok(whole.legacySources >= 12);
    assert.equal(whole.currentSources, whole.legacySources);
    assert.equal(whole.absentSources, 0);
    assert.equal(whole.shortfallSources, 0);
    assert.equal(whole.retirable, true);
    assert.deepEqual(Object.keys(whole).sort(), [
      "absentEvents", "absentSources", "currentSources", "legacySources", "retirable",
      "shortfallEvents", "shortfallSources", "status",
    ]);

    // A rollout the new store never saw: its facts exist only in the old file.
    const rollout = walkFiles(codexHome).find((path) => path.endsWith(".jsonl"));
    rmSync(rollout);
    const second = join(state, "second.sqlite");
    await refreshLocalIndex({ codexHome, indexFile: second, secretFile, workerCount: 1 });
    const lacking = assessLegacyIndexRetirement({ legacyIndexFile: legacy, indexFile: second });
    assert.equal(lacking.retirable, false);
    assert.equal(lacking.absentSources, 1);
    assert.ok(lacking.absentEvents > 0);

    // An unreadable file is not evidence that nothing would be lost.
    const missing = assessLegacyIndexRetirement({
      legacyIndexFile: join(state, "none.sqlite"), indexFile: second,
    });
    assert.deepEqual(missing, { status: "unreadable", retirable: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
