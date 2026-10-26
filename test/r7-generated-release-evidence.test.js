import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeR7ReleaseEvidenceReceiptSha256,
  R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256,
  validateHistoricalR7ReleaseEvidenceReceipt,
} from "../src/r7-release-evidence-schema.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GENERATED = join(ROOT, "generated");
const SCHEMA = join(ROOT, "schemas", "r7-release-evidence-v0.1", "receipt.schema.json");
const RUNTIME_SUFFIXES = ["node24.14.0-v0.1.json", "node26.2.0-v0.1.json"];
const PROFILE_NAMES = [
  "synthetic-semantics",
  "synthetic-pressure",
  "materialized-boundaries",
  "real-local-history",
  "decision",
];
const INPUT_PROFILES = Object.freeze({
  syntheticSemantics: "synthetic-semantics",
  syntheticPressure: "synthetic-pressure",
  materializedBoundaries: "materialized-boundaries",
  realLocalHistory: "real-local-history",
});
const EXPECTED_RECEIPT_BYTES_SHA256 = Object.freeze({
  "r7-release-decision-node24.14.0-v0.1.json": "d400061b27583217ce5d438425091912626ccecd9782366d65a2bad2f9db864e",
  "r7-release-decision-node26.2.0-v0.1.json": "83114e32f9c384b708e2c2ace25676e671f03060ab0f2ac9623c004471d3d633",
  "r7-release-materialized-boundaries-node24.14.0-v0.1.json": "49109d7bd7f6588d01e4eabd5f9e48ffe0f6d586038151c8654269a5eef28d76",
  "r7-release-materialized-boundaries-node26.2.0-v0.1.json": "e21ff0e3db7a421fd6353c1f809a2a79dc9711557fc92c51061c09707f526115",
  "r7-release-real-local-history-node24.14.0-v0.1.json": "0a6a2ca314b359c081b34ecf4d4cdab92de71b2f8a16eb2e33071c16d86707f1",
  "r7-release-real-local-history-node26.2.0-v0.1.json": "1c5c95da0c35f295b73efd3358a8f6ec27ee52d019b2fe1eb247cb4a6feb98f6",
  "r7-release-synthetic-pressure-node24.14.0-v0.1.json": "2a2a4e22c2bb8927341c9a153d079c935ccaf646903675a7a9e6d558708d0963",
  "r7-release-synthetic-pressure-node26.2.0-v0.1.json": "aac8e2626d79b6982bc94fd3b36b165c8e2fa9fee91327a6109998b290a9c9f2",
  "r7-release-synthetic-semantics-node24.14.0-v0.1.json": "17bd09605e30bf95a4cbe80a10bf3c385a0820d3ccdde5595ab138a4fafe6c0a",
  "r7-release-synthetic-semantics-node26.2.0-v0.1.json": "0c26c5236687bea8c1ad1c853e70c6db8d8be925d73d0d2357a4822ea43d2cd8",
});
const EXPECTED_FILES = Object.keys(EXPECTED_RECEIPT_BYTES_SHA256).sort();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function filename(profile, runtimeClass) {
  const suffix = runtimeClass === "pinned_candidate"
    ? RUNTIME_SUFFIXES[0] : RUNTIME_SUFFIXES[1];
  return `r7-release-${profile}-${suffix}`;
}

async function readRetainedReceipts() {
  const files = (await readdir(GENERATED))
    .filter((name) => name.startsWith("r7-release-") && name.endsWith(".json"))
    .sort();
  assert.deepEqual(files, EXPECTED_FILES);

  const schemaBytes = await readFile(SCHEMA);
  assert.equal(sha256(schemaBytes), R7_RELEASE_EVIDENCE_RECEIPT_SCHEMA_SHA256, "v0.1 schema bytes");
  const receipts = new Map();
  for (const name of files) {
    const bytes = await readFile(join(GENERATED, name));
    assert.equal(sha256(bytes), EXPECTED_RECEIPT_BYTES_SHA256[name], `${name}: original bytes`);

    const receipt = JSON.parse(bytes.toString("utf8"));
    assert.deepEqual(
      validateHistoricalR7ReleaseEvidenceReceipt(receipt),
      { valid: true, errors: [] },
      name,
    );
    assert.equal(receipt.contractProvenance.receiptSchemaSha256, sha256(schemaBytes), `${name}: schema binding`);
    assert.equal(
      receipt.receiptSha256,
      computeR7ReleaseEvidenceReceiptSha256(receipt),
      `${name}: self hash`,
    );
    receipts.set(name, receipt);
  }
  return receipts;
}

function assertOriginalInputBindings(decision, receipts, name) {
  const expectedInputReceipts = Object.fromEntries(Object.entries(INPUT_PROFILES).map(([key, profile]) => [
    key,
    {
      node24Sha256: receipts.get(filename(profile, "pinned_candidate")).receiptSha256,
      node26Sha256: receipts.get(filename(profile, "compatibility_crosscheck")).receiptSha256,
    },
  ]));
  assert.deepEqual(decision.profileEvidence.inputReceipts, expectedInputReceipts, name);
}

test("retained R7 release receipts preserve original bytes, v0.1 schema, and self hashes", async () => {
  await readRetainedReceipts();
});

test("retained decision receipts bind the original eight runtime input receipts", async () => {
  const receipts = await readRetainedReceipts();
  for (const runtimeClass of ["pinned_candidate", "compatibility_crosscheck"]) {
    const name = filename("decision", runtimeClass);
    assertOriginalInputBindings(receipts.get(name), receipts, name);
  }
});

test("historical readback rejects resealed privacy and metric contradictions", async () => {
  const receipts = await readRetainedReceipts();
  const source = receipts.get(filename("decision", "pinned_candidate"));

  const privacyContradiction = structuredClone(source);
  privacyContradiction.privacy.pathsRetained = true;
  privacyContradiction.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(privacyContradiction);
  const privacyResult = validateHistoricalR7ReleaseEvidenceReceipt(privacyContradiction);
  assert.equal(privacyResult.valid, false);
  assert.ok(privacyResult.errors.some((error) => error.path === "/privacy/pathsRetained"));

  const metricContradiction = structuredClone(source);
  metricContradiction.operations[0].metrics.sourceFiles = 1;
  metricContradiction.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(metricContradiction);
  const metricResult = validateHistoricalR7ReleaseEvidenceReceipt(metricContradiction);
  assert.equal(metricResult.valid, false);
  assert.ok(metricResult.errors.some((error) => error.path === "/operations/0/metrics"));

  const forgedBinding = structuredClone(source);
  forgedBinding.profileEvidence.inputReceipts.syntheticSemantics.node24Sha256 = "0".repeat(64);
  forgedBinding.receiptSha256 = computeR7ReleaseEvidenceReceiptSha256(forgedBinding);
  assert.throws(
    () => assertOriginalInputBindings(forgedBinding, receipts, "forged retained-input binding"),
    assert.AssertionError,
  );
});
