import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  auditPairing,
} from "../src/local-index-pairing.js";
import {
  readLocalIndexCacheCandidateRows,
  readLocalIndexCacheCandidateRowsExact,
} from "../src/local-index-report.js";
import {
  createLocalIndexWriter,
  EVENT_FLAG_PARTIAL,
  EVENT_FLAG_RESPONSE_USAGE,
  openLocalIndexStore,
} from "../src/local-index-store.js";

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function openTemporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), "local-index-pairing-"));
  const database = openLocalIndexStore(join(directory, "store.sqlite"), { create: true });
  return {
    database,
    cleanup() {
      if (database.isOpen) database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const pick = (random, values) => values[Math.floor(random() * values.length)];

/**
 * A store with several sources. Sessions are shared by some sources (spanning
 * sessions), some requests are zero-input (not requests), some are dated far
 * in the future, and offsets and times regress independently.
 */
function populate(database, random, { eventsPerSource = 80, sources = 8, sessions = 5 } = {}) {
  const writer = createLocalIndexWriter(database);
  writer.begin();
  const sessionIds = Array.from({ length: sessions }, (_, index) =>
    writer.internSession(Buffer.alloc(32, index + 1), null));
  const models = ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex"].map((id) => writer.internModel(id, "recognized"));
  const tier = writer.internTier({
    apiServiceTier: "standard", billingSurface: "subscription", codexSpeedMode: "standard",
    tierSource: "observed", providerTierRaw: null,
  });
  const surface = writer.internSurface({
    agentScope: "root", surface: "cli_exec", threadSource: "cli", lineageDisposition: "standalone",
  });
  const scope = writer.internAccountScope({ status: "unavailable", reason: null, planType: null });
  const created = [];
  const baseMs = Date.UTC(2026, 8, 1);
  for (let index = 0; index < sources; index += 1) {
    // A v2 source belongs to one session; several sources may share one.
    const sessionId = sessionIds[index % sessions];
    const source = writer.registerSource({
      sourceLocal: Buffer.alloc(32, 100 + index),
      sessionId,
      path: `synthetic-${index}.jsonl`,
      rolloutKey: `synthetic-${index}`,
      sizeBytes: 10_000_000,
      mtimeMs: 1,
    });
    created.push({ id: source.id, sessionId });
    let offset = 0;
    for (let event = 0; event < eventsPerSource; event += 1) {
      offset += 100 + Math.floor(random() * 400);
      const zero = random() < 0.2;
      const future = random() < 0.02;
      writer.writeUsageEvent({
        sourceId: source.id,
        sourceOffset: offset,
        observedAtMs: future
          ? baseMs + 40 * 86_400_000 + event
          : baseMs + Math.floor(random() * 2 * 86_400_000),
        eventKey: Buffer.alloc(32, (index * 7 + event) % 250 + 1),
        sessionId,
        accountScopeId: scope,
        modelId: pick(random, models),
        tierId: tier,
        surfaceId: surface,
        reasoningEffort: Math.floor(random() * 4),
        tokensInUncached: zero ? 0 : 1 + Math.floor(random() * 100),
        tokensInCacheRead: zero ? null : Math.floor(random() * 100),
        tokensInCacheWrite: zero ? null : 0,
        tokensOutText: 5,
        tokensOutReasoning: 0,
        tokensOutCombined: null,
        totalInputContext: null,
      });
      if (random() < 0.1) {
        writer.writeBoundary({
          sourceId: source.id,
          sourceOffset: offset,
          compactionBefore: false,
          turnContextBefore: true,
          compactedAtMs: null,
        });
      } else if (random() < 0.03) {
        writer.writeBoundary({
          sourceId: source.id,
          sourceOffset: offset,
          compactionBefore: true,
          turnContextBefore: false,
          compactedAtMs: baseMs,
        });
      }
    }
    created.at(-1).size = offset;
  }
  writer.commit();
  return { writer, sources: created };
}

function cursorTo(database, sourceId, scannedBytes) {
  database.prepare("UPDATE source SET scanned_bytes = ? WHERE id = ?").run(scannedBytes, sourceId);
}

function sameRows(actual, expected, label) {
  const strip = (rows) => rows.map((row) => JSON.stringify({ ...row }));
  assert.deepEqual(strip(actual), strip(expected), label);
}

test("stored pairs equal a fresh derivation after cursor moves and deletes", () => {
  for (const seed of [31, 32, 33, 34]) {
    const { database, cleanup } = openTemporaryStore();
    try {
      const random = generator(seed);
      const { writer, sources } = populate(database, random);
      // Nothing is counted until a cursor passes the facts.
      assert.equal(Number(database.prepare("SELECT COUNT(*) AS n FROM cache_candidate").get().n), 0);
      // Advance in two steps to exercise a range that has a predecessor below it.
      for (const source of sources) cursorTo(database, source.id, Math.floor(source.size / 2));
      assert.equal(auditPairing(database), 0, `half, seed ${seed}`);
      for (const source of sources) cursorTo(database, source.id, source.size + 10);
      assert.equal(auditPairing(database), 0, `full, seed ${seed}`);
      assert.ok(Number(database.prepare("SELECT COUNT(*) AS n FROM cache_candidate").get().n) > 20);
      // Retreat uncounts what it leaves behind.
      cursorTo(database, sources[1].id, Math.floor(sources[1].size / 3));
      assert.equal(auditPairing(database), 0, `retreat, seed ${seed}`);
      cursorTo(database, sources[1].id, sources[1].size + 10);
      assert.equal(auditPairing(database), 0, `re-advance, seed ${seed}`);
      // A rescan from an offset deletes the suffix and writes it again.
      writer.begin();
      writer.deleteSourceFacts(sources[2].id, { fromOffset: Math.floor(sources[2].size / 2) });
      writer.deleteSourceFacts(sources[3].id, { fromOffset: 0 });
      writer.commit();
      assert.equal(auditPairing(database), 0, `delete, seed ${seed}`);
    } finally {
      cleanup();
    }
  }
});

test("materialized candidates equal the exact reader, including future-dated and spanning sessions", () => {
  const futureLimit = Date.UTC(2026, 8, 1) + 3 * 86_400_000;
  let withFuture = 0;
  let withSentinel = 0;
  for (const seed of [41, 42, 43, 44, 45, 46]) {
    const { database, cleanup } = openTemporaryStore();
    try {
      const random = generator(seed);
      const { sources } = populate(database, random, { sources: 9, sessions: 6, eventsPerSource: 120 });
      for (const source of sources) cursorTo(database, source.id, source.size + 10);
      const exact = readLocalIndexCacheCandidateRowsExact(database, futureLimit);
      const fast = readLocalIndexCacheCandidateRows(database, futureLimit);
      sameRows(fast, exact, `seed ${seed}`);
      assert.ok(exact.some((row) => row.ordering_coverage_gap === 0), "candidates present");
      for (const row of exact.filter((candidate) => candidate.ordering_coverage_gap === 1)) {
        assert.equal(row.current_observation_is_response, null);
        assert.equal(row.previous_observation_is_response, null);
      }
      if (exact.some((row) => row.ordering_coverage_gap === 1)) withSentinel += 1;
      const futureRows = Number(database.prepare(
        "SELECT COUNT(*) AS n FROM usage_event WHERE observed_at_ms > ?",
      ).get(futureLimit).n);
      if (futureRows > 0) withFuture += 1;
      // The same, with a later limit that admits the future-dated requests.
      sameRows(
        readLocalIndexCacheCandidateRows(database, futureLimit + 60 * 86_400_000),
        readLocalIndexCacheCandidateRowsExact(database, futureLimit + 60 * 86_400_000),
        `seed ${seed}, late limit`,
      );
    } finally {
      cleanup();
    }
  }
  assert.ok(withFuture >= 3, "future-dated requests were exercised");
  assert.ok(withSentinel >= 3, "spanning sessions were exercised");
});

test("candidate readers preserve response identity evidence on both sides of mixed legacy pairs", () => {
  const futureLimit = Date.UTC(2026, 8, 1) + 60 * 86_400_000;
  const { database, cleanup } = openTemporaryStore();
  try {
    const { writer, sources } = populate(database, generator(91), {
      sources: 1, sessions: 1, eventsPerSource: 12,
    });
    const offsets = database.prepare(`
      SELECT source_offset FROM usage_event
      WHERE COALESCE(tokens_in_uncached, 0) + COALESCE(tokens_in_cache_read, 0)
        + COALESCE(tokens_in_cache_write, 0) > 0
      ORDER BY source_offset LIMIT 4`).all().map((row) => Number(row.source_offset));
    assert.equal(offsets.length, 4);
    const flags = [EVENT_FLAG_RESPONSE_USAGE, EVENT_FLAG_PARTIAL,
      EVENT_FLAG_RESPONSE_USAGE | EVENT_FLAG_PARTIAL, 0];
    writer.begin();
    for (const [index, offset] of offsets.entries()) {
      database.prepare("UPDATE usage_event SET flags = ? WHERE source_id = ? AND source_offset = ?")
        .run(flags[index], sources[0].id, offset);
      writer.writeBoundary({
        sourceId: sources[0].id, sourceOffset: offset,
        compactionBefore: false, turnContextBefore: true, compactedAtMs: null,
      });
    }
    writer.commit();
    cursorTo(database, sources[0].id, sources[0].size + 10);
    const exact = readLocalIndexCacheCandidateRowsExact(database, futureLimit);
    const materialized = readLocalIndexCacheCandidateRows(database, futureLimit);
    sameRows(materialized, exact, "mixed observation evidence");
    for (const rows of [exact, materialized]) {
      for (let index = 1; index < offsets.length; index += 1) {
        const row = rows.find((candidate) => candidate.current_source_offset === offsets[index]);
        assert.ok(row, `pair at offset ${offsets[index]}`);
        assert.equal(row.current_observation_is_response, index === 2 ? 1 : 0);
        assert.equal(row.previous_observation_is_response, index === 2 ? 0 : 1);
      }
    }
  } finally {
    cleanup();
  }
});

test("a build in flight is read as its committed prefix", () => {
  const futureLimit = Date.UTC(2026, 8, 1) + 3 * 86_400_000;
  const { database, cleanup } = openTemporaryStore();
  try {
    const random = generator(77);
    const { sources } = populate(database, random, { sources: 4, sessions: 4, eventsPerSource: 100 });
    // Two sources committed to half, two untouched (everything provisional).
    cursorTo(database, sources[0].id, Math.floor(sources[0].size / 2));
    cursorTo(database, sources[1].id, sources[1].size + 10);
    sameRows(
      readLocalIndexCacheCandidateRows(database, futureLimit, { committedOnly: true }),
      readLocalIndexCacheCandidateRowsExact(database, futureLimit, { committedOnly: true }),
      "partial build",
    );
  } finally {
    cleanup();
  }
});
