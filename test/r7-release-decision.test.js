import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "../src/export-resource-policy.js";
import {
  R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS as R7_RELEASE_EVIDENCE_DIMENSIONS,
  R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION as R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION,
} from "../src/r7-resource-benchmark-schema.js";
import {
  buildR7ReleaseDecisionReceipt,
  buildR7ReleaseDecisionRows,
} from "../src/r7-release-decision.js";

function boundaryRows(identified = []) {
  const selected = new Set(identified);
  return R7_RELEASE_EVIDENCE_DIMENSIONS.map((dimension) => ({
    dimension,
    selectedLimit: DEFAULT_EXPORT_RESOURCE_LIMITS[
      R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[dimension]
    ],
    identification: selected.has(dimension) ? "identified" : "not_identified",
  }));
}

function materializedPair(identified = []) {
  const profileEvidence = {
    harnessMetrics: {
      parentElapsedMs: 100,
      externalPeakRssBytes: 100,
      childMaxRssBytes: 100,
      durablePeakRssBytes: 100,
      filesystem: { sampledHighWaterBytes: 100 },
    },
  };
  return {
    node24: { boundaries: boundaryRows(identified), profileEvidence },
    node26: { boundaries: boundaryRows(identified), profileEvidence },
  };
}

function realReceipt(multiplier) {
  return {
    profileEvidence: { coveredDurationMs: 1000 * multiplier },
    operations: [{
      metrics: {
        sourceFiles: 10 * multiplier,
        sourceBytes: 100 * multiplier,
        outputRecords: 20 * multiplier,
        decodedBytes: 200 * multiplier,
        encodedBytes: 150 * multiplier,
        parentElapsedMs: 30 * multiplier,
        externalPeakRssBytes: 300 * multiplier,
        childMaxRssBytes: 250 * multiplier,
        durablePeakRssBytes: 275 * multiplier,
      },
    }],
  };
}

test("R7 v0.1 receipt generation is retired before reading option getters", () => {
  let inputGetterRead = false;
  const options = Object.defineProperty({}, "inputReceiptPairs", {
    enumerable: true,
    get() {
      inputGetterRead = true;
      throw new Error("option getter must not run");
    },
  });

  assert.throws(
    () => buildR7ReleaseDecisionReceipt(options),
    (error) => error?.code === "r7_v0_1_receipt_generation_retired",
  );
  assert.equal(inputGetterRead, false);
});

test("R7 decision rows expose evidence but stay unresolved without a frozen rounding rule", () => {
  const rows = buildR7ReleaseDecisionRows({
    materializedBoundaries: materializedPair(["source_files"]),
    realLocalHistory: { node24: realReceipt(1), node26: realReceipt(2) },
    inputsPromotionReady: true,
  });
  const sourceFiles = rows.find(({ dimension }) => dimension === "source_files");
  assert.equal(sourceFiles.exactBoundaryValue, "not_identified");
  assert.equal(sourceFiles.decision, "unresolved");
  assert.equal(sourceFiles.selectionBasis, "not_identified");
  assert.equal(sourceFiles.decidedValue, "not_set");
  assert.equal(sourceFiles.realHistoryValue, 20);

  const sourceBytes = rows.find(({ dimension }) => dimension === "source_bytes");
  assert.equal(sourceBytes.decision, "unresolved");
  assert.equal(sourceBytes.selectionBasis, "not_identified");
  assert.equal(sourceBytes.decidedValue, "not_set");
  assert.equal(sourceBytes.realHistoryValue, 200);

  const directoryEntries = rows.find(({ dimension }) => dimension === "directory_entries");
  assert.equal(directoryEntries.decision, "unresolved");
  assert.equal(directoryEntries.realHistoryValue, "not_identified");
});

test("one-runtime boundary evidence remains unresolved", () => {
  const materializedBoundaries = materializedPair();
  materializedBoundaries.node24.boundaries = boundaryRows(["rss"]);
  const rows = buildR7ReleaseDecisionRows({
    materializedBoundaries,
    realLocalHistory: { node24: realReceipt(1), node26: realReceipt(2) },
  });
  const rss = rows.find(({ dimension }) => dimension === "rss");
  assert.equal(rss.exactBoundaryValue, "not_identified");
  assert.equal(rss.decision, "unresolved");
  assert.equal(rss.realHistoryValue, 600);
});

test("sampled filesystem lower bounds cannot establish twenty-percent resource headroom", () => {
  const materializedBoundaries = materializedPair(["source_files"]);
  materializedBoundaries.node26.profileEvidence = structuredClone(
    materializedBoundaries.node26.profileEvidence,
  );
  materializedBoundaries.node26.profileEvidence.harnessMetrics.parentElapsedMs =
    DEFAULT_EXPORT_RESOURCE_LIMITS.maximumElapsedMs;
  const rows = buildR7ReleaseDecisionRows({
    materializedBoundaries,
    realLocalHistory: { node24: realReceipt(1), node26: realReceipt(2) },
  });
  const sourceFiles = rows.find(({ dimension }) => dimension === "source_files");
  assert.equal(sourceFiles.exactBoundaryValue, "not_identified");
  assert.equal(sourceFiles.decision, "unresolved");
});
