import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { buildReplaySafeAccountingPeriod } from "../src/replay-safe-accounting-cache.js";

const timestamp = "2026-10-20T12:01:00.000Z";
const base = {
  timestamp, model: "gpt-5.5", totalInputContextTokens: 10000,
  tierSemantics: { codexSpeedMode: "standard", apiServiceTier: "standard" },
  surfaceClassification: { surface: "cli", agentScope: "root", lineageDisposition: "original" },
  components: { input_uncached_tokens: 10001, input_cache_read_tokens: 1003,
    input_cache_write_tokens: 0, output_text_tokens: 7, output_reasoning_tokens: 3,
    output_combined_tokens: null },
};

async function period(rows) {
  return buildReplaySafeAccountingPeriod({ startAt: "2026-10-20T00:00:00.000Z",
    endAt: "2026-10-21T00:00:00.000Z", rss: () => 1, maximumRssBytes: 1000000,
    declaredSpeedBaselines: [{ mode: "fast", firstSeenAt: "2026-10-20T12:00:00.000Z",
      lastSeenAt: "2026-10-20T12:10:00.000Z" }],
    scan: async ({ onUsage }) => { for (const row of rows) await onUsage(row); },
  });
}

for (const fixture of [
  { name: "standard exact fractional prices" },
  { name: "Priority", tierSemantics: { codexSpeedMode: "fast", apiServiceTier: "priority" } },
  { name: "Ultrafast", tierSemantics: { codexSpeedMode: "ultrafast", apiServiceTier: "ultrafast" } },
  { name: "declared speed", tierSemantics: { codexSpeedMode: "unknown", apiServiceTier: "unknown" } },
  { name: "long context", totalInputContextTokens: 300000 },
  { name: "partial evidence", pricingEvidenceIncomplete: true },
  { name: "assumed cache write", componentAvailability: { input_cache_write_tokens: false } },
  { name: "unknown model", model: "unknown-synthetic-model" },
  { name: "Spark", model: "gpt-5.3-codex-spark" },
  { name: "combined output", components: { ...base.components,
    output_text_tokens: null, output_reasoning_tokens: null, output_combined_tokens: 1001 } },
  { name: "missing context and component", totalInputContextTokens: undefined,
    components: { ...base.components, input_uncached_tokens: null } },
  { name: "observed zero input context", totalInputContextTokens: 0 },
]) {
  test(`canonical weighted accounting equals event traversal: ${fixture.name}`, async () => {
    const { name: _name, ...overrides } = fixture;
    const event = { ...base, ...overrides };
    const count = 13;
    const group = { ...event, eventCount: count,
      components: Object.fromEntries(Object.entries(event.components)
        .map(([key, value]) => [key, value === null ? null : value * count])) };
    const actual = await period([group]);
    assert.ok(isDeepStrictEqual(actual, await period(Array.from({ length: count }, () => event))), fixture.name);
    if (fixture.name === "standard exact fractional prices") {
      assert.equal(actual.period.apiPriceEquivalentUsdExact, "0.6604845");
      assert.equal(actual.period.apiPriceEquivalentUsd, 0.660485);
      assert.equal(actual.period.byModel[0].apiPriceEquivalentUsd, 0.660485);
      assert.equal(actual.period.bySpeed.standard.apiPriceEquivalentUsd, 0.660485);
      assert.equal(actual.period.componentCosts.input_cache_read_tokens.costUsd, 0.00652);
    }
  });
}

test("weighted accounting refuses malformed occurrence counts", async () => {
  for (const eventCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(period([{ ...base, eventCount }]),
      error => error.code === "accounting_usage_group_invalid");
  }
});
