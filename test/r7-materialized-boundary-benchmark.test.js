import test from "node:test";
import assert from "node:assert/strict";
import {
  parseR7MaterializedBoundaryWorkerResult,
  R7_MATERIALIZED_BOUNDARY_GENERATION_RETIRED_CODE,
  runR7MaterializedBoundaryBenchmark,
} from "../src/r7-materialized-boundary-benchmark.js";
import { runR7MaterializedBoundaryWorker } from "../scripts/r7-materialized-boundary-worker.js";

test("retired materialized v0.1 receipt generation rejects before reading options or creating fixtures", async () => {
  let accessed = false;
  const options = new Proxy({}, { get() { accessed = true; throw new Error("option must not be read"); } });
  await assert.rejects(
    runR7MaterializedBoundaryBenchmark(options),
    (error) => error.code === R7_MATERIALIZED_BOUNDARY_GENERATION_RETIRED_CODE,
  );
  assert.equal(accessed, false);
});

test("materialized boundary worker/parser keeps the fixed content-free failure contract", async () => {
  const config = {};
  Object.defineProperty(config, "temporaryRoot", {
    get() { throw new Error("NEVER_RENDER_THIS"); },
  });
  const result = await runR7MaterializedBoundaryWorker(config);
  assert.deepEqual(result, {
    status: "failed",
    failureCode: "harness_failed",
    evidence: null,
  });
  assert.equal(JSON.stringify(result).includes("NEVER_RENDER_THIS"), false);
  assert.deepEqual(
    parseR7MaterializedBoundaryWorkerResult(Buffer.from(JSON.stringify(result))),
    { evidence: null, failureCode: "harness_failed" },
  );
  assert.throws(
    () => parseR7MaterializedBoundaryWorkerResult(
      Buffer.from('{"status":"failed","failureCode":"NEVER_RENDER_THIS","evidence":null}'),
    ),
    (error) => error.message === "Invalid R7 materialized boundary result"
      && error.message.includes("NEVER_RENDER_THIS") === false,
  );
});
