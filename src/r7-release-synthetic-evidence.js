export const R7_RELEASE_EVIDENCE_GENERATION_RETIRED_CODE =
  "r7_v0_1_receipt_generation_retired";

function retiredGeneration() {
  throw Object.assign(new Error("R7 v0.1 receipt generation is retired"), {
    code: R7_RELEASE_EVIDENCE_GENERATION_RETIRED_CODE,
  });
}

// The v0.1 receipt contract records retired provider and callback coverage.
// Keep its historical validator and frozen receipts readable, but do not
// create new evidence under that obsolete contract.
export async function runR7ReleaseSyntheticEvidence() {
  retiredGeneration();
}

export async function buildR7ReleaseSyntheticReceipt() {
  retiredGeneration();
}

export async function runR7ReleaseSyntheticBenchmark() {
  retiredGeneration();
}
