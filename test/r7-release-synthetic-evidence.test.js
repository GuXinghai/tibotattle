import test from "node:test";
import assert from "node:assert/strict";
import {
  buildR7ReleaseSyntheticReceipt,
  R7_RELEASE_EVIDENCE_GENERATION_RETIRED_CODE,
  runR7ReleaseSyntheticBenchmark,
  runR7ReleaseSyntheticEvidence,
} from "../src/r7-release-synthetic-evidence.js";

test("retired v0.1 release evidence generation rejects before fixture or state access", async () => {
  let accessed = false;
  const options = {
    get profile() { accessed = true; throw new Error("profile getter must not run"); },
    get temporaryRoot() { accessed = true; throw new Error("path getter must not run"); },
  };
  for (const generate of [
    runR7ReleaseSyntheticEvidence,
    buildR7ReleaseSyntheticReceipt,
    runR7ReleaseSyntheticBenchmark,
  ]) {
    await assert.rejects(
      generate(options),
      (error) => error.code === R7_RELEASE_EVIDENCE_GENERATION_RETIRED_CODE,
    );
  }
  assert.equal(accessed, false);
});
