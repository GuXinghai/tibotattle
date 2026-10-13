import { openLocalIndexStore, createLocalIndexWriter } from "../../src/local-index-store.js";
import { createLocalIndexBackend } from "../../src/local-index-backend.js";

export const ATTRIBUTION_FIXTURE_DAY = "2026-08-01";
export const ATTRIBUTION_FIXTURE_START = Date.parse(`${ATTRIBUTION_FIXTURE_DAY}T12:00:00.000Z`);
export const ATTRIBUTION_FIXTURE_DEVICE_ID = "11111111-1111-4111-8111-111111111111";
export const ATTRIBUTION_FIXTURE_BINDING = Object.freeze({
  destinationOrigin: "https://usage.example", enrollmentNamespace: "synthetic_enrollment_0001",
});

export function attributionFixtureMarker(overrides = {}) {
  return {
    version: "provisional-account-marker-v2", source: "app_server_read",
    capturedAt: new Date(ATTRIBUTION_FIXTURE_START - 1).toISOString(),
    receivedAt: new Date(ATTRIBUTION_FIXTURE_START + 2_000).toISOString(),
    accountScope: { status: "available", reason: null, version: "openai-account-v1",
      scopeId: `openai-account:v1:${Buffer.alloc(32, 7).toString("base64url")}`, planType: "pro" },
    observationBinding: ATTRIBUTION_FIXTURE_BINDING, ...overrides,
  };
}

/** The contribution seams exactly as the composition root wires them over the v2 store. */
export function attributionFixtureSeams() {
  const { openIndex, createIndexReader, createV11Reader, readPublication } = createLocalIndexBackend({
    indexFile: "unused-index.sqlite",
  }).contribution;
  return { openIndex, createIndexReader, createV11Reader, readPublication };
}

/** Synthetic, content-free schema-11-equivalent publication through the v2 writer. */
export async function writeAttributionFixture(
  file,
  { plans = ["pro", "plus"], observedAtMs = ATTRIBUTION_FIXTURE_START, boundaryFlags = [] } = {},
) {
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new TypeError("observedAtMs must be a non-negative safe integer");
  }
  const database = openLocalIndexStore(file, { create: true });
  try {
    const writer = createLocalIndexWriter(database);
    writer.begin();
    const sourceLocal = Buffer.alloc(32, 1);
    const sessionLocal = Buffer.alloc(32, 21);
    const sessionId = writer.internSession(sessionLocal, "11111111-2222-4333-8444-000000000001");
    const accountScopeId = writer.internAccountScope({
      status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null,
    });
    const modelId = writer.internModel("gpt-5.6-sol", "recognized");
    const tierId = writer.internTier({ apiServiceTier: "unknown", billingSurface: "chatgpt_subscription",
      codexSpeedMode: "standard", tierSource: "unknown", providerTierRaw: null });
    const surfaceId = writer.internSurface({ agentScope: "root", surface: "cli_exec",
      threadSource: "user", lineageDisposition: "standalone" });
    const { id: sourceId } = writer.registerSource({ sourceLocal, sessionId, surfaceId,
      path: "synthetic-rollout", rolloutKey: "synthetic-rollout", sizeBytes: 4096, mtimeMs: observedAtMs });
    writer.commitSourceState(sourceId, { sessionId, surfaceId, path: "synthetic-rollout",
      rolloutKey: "synthetic-rollout", sizeBytes: 4096, mtimeMs: observedAtMs, scannedBytes: 4096,
      snapshotsPersisted: true, turnContextSeen: true, carryModel: "gpt-5.6-sol", carryEffort: "high",
      diagnostics: {} });
    for (const [index, planType] of plans.entries()) {
      const eventKey = Buffer.alloc(32); eventKey.writeUInt32BE(index + 1, 28);
      const eventObservedAtMs = observedAtMs + index * 1_000;
      const window = { observedAtMs: eventObservedAtMs, limitId: "codex", slot: "secondary", planType,
        usedPercent: 10 + index, resetsAtMs: observedAtMs + 604_800_000, durationMins: 10_080 };
      const canonicalObservationId = writer.internQuota(window);
      writer.writeQuotaOccurrence({ sourceId, sourceOffset: index + 1, slotOrder: 0, surfaceId,
        canonicalObservationId, ...window, provider: "openai_codex", admission: "admitted" });
      writer.writeUsageEvent({ sourceId, sourceOffset: index + 1, observedAtMs: eventObservedAtMs,
        eventKey, sessionId, accountScopeId, modelId, tierId, surfaceId,
        quotaObservationId: canonicalObservationId, tierObservedAtMs: null, reasoningEffort: 4,
        tokensInUncached: 10, tokensInCacheRead: 20, tokensInCacheWrite: 0, tokensOutText: 1,
        tokensOutReasoning: 0, tokensOutCombined: null, totalInputContext: null });
      const flags = boundaryFlags[index] ?? 0;
      if (flags) writer.writeBoundary({ sourceId, sourceOffset: index + 1,
        compactionBefore: Boolean(flags & 2), turnContextBefore: Boolean(flags & 1),
        compactedAtMs: flags & 2 ? eventObservedAtMs - 1 : null });
    }
    writer.writeToolFact({ sourceId, sourceOffset: 1, toolOrdinal: 0, eventKey: Buffer.alloc(32, 71),
      sessionId, observedAtMs, toolClass: "localShell", sourceKind: "response_item" });
    writer.commit({ kind: "cold" });
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* the open transaction, if any, is already closed */ }
    throw error;
  } finally {
    database.close();
  }
}
