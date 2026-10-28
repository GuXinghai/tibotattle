import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDashboardPayload } from "../public/data-client.js";

const family = "codex_primary:speed_priced_api_equivalent:v5:published_speed_card_ratio_2026_09_29:event_time:observed_declared_scenario";
const standard = "unresolved_as_standard", fast = "unresolved_as_fast", custom = "unresolved_as_custom";
function fixture(policy = { mode: "custom", customFastRatioBps: 300 }) {
  const selected = `unresolved_as_${policy.mode}`;
  const order = policy.mode === "custom" ? [standard, fast, custom] : [standard, fast];
  const basis = `${family}:${selected}${policy.mode === "custom" ? `:${policy.customFastRatioBps}` : ""}`;
  const scope = { methodVersion: "plan-era-v1", planType: "pro", basisFamilyId: family, basisId: basis,
    cohortId: "a".repeat(64), sourceGeneration: 1, sourceGenerationFingerprint: "synthetic-generation" };
  const costs = { [standard]: 10, [fast]: 20, [custom]: 10.3 };
  const block = usd => [0, usd, usd, 0, 0, 1, 0, 0];
  return { mode: "real_local_evidence", accountingProjection: { status: "available", reason: null, terminal: false },
    timeline: { allowanceWeightingEncoding: { schemaVersion: "quota-weighted-timeline-v0.2",
      basisFamilyId: family, scenarioOrder: order, selectedScenario: selected, unknownSpeedPolicy: policy },
      usage: [{ startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-01T00:15:00.000Z",
        usageEvents: 1, totalTokens: 100, apiPriceEquivalentUsd: 10,
        components: { input_uncached_tokens: 100 },
        pricingCoverage: { fullyPricedEvents: 1, partiallyPricedEvents: 0, unpricedEvents: 0 },
        allowanceWeighting: order.flatMap(key => block(costs[key])) }],
      allowanceCapacity: { status: "available", reason: null, basisFamilyId: family, selectedScenario: selected,
        unknownSpeedPolicy: policy, planScope: scope,
        accountAttribution: { status: "historical_unattributed", maySpanMultipleAccounts: true },
        scenarios: { [standard]: null, [fast]: null, [custom]: null, [selected]: {
          basisId: basis, medianCapacityUsd: 1030, plausibleRangeUsd: { lower: 1000, upper: 1100 },
          qualifyingResets: 3, cohortId: scope.cohortId,
          validation: { sameResetHoldoutMeanAbsoluteErrorPercentagePoints: 1,
            priorResetMeanAbsoluteErrorPercentagePoints: 2, priorResetAbsoluteBiasPercentagePoints: 0,
            forecastErrorP80PercentagePoints: 3, scoredPriorResets: 2, scoredPriorPoints: 8 } } } },
      planScoped: { schemaVersion: "local-plan-scoped-accounting-timeline-v2", status: "available", reason: null,
        encoding: "plan_bucket_v2", planScope: scope,
        usage: [[Date.parse("2026-10-01T00:00:00Z"),1,100,0,0,0,0,0,10,10,20,0,0,1,0,100,10.3]],
        quota: [], observedQuota: [], comparisonIntervals: [[Date.parse("2026-10-01T00:00:00Z"), Date.parse("2026-10-01T00:15:00Z")]] } } };
}

test("selected custom capacity and exact published ratio survive browser projection without requiring endpoint fits", () => {
  const result = normalizeDashboardPayload(fixture()).timeline;
  assert.equal(result.allowanceCapacity.status, "available");
  assert.equal(result.allowanceCapacity.selectedScenario, custom);
  assert.equal(result.allowanceCapacity.scenarios[standard], null);
  assert.equal(result.allowanceCapacity.scenarios[fast], null);
  assert.deepEqual(result.unknownSpeedPolicy, { mode: "custom", customFastRatioBps: 300 });
  assert.equal(result.usage[0].allowanceWeighting.selectedUsd, 10.3);
  assert.equal(result.planScoped.status, "available");
  assert.equal(result.planScoped.usage[0].allowanceWeighting.selectedUsd, 10.3);
  assert.equal(result.usage[0].apiPriceEquivalentUsd, 10);
});

test("ratio identity changes cannot authorize a different custom capacity", () => {
  const input = fixture();
  input.timeline.allowanceCapacity.unknownSpeedPolicy.customFastRatioBps = 500;
  const result = normalizeDashboardPayload(input).timeline;
  assert.equal(result.allowanceCapacity.status, "unavailable");
});

test("new normalization refuses old encoding and incomplete or malformed policy", () => {
  for (const mutate of [
    x => { delete x.timeline.allowanceWeightingEncoding.unknownSpeedPolicy; },
    x => { x.timeline.allowanceWeightingEncoding.schemaVersion = "quota-weighted-timeline-v0.1"; },
    x => { x.timeline.allowanceWeightingEncoding.unknownSpeedPolicy.customFastRatioBps = 10001; },
    x => { x.timeline.allowanceWeightingEncoding.unknownSpeedPolicy.extra = true; },
  ]) {
    const input = fixture(); mutate(input);
    const result = normalizeDashboardPayload(input).timeline;
    assert.ok(result.usage.every(row => row.allowanceWeighting === null));
    assert.equal(result.planScoped.status, "unavailable");
  }
});

test("Standard and Fast selected capacities use independent published policies", () => {
  for (const mode of ["standard", "fast"]) {
    const result = normalizeDashboardPayload(fixture({ mode, customFastRatioBps: null })).timeline;
    assert.equal(result.allowanceCapacity.status, "available");
    assert.equal(result.usage[0].allowanceWeighting.selectedUsd, mode === "standard" ? 10 : 20);
    assert.equal(result.planScoped.usage[0].allowanceWeighting.selectedUsd, mode === "standard" ? 10 : 20);
  }
});


test("published usage and capacity with different custom ratios cannot be compared", () => {
  const input = fixture();
  input.timeline.allowanceCapacity.unknownSpeedPolicy = { mode: "custom", customFastRatioBps: 500 };
  input.timeline.allowanceCapacity.scenarios[custom].basisId = `${family}:${custom}:500`;
  input.timeline.allowanceCapacity.planScope.basisId = `${family}:${custom}:500`;
  const result = normalizeDashboardPayload(input).timeline;
  assert.equal(result.allowanceCapacity.status, "unavailable");
  assert.equal(result.allowanceCapacity.reason, "allowance_capacity_basis_mismatch");
  assert.equal(result.usage[0].allowanceWeighting.selectedUsd, 10.3);
});
