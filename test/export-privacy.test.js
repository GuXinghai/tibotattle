import test from "node:test";
import assert from "node:assert/strict";
import { inspectSensitiveExportStrings, verifyPrivacySafeBundle } from "../src/export-privacy.js";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { localSafeRecords } from "../src/local-node-runtime.js";
import { deriveEventOccurrenceId, deriveSessionScopeId } from "../src/export-identity.js";

const {
  normalizeCodexCollectorQuotaCandidate,
} = localSafeRecords;

const SECRET = Buffer.alloc(32, 51);

function bundleWithQuota(snapshot) {
  return {
    schemaVersion: "local-usage-metadata-bundle-v1",
    compatibility: exportCompatibilityTuple(),
    bundleId: `bundle:v1:${"a".repeat(64)}`,
    participantId: `participant:v1:${"b".repeat(64)}`,
    createdAt: "2026-07-24T13:00:00.000Z",
    coveredAt: { startAt: "2026-07-24T12:00:00.000Z", endAt: "2026-07-24T13:00:00.000Z" },
    sourceProviders: [snapshot.provider],
    clientPlatform: "windows",
    transportReady: false,
    recordCounts: { usageEvents: 0, quotaSnapshots: 1, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [snapshot], activityMarkers: [] },
    diagnostics: { sourceFilesScanned: 1, codes: [] },
  };
}

function bundleWithUsage(usage) {
  const bundle = bundleWithQuota(usage);
  bundle.recordCounts = { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 };
  bundle.records = { usageEvents: [usage], quotaSnapshots: [], activityMarkers: [] };
  return bundle;
}

test("sensitive string scanner recognizes common content and credential shapes", () => {
  const findings = inspectSensitiveExportStrings({
    a: "adam@example.com",
    b: "https://private.example/thread",
    c: "/Users/adam/private-repo",
    d: "Bearer abcdefghijklmnopqrstuvwxyz",
  });
  assert.deepEqual(new Set(findings.map((finding) => finding.code)), new Set([
    "email_address", "web_url", "absolute_user_path", "bearer_token",
  ]));
});

test("privacy gate fails closed without echoing the sensitive value", () => {
  const sensitive = "canary-private-value";
  const invalidBundle = {
    bundleId: `bundle:v1:${"a".repeat(64)}`,
    participantId: `participant:v1:${"b".repeat(64)}`,
    coveredAt: {},
    recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [], activityMarkers: [] },
    leaked: sensitive,
  };
  assert.throws(
    () => verifyPrivacySafeBundle(invalidBundle, { forbiddenSourceValues: [sensitive] }),
    (error) => error.message.includes("failed closed") && !error.message.includes(sensitive),
  );
});

test("privacy failures expose only fixed sensitive-pattern codes", () => {
  const invalidBundle = {
    bundleId: `bundle:v1:${"a".repeat(64)}`,
    participantId: `participant:v1:${"b".repeat(64)}`,
    coveredAt: {},
    recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
    records: { usageEvents: [], quotaSnapshots: [], activityMarkers: [] },
    leaked: "https://private.example/path",
  };
  assert.throws(
    () => verifyPrivacySafeBundle(invalidBundle),
    (error) => error.message.includes("sensitive=web_url")
      && error.message.includes("private.example") === false
      && error.message.includes("/records/") === false,
  );
});

test("source canaries detect JSON-escaped quote, slash and newline values without exposing them", () => {
  for (const sensitive of ['private-"quoted"-value', "private-\\escaped-value", "private-\nmultiline-value"]) {
    const bundle = {
      bundleId: `bundle:v1:${"a".repeat(64)}`, participantId: `participant:v1:${"b".repeat(64)}`,
      coveredAt: {}, recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
      records: { usageEvents: [], quotaSnapshots: [], activityMarkers: [] }, leaked: sensitive,
    };
    assert.throws(() => verifyPrivacySafeBundle(bundle, { forbiddenSourceValues: [sensitive] }),
      (error) => error.message.includes("source_value_canaries") && !error.message.includes(sensitive));
  }
});

test("privacy gate accepts the implemented OpenAI collector quota family", () => {
  const snapshot = normalizeCodexCollectorQuotaCandidate(SECRET, {
    candidateVersion: "codex-collector-quota-candidate-v0.1",
    kind: "quota_snapshot_candidate",
    provider: "openai_codex",
    observedTime: "2026-07-24T12:02:00.000Z",
    receivedTime: "2026-07-24T12:02:01.000Z",
    source: "app_server_read",
    planType: "pro",
    limitId: "codex",
    slot: "secondary",
    usedPercent: 12,
    displayPrecision: 0,
    windowDurationMinutes: 10_080,
    resetsAt: "2026-07-31T12:00:00.000Z",
    sharedPoolSurface: "account_shared_unallocated",
    accountScopeSubject: "unattributed",
    sessionScopeId: null,
    observationIdentityMaterial: "c".repeat(64),
  });
  assert.equal(verifyPrivacySafeBundle(bundleWithQuota(snapshot)).verdict, "passed");
});

test("hex-derived identifiers pass the scanner and credential-shaped ID values fail closed", () => {
  const usage = {
    schemaVersion: "local-usage-event-v1",
    eventTime: "2026-07-24T12:02:00.000Z",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: 1,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 1,
      outputReasoningTokens: 0,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: 1,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: {
      webSearch: 0, fileSearch: 0, codeInterpreter: 0, hostedShell: 0,
      computerUse: 0, mcp: 0, applyPatch: 0, localShell: 0,
      subagent: 0, toolGateway: 0, other: 0, unknown: 0,
    },
    outcome: "unknown",
    eventId: deriveEventOccurrenceId(SECRET, "privacy-regression-event"),
    sessionScopeId: deriveSessionScopeId(SECRET, "privacy-regression-session"),
    accountScopeId: "unattributed",
  };
  assert.match(usage.eventId, /^event:v2:[a-f0-9]{64}$/u);
  assert.equal(inspectSensitiveExportStrings(usage).some(({ code }) => code === "common_api_key"), false);
  assert.equal(verifyPrivacySafeBundle(bundleWithUsage(usage)).verdict, "passed");

  const credentialShaped = structuredClone(usage);
  credentialShaped.eventId = `event:v2:sk-${"A".repeat(40)}`;
  assert.equal(
    inspectSensitiveExportStrings(credentialShaped).some(({ code, path }) =>
      code === "common_api_key" && path === "/eventId"),
    true,
  );
  assert.throws(
    () => verifyPrivacySafeBundle(bundleWithUsage(credentialShaped)),
    (error) => error.message.includes("schema_allowlist")
      && error.message.includes("sensitive_string_scan")
      && error.message.includes("common_api_key")
      && error.message.includes("sk-") === false,
  );
});
