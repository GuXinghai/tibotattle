import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertR7RealHistorySourcePlanEligibility,
  R7RealHistoryEligibilityError,
  R7_REAL_HISTORY_GENERATION_RETIRED_CODE,
  R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES,
  runR7RealHistoryBenchmark,
} from "../src/r7-real-history-benchmark.js";
import { createExportSourcePlanBundle } from "../src/export-source-plan-bundle.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";
import { runR7BenchmarkWorker } from "../src/r7-resource-benchmark.js";
import {
  createR7StructuralFixture,
  R7_FIXTURE_END_AT,
  R7_FIXTURE_START_AT,
} from "../src/r7-resource-benchmark-fixture.js";

test("real-history private-plan eligibility fails before worker handoff with a fixed code", () => {
  assert.deepEqual(
    assertR7RealHistorySourcePlanEligibility({
      canonicalBytes: R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES,
    }),
    { canonicalBytes: R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES },
  );
  assert.throws(
    () => assertR7RealHistorySourcePlanEligibility({
      canonicalBytes: R7_REAL_HISTORY_MAXIMUM_SOURCE_PLAN_BUNDLE_BYTES + 1,
    }),
    (error) => {
      assert.ok(error instanceof R7RealHistoryEligibilityError);
      assert.equal(error.code, "r7_real_history_source_plan_input");
      assert.equal(/\d{4,}/.test(error.message), false);
      return true;
    },
  );
});

test("retired v0.1 real-history generation rejects before reading paths or running hooks", async () => {
  let hookRan = false;
  const options = {
    get codexHome() { throw new Error("path getter must not run"); },
    get collectorPath() { throw new Error("path getter must not run"); },
    get afterSourcePlanFreeze() { hookRan = true; throw new Error("hook getter must not run"); },
  };
  await assert.rejects(
    runR7RealHistoryBenchmark(options),
    (error) => error.code === R7_REAL_HISTORY_GENERATION_RETIRED_CODE,
  );
  assert.equal(hookRan, false);
});

test("worker reports one fixed source-integrity code for prefix mutation, truncation, and replacement", {
  skip: process.platform === "win32" ? "R7 child watchdog is not qualified on Windows" : false,
}, async (t) => {
  for (const scenario of ["mutation", "truncation", "replacement"]) {
    await t.test(scenario, async () => {
      const root = await mkdtemp(join(tmpdir(), "usage-monitor-r7-integrity-test-"));
      const secret = Buffer.alloc(32, 0x6f);
      try {
        const fixture = await createR7StructuralFixture(root);
        const sourcePlanBundle = await createExportSourcePlanBundle({
          startAt: R7_FIXTURE_START_AT,
          endAt: R7_FIXTURE_END_AT,
          resourceGuard: createExportResourceGuard({ scope: "export_set" }),
          ...fixture.paths,
        });
        if (scenario === "mutation") {
          const bytes = await readFile(fixture.paths.collectorPath);
          bytes[0] ^= 0x01;
          await writeFile(fixture.paths.collectorPath, bytes, { mode: 0o600 });
        } else if (scenario === "truncation") {
          await writeFile(fixture.paths.collectorPath, "", { mode: 0o600 });
        } else {
          const replacement = join(root, "replacement-ledger");
          await writeFile(replacement, await readFile(fixture.paths.collectorPath), { mode: 0o600 });
          await rename(replacement, fixture.paths.collectorPath);
        }
        const result = await runR7BenchmarkWorker({
          operation: "source_scan",
          secretHex: secret.toString("hex"),
          startAt: R7_FIXTURE_START_AT,
          endAt: R7_FIXTURE_END_AT,
          createdAt: R7_FIXTURE_END_AT,
          resourceLimits: {},
          workspaceDirectory: join(root, "mutated-workspace"),
          sourcePlanBundle,
        }, { timeoutMs: 60_000 });
        assert.equal(result.status, "failed");
        assert.equal(result.failureCode, "source_integrity");
        assert.equal(JSON.stringify(result).includes(root), false);
      } finally {
        secret.fill(0);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
