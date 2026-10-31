import { parseIsolatedTestArguments } from "../scripts/run-isolated-tests.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildR7SmokeReceipt,
  cleanupR7OwnedTree,
  collectR7BenchmarkImplementationUrls,
  inventoryR7OwnedTree,
  projectR7DeterministicOperation,
  R7_RECEIPT_GENERATION_RETIRED_CODE,
  runR7BenchmarkWorker,
  runR7SmokeBenchmark,
  runR7SmokeEvidence,
} from "../src/r7-resource-benchmark.js";
import { R7_WORKER_MAXIMUM_STDIN_BYTES } from "../src/r7-worker-watchdog.js";
import { runR7ResourceBoundaryMatrix } from "../src/r7-resource-boundaries.js";
import { DEFAULT_EXPORT_RESOURCE_LIMITS, EXPORT_RESOURCE_POLICY_VERSION } from "../src/export-resource-policy.js";
import {
  fixedOperationFailureCode,
  runR7WorkerOperation,
} from "../scripts/r7-resource-benchmark-worker.js";

test("the supported default suite keeps resource evidence serial", async () => {
  assert.equal(parseIsolatedTestArguments(["--suite=root"]).concurrency, 1);
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts.test,
    "node ./scripts/run-isolated-tests.mjs --suite=root",
  );
});

test("R7 worker provenance binds shared and package runtime sources", async () => {
  const repositoryRoot = new URL("../", import.meta.url);
  const urls = await collectR7BenchmarkImplementationUrls();
  const paths = urls.map((url) => {
    assert.equal(url.href.startsWith(repositoryRoot.href), true);
    return decodeURIComponent(url.href.slice(repositoryRoot.href.length));
  });
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.some((path) => path.endsWith("/AGENTS.md")), false);
  for (const expected of [
    "packages/codex-catalog/index.js",
    "packages/codex-catalog/package.json",
    "packages/codex-catalog/src/model-catalog.js",
    "packages/accounting/index.js",
    "packages/accounting/package.json",
    "packages/accounting/src/cost-ledger.js",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]) assert.equal(paths.includes(expected), true, expected);
});

test("R7 content determinism excludes volatile workspace-reservation width", () => {
  const operation = {
    operation: "source_scan",
    status: "completed",
    failureCode: null,
    evidence: {
      operationEvidenceSha256: "ab".repeat(32),
      sourcePlanSha256: "cd".repeat(32),
      durableElapsedMs: 9,
      durablePeakRssBytes: 99_999_999,
      workspaceHighWaterBytes: 1_239_080,
    },
  };
  const widerVolatileBatch = {
    ...operation,
    evidence: {
      ...operation.evidence,
      durableElapsedMs: 10,
      durablePeakRssBytes: 100_000_000,
      workspaceHighWaterBytes: operation.evidence.workspaceHighWaterBytes + 8,
    },
  };
  assert.deepEqual(projectR7DeterministicOperation(operation), projectR7DeterministicOperation(widerVolatileBatch));
  assert.notEqual(operation.evidence.workspaceHighWaterBytes, widerVolatileBatch.evidence.workspaceHighWaterBytes);
});

test("R7 worker retains allow-listed subsystem codes and discards arbitrary errors", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-fixed-code-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const result = await runR7WorkerOperation({
    operation: "export_set_materialize",
    secretHex: "11".repeat(32),
    workspaceDirectory: join(parent, "missing-workspace"),
    outputDirectory: join(parent, "output"),
    resourceLimits: {},
  });
  assert.equal(result.status, "failed");
  assert.match(result.failureCode, /^export_workspace_[a-z_]+$/u);
  assert.equal(JSON.stringify(result).includes(parent), false);
  assert.equal(
    fixedOperationFailureCode(new Error("Privacy export-set manifest failed validation (private)")),
    "internal_export_set_manifest_validation",
  );
  assert.equal(
    fixedOperationFailureCode(new Error(
      "Privacy verification failed closed (schema_allowlist, provider_adapter_compatibility; sensitive=web_url)",
    )),
    "internal_bundle_privacy_schema_allowlist_and_provider_adapter_compatibility_sensitive_web_url",
  );
  assert.equal(fixedOperationFailureCode(new Error("PRIVATE_ARBITRARY_FAILURE")), "operation_failed");
});

test("R7 boundary matrix proves each synthetic guard ceiling or labels SQLite batch as untested", () => {
  const value = runR7ResourceBoundaryMatrix();
  assert.equal(value.resourcePolicyVersion, EXPORT_RESOURCE_POLICY_VERSION);
  assert.equal(value.rows.length, Object.keys(DEFAULT_EXPORT_RESOURCE_LIMITS).length);
  assert.equal(new Set(value.rows.map((row) => row.dimension)).size, value.rows.length);
  for (const row of value.rows) {
    assert.equal(row.policyLimit > 0, true);
    if (row.dimension === "sqlite_batch_records") {
      assert.deepEqual(
        [row.atLimit, row.plusOne, row.producer, row.identificationStatus],
        ["not_run", "not_run", "not_run", "not_identified"],
      );
      continue;
    }
    assert.equal(row.producer, "not_run", row.dimension);
    assert.equal(row.verifier, "not_run", row.dimension);
    assert.equal(row.atLimit, "passed", row.dimension);
    assert.equal(row.plusOne, "rejected", row.dimension);
    assert.match(row.failureCode, /^export_resource_[a-z_]+$/);
  }
});

test("retired v0.1 smoke receipt entrypoints reject before reading options or creating fixtures", async () => {
  let accessed = false;
  const options = new Proxy({}, { get() { accessed = true; throw new Error("option must not be read"); } });
  for (const generate of [runR7SmokeEvidence, buildR7SmokeReceipt, runR7SmokeBenchmark]) {
    await assert.rejects(
      generate(options),
      (error) => error.code === R7_RECEIPT_GENERATION_RETIRED_CODE,
    );
  }
  assert.equal(accessed, false);
});

test("exact R7 cleanup rejects same-content file identity replacement", async () => {
  const parent = await mkdtemp(join(tmpdir(), "usage-monitor-r7-file-race-"));
  const root = join(parent, "task-root");
  try {
    await mkdir(root, { mode: 0o700 });
    const rootStats = await lstat(root);
    const path = join(root, "large-derived-file");
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 0x5a));
    const expected = await inventoryR7OwnedTree(root);
    await rename(path, join(parent, "displaced"));
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024, 0x5a));
    await assert.rejects(
      cleanupR7OwnedTree(root, expected, { dev: rootStats.dev, ino: rootStats.ino }),
      /inventory changed before cleanup/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("extended worker stdin is restricted to frozen real source-plan scans", async () => {
  for (const config of [
    { operation: "export_set_verify", sourcePlanBundle: {} },
    { operation: "source_scan" },
  ]) {
    await assert.rejects(
      runR7BenchmarkWorker(config, { maximumStdinBytes: R7_WORKER_MAXIMUM_STDIN_BYTES }),
      /restricted to real source-plan scans/,
    );
  }
});

test("R7 benchmark worker enforces its terminal lifetime RSS high-water mark", {
  timeout: 10_000,
  skip: process.platform === "win32" ? "R7 child watchdog is not qualified on Windows" : false,
}, async () => {
  await assert.rejects(
    runR7BenchmarkWorker({
      operation: "export_set_materialize",
      secretHex: "11".repeat(32),
      workspaceDirectory: join(tmpdir(), "usage-monitor-r7-missing-workspace"),
      outputDirectory: join(tmpdir(), "usage-monitor-r7-unused-output"),
      resourceLimits: {},
    }, { maximumRssBytes: 1 }),
    /R7 operation worker stopped: rss_limit_exceeded/,
  );
});
