import test from "node:test";
import assert from "node:assert/strict";
import { REPLAY_SAFE_CALIBRATION_INTERNALS as I } from "../src/replay-safe-accounting-cache.js";

const start = Date.parse("2026-07-20T00:00:00Z");
const plans = ["plus", "pro", "prolite"];

function fixture() {
  const price = I.createAccountingPricer();
  const rows = [];
  const weeklyRateLimitSnapshots = [];
  for (let index = 0; index < 72; index += 1) {
    const ms = start + index * 30 * 60_000;
    const planType = plans[Math.floor(index / 24)];
    const raw = {
      timestamp: new Date(ms).toISOString(), model: index % 7 === 0 ? "unrecognized-model" : "gpt-5.6-sol",
      totalInputContextTokens: 1000,
      components: { input_uncached_tokens: 1000 + index, input_cache_read_tokens: 2000,
        input_cache_write_tokens: 0, output_text_tokens: 100, output_reasoning_tokens: 0 },
      tierSemantics: { codexSpeedMode: index % 3 === 0 ? "unknown" : "standard", apiServiceTier: "unknown" },
      planAttribution: { basis: index === 25 ? "conflicted" : "same_record", planType: index === 25 ? null : planType },
      usageIntervalStartedAt: new Date(ms - 5 * 60_000).toISOString(),
    };
    rows.push(I.transitionUsageProjection(raw, I.eventProjection(raw, price)));
    weeklyRateLimitSnapshots.push(I.weeklyRateLimitProjection({ timestamp: raw.timestamp, timestampMs: ms,
      window: { provider: "openai_codex", limitId: "codex", slot: "primary", planType,
        windowDurationMins: 10080, resetsAt: (start + 7 * 86_400_000) / 1000, usedPercent: index % 24 } }));
  }
  return { rows, options: { weeklyRateLimitSnapshots, endMs: start + 72 * 30 * 60_000,
    declaredSpeedBaselines: [] } };
}

test("shared calibration traversal preserves complete independent plan results and visits rows once", async () => {
  const { rows, options } = fixture();
  const forEachUsageRow = async consume => { for (const row of rows) await consume(row); };
  const current = await I.fitCompositionFromCorpusStream({ ...options, forEachUsageRow, selectedPlanType: "prolite" });
  const historical = await I.fitHistoricalPlanTimelines({ ...options, forEachUsageRow }, plans, "prolite");
  let passes = 0, visits = 0;
  const shared = await I.fitPlanCompositionsFromCorpus({ ...options, forEachUsageRow: async consume => {
    passes += 1;
    for (const row of rows) { visits += 1; await consume(row); }
  } }, plans, "prolite");
  assert.equal(passes, 1);
  assert.equal(visits, rows.length);
  assert.deepEqual(shared.compositionResult, current);
  assert.deepEqual(shared.historicalPlanDrafts, historical);
  assert.equal(shared.compositionFitFailure, null);
});

test("a single consumer failure does not remove valid historical plan results", async () => {
  const { rows, options } = fixture();
  let once = true;
  const poisoned = [...rows[0]];
  Object.defineProperty(poisoned, 0, { get() {
    if (once) { once = false; throw Object.assign(new Error("synthetic"), { code: "accounting_transition_memory_budget_exceeded" }); }
    return rows[0][0];
  } });
  const result = await I.fitPlanCompositionsFromCorpus({ ...options, forEachUsageRow: async consume => {
    await consume(poisoned);
    for (const row of rows.slice(1)) await consume(row);
  } }, plans, "prolite");
  assert.equal(result.compositionResult, null);
  assert.equal(result.compositionFitFailure.reason, "accounting_transition_memory_budget_exceeded");
  assert.ok(result.historicalPlanDrafts.every(lane => lane.failure === null && lane.draft !== null));
});

test("a shared read failure leaves all unfinished fits failed rather than partial successes", async () => {
  const { rows, options } = fixture();
  const result = await I.fitPlanCompositionsFromCorpus({ ...options, forEachUsageRow: async consume => {
    await consume(rows[0]);
    throw Object.assign(new Error("synthetic"), { code: "accounting_calibration_corpus_unavailable" });
  } }, plans, "prolite");
  assert.equal(result.compositionResult, null);
  assert.ok(result.compositionFitFailure);
  assert.ok(result.historicalPlanDrafts.every(lane => lane.draft === null && lane.failure !== null));
});

test("shared traversal preserves plan limits, cancellation and global memory checks", async () => {
  const { rows, options } = fixture();
  await assert.rejects(I.fitPlanCompositionsFromCorpus(options, Array(17).fill("pro"), "pro"), { code: "accounting_transition_derivation_limit_exceeded" });
  const controller = new AbortController();
  await assert.rejects(I.fitPlanCompositionsFromCorpus({ ...options, signal: controller.signal,
    forEachUsageRow: async consume => { controller.abort(); await consume(rows[0]); },
  }, plans, "prolite"), { name: "AbortError" });
  await assert.rejects(I.fitPlanCompositionsFromCorpus({ ...options,
    checkRuntimeMemory: () => { throw Object.assign(new Error("synthetic"), { code: "accounting_transition_rss_limit_exceeded" }); },
  }, plans, "prolite"), { code: "accounting_transition_rss_limit_exceeded" });
  let checks = 0;
  await assert.rejects(I.fitPlanCompositionsFromCorpus({ ...options,
    checkRuntimeMemory: () => {
      if (++checks > 1) throw Object.assign(new Error("synthetic"), { code: "accounting_transition_rss_limit_exceeded" });
    },
    forEachUsageRow: async consume => { for (let i = 0; i < 2050; i += 1) await consume(rows[i % rows.length]); },
  }, plans, "prolite"), { code: "accounting_transition_rss_limit_exceeded" });
  assert.ok(checks > 1, "the combined memory guard is still enforced after traversal starts");
});
