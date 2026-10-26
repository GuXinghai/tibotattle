import {
  R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES,
  R7_WORKER_MAXIMUM_STDIN_BYTES,
} from "./r7-worker-watchdog.js";

export const R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES =
  R7_WORKER_MAXIMUM_STDIN_BYTES - R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES;
export const R7_REAL_HISTORY_GENERATION_RETIRED_CODE =
  "r7_v0_1_receipt_generation_retired";

export class R7RealHistoryEligibilityError extends Error {
  constructor() {
    super("R7 real-history profile is not runnable with the bounded private-plan transport");
    this.name = "R7RealHistoryEligibilityError";
    this.code = "r7_real_history_source_plan_input";
  }
}

function retiredGeneration() {
  throw Object.assign(new Error("R7 v0.1 receipt generation is retired"), {
    code: R7_REAL_HISTORY_GENERATION_RETIRED_CODE,
  });
}

export function assertR7RealHistorySourcePlanEligibility(summary) {
  if (!summary || !Number.isSafeInteger(summary.canonicalBytes)
      || summary.canonicalBytes < 1) {
    throw new TypeError("R7 real-history source-plan summary is invalid");
  }
  if (summary.canonicalBytes > R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES) {
    throw new R7RealHistoryEligibilityError();
  }
  return summary;
}

// The frozen v0.1 evidence contract records retired provider/callback work.
// Preserve its historical validators, but reject all new generation before
// paths, fixtures, profiles, or child processes can be touched.
export async function runR7RealHistoryEvidence() {
  retiredGeneration();
}

export function buildR7RealHistoryReceipts() {
  retiredGeneration();
}

export async function runR7RealHistoryBenchmark() {
  retiredGeneration();
}
