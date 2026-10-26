import { DEFAULT_EXPORT_RESOURCE_LIMITS } from "./export-resource-policy.js";
import {
  R7_RESOURCE_BENCHMARK_BOUNDARY_DIMENSIONS as R7_RELEASE_EVIDENCE_DIMENSIONS,
  R7_RESOURCE_BENCHMARK_LIMIT_KEY_BY_DIMENSION as R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION,
  R7_RESOURCE_BENCHMARK_UNIT_BY_DIMENSION as R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION,
} from "./r7-resource-benchmark-schema.js";

export const R7_RELEASE_DECISION_VERSION = "g1-r7-release-decision-v0.1";

function materializedHeadroomPassed(pair) {
  // A 100 ms sampled filesystem lower bound cannot prove release headroom.
  // Keep boundary identification open until a producer-enforced maximum exists.
  void pair;
  return false;
}

function identifiedBoundary(pair, dimension) {
  if (!materializedHeadroomPassed(pair)) return "not_identified";
  const rows = [pair.node24, pair.node26].map((receipt) => (
    receipt.boundaries.find((row) => row.dimension === dimension)
  ));
  if (rows.some((row) => !row || row.identification !== "identified")) {
    return "not_identified";
  }
  return rows[0].selectedLimit === rows[1].selectedLimit
    ? rows[0].selectedLimit : "not_identified";
}

function maximumPositive(values) {
  const usable = values.filter((value) => Number.isSafeInteger(value) && value > 0);
  return usable.length > 0 ? Math.max(...usable) : "not_identified";
}

function realHistoryValue(pair, dimension) {
  const receipts = [pair.node24, pair.node26];
  if (dimension === "covered_duration") {
    return maximumPositive(receipts.map((receipt) => receipt.profileEvidence.coveredDurationMs));
  }
  const operations = receipts.flatMap((receipt) => receipt.operations);
  const fieldByDimension = {
    source_files: "sourceFiles",
    source_bytes: "sourceBytes",
    output_records_export_set: "outputRecords",
    export_set_decoded_bytes: "decodedBytes",
    export_set_encoded_bytes: "encodedBytes",
    elapsed_time: "parentElapsedMs",
  };
  if (dimension === "rss") {
    return maximumPositive(operations.flatMap(({ metrics }) => [
      metrics.externalPeakRssBytes,
      metrics.childMaxRssBytes,
      metrics.durablePeakRssBytes,
    ]));
  }
  const field = fieldByDimension[dimension];
  return field
    ? maximumPositive(operations.map(({ metrics }) => metrics[field]))
    : "not_identified";
}

export function buildR7ReleaseDecisionRows({
  materializedBoundaries,
  realLocalHistory,
  inputsPromotionReady = false,
}) {
  return R7_RELEASE_EVIDENCE_DIMENSIONS.map((dimension) => {
    const candidateValue = DEFAULT_EXPORT_RESOURCE_LIMITS[
      R7_RELEASE_EVIDENCE_LIMIT_KEY_BY_DIMENSION[dimension]
    ];
    const exactBoundaryValue = identifiedBoundary(materializedBoundaries, dimension);
    const observedRealHistoryValue = realHistoryValue(realLocalHistory, dimension);
    // The frozen rule is the lowest of candidate, exact materialized boundary,
    // and independently identified real history plus 20% headroom rounded down
    // to a stable engineering boundary. Real-history receipts do not yet carry
    // either per-dimension independence/stop evidence or a specified rounding
    // grid. Report observations, but fail closed instead of selecting a value.
    const stableEngineeringBoundary = "not_identified";
    const selectionInputsComplete = inputsPromotionReady
      && exactBoundaryValue !== "not_identified"
      && observedRealHistoryValue !== "not_identified"
      && stableEngineeringBoundary !== "not_identified";
    return {
      dimension,
      unit: R7_RELEASE_EVIDENCE_UNIT_BY_DIMENSION[dimension],
      candidateValue,
      exactBoundaryValue,
      realHistoryValue: observedRealHistoryValue,
      selectionBasis: selectionInputsComplete ? "candidate" : "not_identified",
      decision: selectionInputsComplete ? "retain" : "unresolved",
      decidedValue: selectionInputsComplete ? candidateValue : "not_set",
    };
  });
}

export function buildR7ReleaseDecisionReceipt() {
  const error = new Error("r7_v0_1_receipt_generation_retired");
  error.code = "r7_v0_1_receipt_generation_retired";
  throw error;
}
