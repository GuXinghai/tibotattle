import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDashboardPayload } from "../public/data-client.js";

const fields = {
  speedApiPriceEquivalentUsd: 12.5,
  speedPricingCoverageStatus: "partially_priced",
  speedPricingProvenance: { observedEvents: 2, declaredEvents: 1, unknownEvents: 1 },
  speedComponentCosts: {
    input_uncached_tokens: { tokens: 100, pricedTokens: 70, unpricedTokens: 30, costUsd: 12.5 },
    output_text_tokens: { tokens: 10, pricedTokens: 0, unpricedTokens: 10, costUsd: 0 },
    private_unknown_field: { tokens: 1, pricedTokens: 1, unpricedTokens: 0, costUsd: 1 },
  },
};

test("speed-priced money and coverage survive the browser boundary for totals, periods and models", () => {
  const result = normalizeDashboardPayload({ mode: "real_local_evidence", accounting: {
    ...fields, byModel: [{ model: "gpt-6-sol", ...fields }],
    periods: [{ periodId: "7d", ...fields }],
  } }).accounting;
  for (const row of [result, result.byModel[0], result.modelUsage[0], result.periods[0]]) {
    assert.equal(row.speedApiPriceEquivalentUsd, 12.5);
    assert.equal(row.speedPricingCoverageStatus, "partially_priced");
    assert.deepEqual(row.speedPricingProvenance, fields.speedPricingProvenance);
    assert.equal(row.speedComponentCosts.input_uncached_tokens.costUsd, 12.5);
    assert.equal(row.speedComponentCosts.output_text_tokens.costUsd, null);
    assert.equal(row.speedComponentCosts.private_unknown_field, undefined);
  }
});

test("missing speed data never falls back to Standard money or zero and malformed components are omitted", () => {
  const missing = normalizeDashboardPayload({ mode: "real_local_evidence", accounting: { apiPriceEquivalentUsd: 20 } }).accounting;
  assert.equal(missing.speedApiPriceEquivalentUsd, null);
  assert.equal(missing.speedPricingCoverageStatus, "unpriced");
  const invalid = normalizeDashboardPayload({ mode: "real_local_evidence", accounting: {
    ...fields, speedApiPriceEquivalentUsd: -1,
    speedComponentCosts: { input_uncached_tokens: { tokens: 100, pricedTokens: 120, unpricedTokens: 0, costUsd: 2 } },
  } }).accounting;
  assert.equal(invalid.speedApiPriceEquivalentUsd, null);
  assert.deepEqual(invalid.speedComponentCosts, {});
});
