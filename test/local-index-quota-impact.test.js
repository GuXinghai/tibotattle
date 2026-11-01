import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  quotaDependencyPartitions,
  sourceImpactSummary,
} from "../src/local-index-impact.js";
import {
  createLocalIndexWriter,
  openLocalIndexStore,
} from "../src/local-index-store.js";

test("a changed canonical quota observation expands to every referencing source", () => {
  const root = mkdtempSync(join(tmpdir(), "local-index-quota-impact-"));
  const file = join(root, "index.sqlite");
  const database = openLocalIndexStore(file, { create: true });
  const writer = createLocalIndexWriter(database);
  try {
    writer.begin();
    const sessionId = writer.internSession(Buffer.alloc(32, 8), null);
    const modelId = writer.internModel("gpt-5.5", "recognized");
    const tierId = writer.internTier({
      apiServiceTier: "standard", billingSurface: "subscription",
      codexSpeedMode: "standard", tierSource: "observed", providerTierRaw: null,
    });
    const surfaceId = writer.internSurface({
      agentScope: "root", surface: "codex", threadSource: "cli",
      lineageDisposition: "standalone",
    });
    const accountScopeId = writer.internAccountScope({
      status: "available", reason: null, planType: "plus", scopeLocal: Buffer.alloc(32, 4),
    });
    const quotaId = writer.internQuota({
      observedAtMs: 1_000, limitId: "codex", slot: "primary", planType: "plus",
      usedPercent: 10, resetsAtMs: 10_000, durationMins: 10_080,
    });
    const sources = [1, 2].map((ordinal) => writer.registerSource({
      sourceLocal: Buffer.alloc(32, ordinal), ordinal, sessionId, surfaceId,
      path: `synthetic-${ordinal}.jsonl`, rolloutKey: `synthetic-${ordinal}`,
      sizeBytes: 200, mtimeMs: 1,
    }).id);
    for (const [index, sourceId] of sources.entries()) {
      writer.writeUsageEvent({
        sourceId, sourceOffset: 100, observedAtMs: 1_000 + index * 500,
        eventKey: Buffer.alloc(32, 10 + index), sessionId, accountScopeId,
        modelId, tierId, surfaceId, quotaObservationId: quotaId,
        reasoningEffort: 1, tokensInUncached: 50, tokensInCacheRead: 20,
        tokensOutCombined: 5,
      });
      writer.writeQuotaOccurrence({
        sourceId, sourceOffset: 100, slotOrder: 0, surfaceId,
        canonicalObservationId: quotaId, observedAtMs: 1_000, provider: "openai_codex",
        planType: "plus", limitId: "codex", slot: "primary", usedPercent: 10,
        resetsAtMs: 10_000, durationMins: 10_080, admission: "admitted",
      });
      writer.commitSourceState(sourceId, {
        sessionId, surfaceId, path: `synthetic-${index + 1}.jsonl`,
        rolloutKey: `synthetic-${index + 1}`, sizeBytes: 200, mtimeMs: 1,
        scannedBytes: 150, diagnostics: { tokenCounts: 1 },
      });
    }
    writer.commit();

    const summary = sourceImpactSummary(database, {
      sourceId: sources[0], sessionId,
    });
    assert.ok(summary.quota.ids.has(quotaId));
    const { partitions, truncated } = quotaDependencyPartitions(database, {
      oldIds: [quotaId], newIds: [], sessionId,
    });
    assert.equal(truncated, false);
    const quota = partitions.find((row) => row.partitionKind === "quota_observation");
    assert.equal(quota.partitionKey, `quota_observation:${quotaId}`);
    assert.equal(quota.basisKind, "canonical_dependency");
    assert.equal(quota.lowerMs, 1_000);
    assert.equal(quota.upperMs, 1_500);
    const usage = partitions.filter((row) => row.partitionKind === "usage_time_range");
    assert.deepEqual(
      usage.map((row) => row.partitionKey).sort(),
      [`usage_time_range:${sources[0]}:${sessionId}`,
        `usage_time_range:${sources[1]}:${sessionId}`].sort(),
    );
    assert.deepEqual(usage.map((row) => row.lowerMs).sort(), [1_000, 1_500]);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
