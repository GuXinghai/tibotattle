import test from "node:test";
import assert from "node:assert/strict";
import { priceCodexUsageEvent, addUsdStrings } from "@app-usagemonitor/accounting";
import { speedApiPrice } from "../src/speed-api-cost.js";
import { usageProjection, newUsagePeriod, addUsageToPeriod, finalizeUsagePeriod } from "../src/local-companion-usage-model.js";
import { createAccountingPricer, buildReplaySafeAccountingPeriod } from "../src/replay-safe-accounting-cache.js";

const components = { input_uncached_tokens: 1000, input_cache_read_tokens: 200, input_cache_write_tokens: 0, output_text_tokens: 100, output_reasoning_tokens: 50 };
const at = "2026-10-01T12:00:00.000Z";
const event = speed => ({ timestamp: at, observedAt: at, model: "gpt-6-sol", components, tierSemantics: { codexSpeedMode: speed }, totalInputContextTokens: 1200 });

test("speed API estimates use exact published per-tier prices and preserve Standard analysis", () => {
  const period = newUsagePeriod("all", "All");
  const pricer = createAccountingPricer();
  const standard = priceCodexUsageEvent(event("standard"));
  const fast = priceCodexUsageEvent(event("fast"), { apiServiceTier: "priority" });
  for (const speed of ["standard", "fast"]) addUsageToPeriod(period, usageProjection(event(speed), "unknown", pricer));
  const result = finalizeUsagePeriod(period);
  assert.equal(result.apiPriceEquivalentUsd, Number(standard.totalUsd) * 2);
  assert.equal(result.speedApiPriceEquivalentUsd, Number(addUsdStrings(standard.totalUsd, fast.totalUsd)));
  assert.equal(result.speedPricingCoverageStatus, "fully_priced");
  assert.equal(result.byModel[0].speedApiPriceEquivalentUsd, result.speedApiPriceEquivalentUsd);
  assert.ok(Math.abs(Object.values(result.speedComponentCosts).reduce((sum, row) => sum + row.costUsd, 0) - result.speedApiPriceEquivalentUsd) < 1e-12);
});

test("unknown speed remains unpriced while an explicit declaration selects its rate", () => {
  const standard = priceCodexUsageEvent(event("unknown"));
  assert.equal(speedApiPrice(event("unknown"), components, standard).coverageStatus, "unpriced");
  assert.equal(speedApiPrice(event("unknown"), components, standard, "fast").speedPriceProvenance, "declared_codex_config");
  assert.equal(speedApiPrice(event("unknown"), components, standard, "fast").totalUsd,
    priceCodexUsageEvent(event("fast"), { apiServiceTier: "priority" }).totalUsd);
});

test("missing Fast or Ultrafast rates stay unpriced instead of using quota multipliers", () => {
  const raw = { ...event("fast"), model: "unrecognized-synthetic-model" };
  const price = speedApiPrice(raw, components, { totalUsd: "10", coverageStatus: "fully_priced", components: [] });
  assert.equal(price.coverageStatus, "unpriced");
  const period = newUsagePeriod("all", "All");
  addUsageToPeriod(period, usageProjection(event("standard")));
  addUsageToPeriod(period, usageProjection(raw));
  const result = finalizeUsagePeriod(period);
  assert.equal(result.speedPricingCoverageStatus, "partially_priced");
  assert.equal(result.byModel.find(row => row.model === "unknown").speedApiPriceEquivalentUsd, null);
});

test("memoized tier pricer agrees with ledger across dates and context boundaries", () => {
  const price = createAccountingPricer();
  for (const apiServiceTier of ["priority", "ultrafast"]) for (const model of ["gpt-6-sol", "gpt-6-astra"]) {
    for (const timestamp of [at, "2026-09-01T00:00:00.000Z"]) for (const totalInputContextTokens of [1200, 272000, 272001]) {
      const raw = { ...event("fast"), model, timestamp, totalInputContextTokens };
      const expected = priceCodexUsageEvent(raw, { apiServiceTier });
      const actual = price.forApiTier(apiServiceTier, raw, components);
      assert.equal(actual.totalUsd, expected.totalUsd);
      assert.equal(actual.coverageStatus, expected.coverageStatus);
    }
  }
});

test("Fast memoization preserves missing long-context rates instead of pricing them as short", () => {
  const price = createAccountingPricer();
  const mismatches = [];
  for (const totalInputContextTokens of [271_999, 272_000, 272_001, 549_194]) {
    const raw = { timestamp: "2026-07-24T12:00:00.000Z", model: "gpt-5.4", totalInputContextTokens };
    const tokens = { input_uncached_tokens: totalInputContextTokens, input_cache_read_tokens: 0,
      input_cache_write_tokens: 0, output_text_tokens: 100, output_reasoning_tokens: 0 };
    const expected = priceCodexUsageEvent({ ...raw, components: tokens }, {
      apiServiceTier: "priority", priceEpochBasis: "event_time",
    });
    assert.equal(expected.coverageStatus, totalInputContextTokens < 272_000 ? "fully_priced" : "unpriced");
    const actual = price.forApiTier("priority", raw, tokens);
    if (actual.totalUsd !== expected.totalUsd || actual.coverageStatus !== expected.coverageStatus) {
      mismatches.push({ context: totalInputContextTokens, expected: expected.totalUsd,
        expectedStatus: expected.coverageStatus, actual: actual.totalUsd, actualStatus: actual.coverageStatus });
    }
  }
  assert.deepEqual(mismatches, []);
});

test("replay period exposes the same mixed-speed model and component amounts", async () => {
  const raws = [event("standard"), event("fast")];
  const result = await buildReplaySafeAccountingPeriod({
    startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-02T00:00:00.000Z",
    scan: async ({ onUsage }) => { for (const raw of raws) await onUsage(raw); },
  });
  const period = newUsagePeriod("all", "All");
  for (const raw of raws) addUsageToPeriod(period, usageProjection(raw));
  const expected = finalizeUsagePeriod(period);
  assert.equal(result.period.speedApiPriceEquivalentUsd, expected.speedApiPriceEquivalentUsd);
  assert.deepEqual(result.period.speedComponentCosts, expected.speedComponentCosts);
});
