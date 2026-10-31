import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import { CODEX_PLAN_TYPES, REVIEWED_CODEX_MODEL_IDS } from "@app-usagemonitor/codex-catalog";
import { exportSchemas, validateExportRecord } from "../src/export-schema.js";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { buildLocalExportContract, serializeLocalExportContract } from "../scripts/generate-local-export-contract.js";
import { exportDeletionJournalChunkBasenames } from "../src/export/index.js";
import * as localRuntime from "../src/local-node-runtime.js";

const root = new URL("../", import.meta.url);

test("current local contract dictionary is deterministic and has no sharing policy", async () => {
  const dictionary = await buildLocalExportContract();
  assert.equal(await readFile(new URL("generated/local-export-v1-field-dictionary.json", root), "utf8"), serializeLocalExportContract(dictionary));
  assert.equal(dictionary.contractVersion, "local-export-field-dictionary-v1");
  assert.ok(dictionary.fields.length > 0);
  for (const field of dictionary.fields) {
    assert.equal(field.publicEligibility, "not_authorized_local_export_only");
    assert.equal(Object.hasOwn(field, "claudeProvenance"), false);
  }
  const tuple = exportCompatibilityTuple();
  assert.deepEqual(tuple.contract, { family: "local-export-v1", status: "local_only", transportReady: false, backwardCompatibility: "none" });
  assert.equal(Object.hasOwn(tuple, "consent"), false);
  assert.deepEqual(Object.keys(tuple.providerAdapters), ["openaiCodex"]);
  assert.equal(validateExportRecord("compatibility", tuple).valid, true);
  for (const mutate of [
    value => { value.tupleVersion = "usage-export-compatibility-v0.1"; },
    value => { value.consent = { status: "approved" }; },
    value => { value.providerAdapters.anthropicClaudeCode = value.providerAdapters.openaiCodex; },
    value => { value.contract.transportReady = true; },
  ]) {
    const candidate = structuredClone(tuple); mutate(candidate);
    assert.equal(validateExportRecord("compatibility", candidate).valid, false);
  }
});

test("local export schema uses the independent reviewed model and plan vocabularies", () => {
  assert.deepEqual(exportSchemas.usageEvent.properties.modelId.enum, ["unknown", ...REVIEWED_CODEX_MODEL_IDS]);
  assert.deepEqual(exportSchemas.quotaSnapshot.properties.planType.enum, [...CODEX_PLAN_TYPES]);
  const snapshot = {
    schemaVersion: "local-quota-snapshot-v1", observedTime: "2026-10-31T00:00:00.000Z", receivedTime: "2026-10-31T00:00:01.000Z",
    provider: "openai_codex", planType: "sci", planVariant: "unknown", limitId: "codex", slot: "primary",
    usedPercent: 17, displayPrecision: 0, windowDurationMinutes: 300, resetsAt: "2026-10-31T05:00:00.000Z",
    snapshotSource: "app_server_read", providerSurface: "account_shared_unallocated",
    snapshotId: `snapshot:v2:${"1".repeat(64)}`, providerStateId: `quota-state:v1:${"2".repeat(64)}`,
    sessionScopeId: null, accountScopeId: "unattributed",
  };
  for (const planType of ["sci", "sci_plus", "unknown"]) {
    assert.equal(validateExportRecord("quotaSnapshot", { ...snapshot, planType }).valid, true);
  }
  for (const mutate of [
    value => { value.schemaVersion = "quota-snapshot-v0.1"; },
    value => { value.provider = "anthropic_claude_code"; },
    value => { value.planType = "private-plan-canary"; },
    value => { value.prompt = "private-content-canary"; },
    value => { value.capacity = 1000; },
  ]) {
    const candidate = structuredClone(snapshot); mutate(candidate);
    const result = validateExportRecord("quotaSnapshot", candidate);
    assert.equal(result.valid, false);
    assert.doesNotMatch(JSON.stringify(result.errors), /private-(?:content|plan)-canary/);
  }
});

test("retired telemetry source, schemas, generators and entrypoints cannot return", async () => {
  for (const path of [
    "packages/telemetry-contract/package.json", "src/contribution/index.js", "src/platform/telemetry-envelope.js",
    "src/telemetry-contribution-builder.js", "src/telemetry-prepared-set.js", "src/contribution-device-sync.js",
    "scripts/generate-telemetry-contract.js", "scripts/generate-telemetry-browser-mirror.js", "scripts/build-telemetry-contributions.js",
    "schemas/telemetry-v0.1/bundle.schema.json", "schemas/export-set-v0.3/manifest.schema.json",
    "generated/telemetry-v0.1-compatibility.json", "apps/web/public/telemetry-shared.generated.js",
  ]) await assert.rejects(access(new URL(path, root)), { code: "ENOENT" }, path);
  assert.equal(Object.hasOwn(localRuntime, "localContributionSyncQueue"), false);
  const metadata = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(Object.hasOwn(metadata.dependencies, "@app-usagemonitor/telemetry-contract"), false);
  for (const alias of Object.keys(metadata.scripts)) assert.doesNotMatch(alias, /^telemetry:|^product:prepare-contribution$|^product:local:acceptance$/);
});

test("old deletion journal resolution is bounded filenames only, not an old export reader", () => {
  assert.deepEqual(exportDeletionJournalChunkBasenames(0, "usage-export-set-manifest-v0.1"), { bundle: "chunk-000000.bundle.json", receipt: "chunk-000000.receipt.json" });
  assert.equal(exportDeletionJournalChunkBasenames(1, "usage-export-set-manifest-v0.2").bundle, "chunk-000001.bundle.json.gz");
  for (const index of [-1, 512, 1.5, "../private"]) assert.throws(() => exportDeletionJournalChunkBasenames(index, "usage-export-set-manifest-v0.1"), RangeError);
  assert.throws(() => exportDeletionJournalChunkBasenames(0, "unknown"), RangeError);
});
