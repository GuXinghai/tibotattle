import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { declaredSpeedModeAt } from "../src/codex-speed-baseline.js";
import {
  addTimelineUsage,
  addUsageToPeriod,
  finalizeTimelineBuckets,
  finalizeUsagePeriod,
  newUsagePeriod,
  safeSpeed,
  usageProjection,
} from "../src/local-companion-usage-model.js";
import { readLocalIndexUsage } from "../src/local-index-report.js";
import { createAccountingPricer } from "../src/replay-safe-accounting-cache.js";
import { compareProjections } from "./helpers/local-index-report-diff.js";
import { auditWorkRollups, pruneEmptyWorkRollups } from "../src/local-index-work-rollup.js";
import {
  contextClassStarts,
  auditRollups,
  pruneEmptyRollups,
  rollupBasisCurrent,
  rollupKeyExpressions,
} from "../src/local-index-rollup.js";
import {
  createLocalIndexWriter,
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
  const directory = mkdtempSync(join(tmpdir(), "local-index-rollup-"));
  const file = join(directory, "store.sqlite");
  const database = openLocalIndexStore(file, { create: true });
  return {
    database,
    cleanup() {
      if (database.isOpen) database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const BOUNDARIES = [0, 1, 271_999, 272_000, 272_001, 272_002, 400_000, 999_999];

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function tokens(random, zeroBias = 0.25, nullBias = 0.15) {
  const value = random();
  if (value < nullBias) return null;
  if (value < nullBias + zeroBias) return 0;
  return Math.floor(random() * 5_000) + 1;
}

/** Facts that reach every branch of the key: nulls, zeros, thresholds, gaps. */
function randomEvent(random, writer, sourceId, offset, base) {
  const split = random() < 0.7;
  const text = split ? tokens(random) : null;
  const reasoning = split ? tokens(random) : null;
  const combined = random() < 0.25
    ? (text !== null && reasoning !== null && random() < 0.5
      ? text + reasoning
      : tokens(random))
    : null;
  const uncached = tokens(random, 0.1, 0.1);
  const read = tokens(random, 0.3, 0.1);
  const write = tokens(random, 0.6, 0.2);
  const total = random() < 0.4 ? pick(random, BOUNDARIES) : null;
  return {
    sourceId,
    sourceOffset: offset,
    observedAtMs: base + Math.floor(random() * 86_400_000 * 3),
    eventKey: Buffer.alloc(32, (offset % 251) + 1),
    sessionId: writer.internSession(Buffer.alloc(32, 7), null),
    accountScopeId: writer.internAccountScope({ status: pick(random, ["available", "unavailable"]), reason: null, planType: null }),
    modelId: writer.internModel(pick(random, ["gpt-5.5", "gpt-5.5-mini", "unknown-x"]), "recognized"),
    tierId: writer.internTier({
      apiServiceTier: pick(random, ["standard", "priority"]),
      billingSurface: "subscription",
      codexSpeedMode: pick(random, ["standard", "fast", "unknown"]),
      tierSource: "observed",
      providerTierRaw: null,
    }),
    surfaceId: writer.internSurface({
      agentScope: pick(random, ["root", "subagent"]),
      surface: pick(random, ["cli_exec", "extension_or_ide"]),
      threadSource: "cli",
      lineageDisposition: pick(random, ["standalone", "forked"]),
    }),
    reasoningEffort: 8,
    partial: random() < 0.1,
    cacheWriteAssumedZero: random() < 0.1,
    statusOnly: random() < 0.05,
    workDirectoryId: pick(random, [
      null, writer.internWorkDirectory("/synthetic/a"), writer.internWorkDirectory("/synthetic/b"),
    ]),
    tokensInUncached: uncached,
    tokensInCacheRead: read,
    tokensInCacheWrite: write,
    tokensOutText: text,
    tokensOutReasoning: reasoning,
    tokensOutCombined: combined,
    totalInputContext: total,
  };
}

function registerSource(writer, ordinal) {
  return writer.registerSource({
    sourceLocal: Buffer.alloc(32, ordinal + 1),
    path: `synthetic-${ordinal}.jsonl`,
    rolloutKey: `synthetic-${ordinal}`,
    sizeBytes: 1_000_000,
    mtimeMs: 1,
  }).id;
}

function moveCursor(database, sourceId, scannedBytes) {
  database.prepare("UPDATE source SET scanned_bytes = ? WHERE id = ?").run(scannedBytes, sourceId);
  // A retreat leaves emptied rows behind; the writer prunes them in the same
  // transaction and the audits count any that remain.
  pruneEmptyRollups(database);
  pruneEmptyWorkRollups(database);
}

test("rollups equal a grouping of the facts after random inserts and deletes", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const { database, cleanup } = openTemporaryStore();
    try {
      const random = generator(seed);
      const writer = createLocalIndexWriter(database);
      writer.begin();
      const sources = [registerSource(writer, 1), registerSource(writer, 2), registerSource(writer, 3)];
      const base = Date.UTC(2026, 7, 31);
      let offset = 1;
      for (let index = 0; index < 600; index += 1) {
        writer.writeUsageEvent(randomEvent(random, writer, pick(random, sources), offset, base));
        offset += 1;
      }
      // Facts are provisional until their source's cursor passes them.
      assert.equal(
        Number(database.prepare("SELECT COUNT(*) AS n FROM usage_rollup").get().n), 0,
        "provisional facts are not counted",
      );
      for (const id of sources) moveCursor(database, id, 1_000_000);
      writer.commit();
      assert.equal(auditWorkRollups(database), 0, "work rollups");
      assert.equal(auditRollups(database), 0, `insert, seed ${seed}`);
      // Deleting by source range exercises the delete trigger and the prune.
      writer.begin();
      writer.deleteSourceFacts(sources[0], { fromOffset: 0 });
      writer.deleteSourceFacts(sources[1], { fromOffset: 300 });
      writer.commit();
      assert.equal(auditWorkRollups(database), 0, "work rollups");
      assert.equal(auditRollups(database), 0, `delete, seed ${seed}`);
      // Re-inserting the same offsets must restore the grouping.
      writer.begin();
      for (let index = 0; index < 200; index += 1) {
        writer.writeUsageEvent(randomEvent(random, writer, sources[0], offset, base));
        offset += 1;
      }
      writer.commit();
      // Deleting a source's facts retreated its cursor, so the new facts are
      // provisional: uncounted until the cursor passes them.
      assert.equal(auditWorkRollups(database), 0, "work rollups");
      assert.equal(auditRollups(database), 0, `reinsert (provisional), seed ${seed}`);
      moveCursor(database, sources[0], 1_000_000);
      assert.equal(auditWorkRollups(database), 0, "work rollups");
      assert.equal(auditRollups(database), 0, `advance over the rewrite, seed ${seed}`);
      moveCursor(database, sources[1], 1_000_000);
      moveCursor(database, sources[2], 450);
      assert.equal(auditWorkRollups(database), 0, "work rollups");
      assert.equal(auditRollups(database), 0, `retreat, seed ${seed}`);
      moveCursor(database, sources[2], 1_000_000);
      assert.equal(auditWorkRollups(database), 0, "work rollups");
      assert.equal(auditRollups(database), 0, `advance, seed ${seed}`);
      assert.equal(auditWorkRollups(database), 0, "work rollups");
      assert.equal(auditRollups(database), 0, `reinsert, seed ${seed}`);
      assert.equal(rollupBasisCurrent(database), true);
      const events = Number(database.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n);
      const counted = Number(database.prepare("SELECT COALESCE(SUM(events), 0) AS n FROM usage_rollup").get().n);
      assert.equal(counted, events);
      assert.equal(
        Number(database.prepare("SELECT COUNT(*) AS n FROM usage_rollup WHERE events <= 0").get().n),
        0,
      );
    } finally {
      cleanup();
    }
  }
});

test("a bucket never straddles a UTC date and shapes separate every nullable pattern", () => {
  const { database, cleanup } = openTemporaryStore();
  try {
    const writer = createLocalIndexWriter(database);
    writer.begin();
    const sourceId = registerSource(writer, 1);
    const midnight = Date.UTC(2026, 7, 31);
    const common = {
      sourceId,
      eventKey: Buffer.alloc(32, 9),
      sessionId: writer.internSession(Buffer.alloc(32, 7), null),
      accountScopeId: writer.internAccountScope({ status: "unavailable", reason: null, planType: null }),
      modelId: writer.internModel("gpt-5.5", "recognized"),
      tierId: writer.internTier({ apiServiceTier: "standard", billingSurface: "subscription", codexSpeedMode: "standard", tierSource: "observed", providerTierRaw: null }),
      surfaceId: writer.internSurface({ agentScope: "root", surface: "cli_exec", threadSource: "cli", lineageDisposition: "standalone" }),
      reasoningEffort: 8,
      tokensInUncached: 1, tokensInCacheRead: 0, tokensInCacheWrite: 0,
      tokensOutText: 1, tokensOutReasoning: 0, tokensOutCombined: null,
      totalInputContext: null,
    };
    // The last millisecond before midnight and midnight itself.
    writer.writeUsageEvent({ ...common, sourceOffset: 1, observedAtMs: midnight - 1 });
    writer.writeUsageEvent({ ...common, sourceOffset: 2, observedAtMs: midnight });
    // A NULL cache write is a different shape from a zero one.
    writer.writeUsageEvent({ ...common, sourceOffset: 3, observedAtMs: midnight, tokensInCacheWrite: null });
    moveCursor(database, sourceId, 10);
    writer.commit();
    const buckets = database.prepare(
      "SELECT bucket_ms, shape, events FROM usage_rollup ORDER BY bucket_ms, shape",
    ).all();
    assert.equal(buckets.length, 3);
    assert.equal(Number(buckets[0].bucket_ms), midnight - 900_000);
    assert.equal(Number(buckets[1].bucket_ms), midnight);
    assert.notEqual(Number(buckets[1].shape), Number(buckets[2].shape));
    assert.equal(auditRollups(database), 0);
  } finally {
    cleanup();
  }
});

test("context classes follow the registry thresholds and change only at them", () => {
  const starts = contextClassStarts();
  assert.ok(starts.length >= 2, "the registry declares at least one context threshold");
  assert.ok(starts.includes(272_000) && starts.includes(272_001));
  // Strictly ascending, so a class is an interval.
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] > starts[index - 1]);
  }
  const expressions = rollupKeyExpressions("u");
  assert.match(expressions.ctx_class, /rollup_context_start/);
});

// ---------------------------------------------------------------------------
// The key is sufficient for pricing: projecting rollup rows weighted by their
// event counts equals projecting every event, for facts with every nullable
// pattern, context totals on and around each registry threshold, and a speed
// ledger whose boundaries fall inside buckets.

function referenceUsage(database, { nowMs, declaredSpeedBaselines }) {
  const futureLimitMs = nowMs + 5 * 60_000;
  const periods = [
    ["24h", "Last 24 hours", nowMs - 86_400_000],
    ["7d", "Last 7 days", nowMs - 7 * 86_400_000],
    ["30d", "Last 30 days", nowMs - 30 * 86_400_000],
    ["all", "All indexed local history", Number.NEGATIVE_INFINITY],
  ].map(([id, label, start]) => ({ summary: newUsagePeriod(id, label), start }));
  const timeline = new Map();
  const spark = new Map();
  const pricer = createAccountingPricer();
  let usageEvents = 0;
  const rows = database.prepare(`
    SELECT u.observed_at_ms, m.model_id, t.codex_speed_mode, t.api_service_tier,
           s.surface, s.agent_scope, s.lineage_disposition, a.status,
           u.total_input_context, u.tokens_in_uncached, u.tokens_in_cache_read,
           u.tokens_in_cache_write, u.tokens_out_text, u.tokens_out_reasoning,
           u.tokens_out_combined
    FROM usage_event u
    JOIN model m ON m.id = u.model_id
    JOIN tier_semantics t ON t.id = u.tier_id
    JOIN surface_class s ON s.id = u.surface_id
    JOIN account_scope a ON a.id = u.account_scope_id
    JOIN source src ON src.id = u.source_id
    WHERE u.source_offset <= src.scanned_bytes`).all();
  for (const row of rows) {
    const observedMs = Number(row.observed_at_ms);
    if (observedMs > futureLimitMs) continue;
    usageEvents += 1;
    const projection = usageProjection({
      observedAt: new Date(observedMs).toISOString(),
      model: row.model_id,
      totalInputContextTokens: row.total_input_context,
      components: {
        input_uncached_tokens: row.tokens_in_uncached,
        input_cache_read_tokens: row.tokens_in_cache_read,
        input_cache_write_tokens: row.tokens_in_cache_write,
        output_text_tokens: row.tokens_out_text,
        output_reasoning_tokens: row.tokens_out_reasoning,
        output_combined_tokens: row.tokens_out_combined,
      },
      tierSemantics: { codexSpeedMode: row.codex_speed_mode, apiServiceTier: row.api_service_tier },
      surfaceClassification: {
        surface: row.surface, agentScope: row.agent_scope, lineageDisposition: row.lineage_disposition,
      },
      accountScope: { status: row.status },
    }, safeSpeed(row.codex_speed_mode) === "unknown"
      ? declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown"
      : "unknown", pricer);
    if (projection === null) continue;
    for (const period of periods) {
      if (observedMs >= period.start) addUsageToPeriod(period.summary, projection);
    }
    addTimelineUsage(projection.isSpark ? spark : timeline, observedMs, projection);
  }
  return {
    usage: periods.map((period) => finalizeUsagePeriod(period.summary)),
    timeline: {
      usage: finalizeTimelineBuckets(timeline),
      sparkUsage: finalizeTimelineBuckets(spark),
    },
    usageEvents,
  };
}

test("projecting rollup rows weighted equals projecting every event", () => {
  const nowBase = Date.UTC(2026, 7, 31, 12);
  for (const seed of [21, 22, 23, 24, 25]) {
    const { database, cleanup } = openTemporaryStore();
    try {
      const random = generator(seed);
      const writer = createLocalIndexWriter(database);
      writer.begin();
      const sources = [registerSource(writer, 1), registerSource(writer, 2)];
      // Dates either side of the gpt-5.6 repricing boundary (2026-08-21).
      const base = Date.UTC(2026, 7, 19);
      for (let index = 0; index < 1_500; index += 1) {
        const event = randomEvent(random, writer, pick(random, sources), index + 1, base);
        // Reach the registry thresholds exactly, and leave some totals unknown.
        writer.writeUsageEvent({
          ...event,
          modelId: writer.internModel(pick(random, [
            "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark",
            "gpt-5.2-codex", "gpt-synthetic-unrecognized",
          ]), "recognized"),
        });
      }
      for (const id of sources) moveCursor(database, id, 1_000_000);
      writer.commit();
      for (let trial = 0; trial < 4; trial += 1) {
        const nowMs = nowBase + Math.floor(random() * 3 * 86_400_000) - 86_400_000;
        const first = nowMs - Math.floor(random() * 5 * 86_400_000);
        const baselines = [
          { mode: "standard", firstSeenAt: new Date(first).toISOString(), lastSeenAt: new Date(first + 333_333_333).toISOString() },
          { mode: "fast", firstSeenAt: new Date(first + 400_000_000).toISOString(), lastSeenAt: new Date(first + 400_000_000 + 91_000_000).toISOString() },
        ];
        const expected = referenceUsage(database, { nowMs, declaredSpeedBaselines: baselines });
        const actual = readLocalIndexUsage(database, { nowMs, declaredSpeedBaselines: baselines });
        const differences = [];
        const stats = { money: 0, exact: 0 };
        compareProjections(expected, {
          usage: actual.usage,
          timeline: { usage: actual.timeline.usage, sparkUsage: actual.timeline.sparkUsage },
          usageEvents: actual.usageEvents,
        }, "$", differences, stats);
        assert.deepEqual(differences.slice(0, 5), [], `seed ${seed} trial ${trial}`);
        assert.ok(stats.exact > 500);
        // Rollups compress: the weighted path must have read far fewer rows.
        assert.ok(actual.expandedBuckets <= 12);
      }
    } finally {
      cleanup();
    }
  }
});
