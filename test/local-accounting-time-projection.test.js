import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createWorkspace } from "./helpers/local-index-facts.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { readLocalIndexGenerationIdentity } from "../src/local-index-companion-source.js";
import { buildLocalIndexAccountingCache, projectLocalIndexAccountingTime } from "../src/local-index-accounting-cache.js";
import { assertReplaySafeAccountingCache, buildReplaySafeAccountingCache, projectReplaySafeAccountingTime } from "../src/replay-safe-accounting-cache.js";
import { withResidentCalibration, TEST_GENERATION } from "./helpers/replay-safe-resident-calibration.js";

test("time projection matches rebuilt moving results while retaining historical calculation", async t => {
  const workspace = createWorkspace({ files: 3, events: 300, days: 35, fillerBytesPerEvent: 0 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "index.sqlite");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
    secretFile: workspace.secretFile, workerCount: 1 });
  const expectedGeneration = readLocalIndexGenerationIdentity({ indexFile });
  const originalNow = Date.parse("2026-09-01T00:00:00.000Z");
  const options = { indexFile, codexHome: workspace.codexHome, expectedGeneration, windowDays: 365 };
  const original = await buildLocalIndexAccountingCache({ ...options, now: () => originalNow });
  const originalBytes = JSON.stringify(original);
  for (const elapsed of [31 * 60_000, 15 * 86_400_000, 366 * 86_400_000]) {
    const now = () => originalNow + elapsed;
    const updated = await projectLocalIndexAccountingTime({ ...options, cache: original, now });
    const rebuilt = await buildLocalIndexAccountingCache({ ...options, now });
    assertReplaySafeAccountingCache(updated);
    for (const field of ["periods", "timeline", "sparkUsageTimeline", "quotaTimeline", "sparkQuotaTimeline", "weekly", "coveredAt"]) {
      assert.deepEqual(updated[field], rebuilt[field], `${field} at ${elapsed}`);
    }
    assert.equal(updated.generatedAt, original.generatedAt);
    assert.deepEqual(updated.history, original.history);
    assert.deepEqual(updated.weeklyApiIntervals, original.weeklyApiIntervals);
    assert.equal(updated.weeklyCalibration.generatedAt, original.weeklyCalibration.generatedAt);
    assert.deepEqual(updated.weeklyCalibration.composition, rebuilt.weeklyCalibration.composition);
    assert.deepEqual(updated.planScopedTimeline, rebuilt.planScopedTimeline);
    const withoutCalculationClocks = value => JSON.parse(JSON.stringify(value, (key, item) => key === "generatedAt" ? undefined : item));
    assert.deepEqual(withoutCalculationClocks(updated.historicalPlanComparisons), withoutCalculationClocks(rebuilt.historicalPlanComparisons));
    assert.equal(JSON.stringify(original), originalBytes);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(projectLocalIndexAccountingTime({ ...options, cache: original,
    now: () => originalNow + 1, signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(projectLocalIndexAccountingTime({ ...options, cache: original,
    now: () => originalNow - 1 }), { code: "accounting_time_projection_invalid" });
});

test("recent model mix advances without changing the fitted capacity vector", async () => {
  const start = Date.parse("2026-08-10T00:00:00.000Z"), hour = 3_600_000;
  const scan = withResidentCalibration(async ({ onUsage, onRateLimitSnapshot }) => {
    let used = 0;
    const quota = at => onRateLimitSnapshot({ timestamp: new Date(at).toISOString(), timestampMs: at,
      window: { provider: "openai_codex", planType: "pro", limitId: "codex", slot: "primary",
        windowDurationMins: 10080, resetsAt: (start + 7 * 24 * hour) / 1000, usedPercent: used } });
    quota(start);
    for (let bin = 0; bin < 25; bin++) {
      onUsage({ timestamp: new Date(start + (bin * 2 + 0.5) * hour).toISOString(),
        model: bin % 2 ? "gpt-5.6-terra" : "gpt-5.6-sol", totalInputContextTokens: 1000,
        components: { input_uncached_tokens: 2_000_000, input_cache_read_tokens: 0, input_cache_write_tokens: 0,
          output_text_tokens: 0, output_reasoning_tokens: 0, output_combined_tokens: 0 },
        tierSemantics: { codexSpeedMode: "standard", apiServiceTier: "unknown" },
        surfaceClassification: { surface: "extension_or_ide", agentScope: "root", lineageDisposition: "standalone" } });
      used += bin % 2 ? 4 : 1; quota(start + (bin * 2 + 1.5) * hour);
    }
    return { diagnostics: {} };
  }, { startAt: new Date(start).toISOString(), endAt: new Date(start + 50 * hour).toISOString() });
  const options = { scan, calibrationSource: scan.calibrationSource, sourceMode: "unified",
    expectedGeneration: TEST_GENERATION, windowDays: 365 };
  const original = await buildReplaySafeAccountingCache({ ...options, now: () => start + 60 * hour });
  assert.equal(original.weeklyCalibration.composition.status, "fitted");
  for (const hours of [14 * 24 + 24, 16 * 24 + 24]) {
    const now = () => start + hours * hour;
    const projected = await projectReplaySafeAccountingTime({ ...options, cache: original, now });
    const rebuilt = await buildReplaySafeAccountingCache({ ...options, now });
    assert.deepEqual(projected.weeklyCalibration.composition, rebuilt.weeklyCalibration.composition);
    assert.deepEqual(projected.weeklyCalibration.composition.capacityUsdByModel, original.weeklyCalibration.composition.capacityUsdByModel);
    if (hours > 16 * 24) assert.equal(projected.weeklyCalibration.composition.blendedRecentMixUsd, null);
    else assert.notEqual(projected.weeklyCalibration.composition.blendedRecentMixUsd, original.weeklyCalibration.composition.blendedRecentMixUsd);
  }
});
