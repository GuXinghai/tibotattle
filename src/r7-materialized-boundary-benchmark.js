export const R7_MATERIALIZED_BOUNDARY_GENERATION_RETIRED_CODE =
  "r7_v0_1_receipt_generation_retired";

export function parseR7MaterializedBoundaryWorkerResult(bytes) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new TypeError("Invalid R7 materialized boundary result");
  }
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort().join("\0") : "";
  if (keys !== "evidence\0failureCode\0status") {
    throw new TypeError("Invalid R7 materialized boundary result");
  }
  if (value.status === "completed" && value.failureCode === "none"
      && value.evidence && typeof value.evidence === "object") {
    return { evidence: value.evidence, failureCode: null };
  }
  if (value.status === "failed" && value.failureCode === "harness_failed"
      && value.evidence === null) {
    return { evidence: null, failureCode: "harness_failed" };
  }
  throw new TypeError("Invalid R7 materialized boundary result");
}

// Keep the standalone Codex boundary worker/parser usable for focused
// synthetic checks, but do not emit a new receipt with the retired v0.1 shape.
export async function runR7MaterializedBoundaryBenchmark() {
  throw Object.assign(new Error("R7 v0.1 receipt generation is retired"), {
    code: R7_MATERIALIZED_BOUNDARY_GENERATION_RETIRED_CODE,
  });
}
