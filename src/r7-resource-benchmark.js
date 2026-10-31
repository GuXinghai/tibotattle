import { createHash } from "node:crypto";
import { constants as filesystemConstants } from "node:fs";
import {
  lstat,
  open,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES,
  R7_WORKER_MAXIMUM_STDIN_BYTES,
  runR7WorkerWatchdog,
} from "./r7-worker-watchdog.js";
import {
  DEFAULT_EXPORT_RESOURCE_LIMITS,
  readBoundedDirectoryEntries,
} from "./export-resource-policy.js";
import { stableJson } from "./storage.js";

export const R7_RECEIPT_GENERATION_RETIRED_CODE = "r7_v0_1_receipt_generation_retired";
const WORKER = new URL("../scripts/r7-resource-benchmark-worker.js", import.meta.url);
const REPOSITORY_ROOT = new URL("../", import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256OwnedFile(path, expectedStat = null) {
  const before = expectedStat ?? await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error("R7 temporary inventory contained an unsupported entry");
  }
  const handle = await open(
    path,
    filesystemConstants.O_RDONLY | (filesystemConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1
        || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size) {
      throw new Error("R7 temporary file changed during inventory");
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      digest.update(chunk);
    }
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1
        || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size) {
      throw new Error("R7 temporary file changed during inventory");
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function runtimeSourceUrls(relativeDirectory) {
  const urls = [];
  async function visit(directory) {
    const names = await readBoundedDirectoryEntries(directory, {
      maximumEntries: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
      sort: true,
    });
    for (const name of names) {
      const url = new URL(name, directory);
      const metadata = await lstat(url);
      if (metadata.isSymbolicLink()) {
        throw new TypeError("R7 benchmark runtime source contains a symlink");
      }
      // Operating-system metadata and repository-scoped agent guidance are
      // not runtime source and must not be attested as such. Keep both
      // exclusions exact: symlinks were rejected above, directories still
      // recurse, and every other non-JavaScript file continues to fail
      // closed. This mirrors collectR7ReleaseEvidenceRuntimeSourcePaths in
      // src/r7-release-evidence-schema.js.
      if (name.startsWith(".")) continue;
      // Scoped AGENTS.md files are repository policy rather than benchmark
      // runtime. Ignore only this exact basename so arbitrary Markdown inside
      // an attested runtime tree continues to fail closed.
      if (name === "AGENTS.md") continue;
      if (metadata.isDirectory()) {
        await visit(new URL(`${name}/`, directory));
      } else if (name === "AGENTS.md") {
        continue;
      } else if (metadata.isFile()
          && (name.endsWith(".js") || name.endsWith(".mjs"))) {
        urls.push(url);
      } else {
        throw new TypeError(
          "R7 benchmark runtime source contains an unsupported entry",
        );
      }
    }
  }
  await visit(new URL(`${relativeDirectory}/`, REPOSITORY_ROOT));
  return urls;
}

export async function collectR7BenchmarkImplementationUrls() {
  return [
    ...await runtimeSourceUrls("src"),
    // `shared/` was dissolved when ownership boundaries landed; its quota
    // calibration, rolling, and track modules moved to packages/quota-analysis.
    // Dropping the old path without adding the new one would have made this
    // scan pass while silently excluding the calibration code it exists to
    // attest, so the smoke provenance follows the code rather than the
    // directory name.
    ...await runtimeSourceUrls("packages/quota-analysis/src"),
    ...await runtimeSourceUrls("packages/accounting/src"),
    new URL("packages/accounting/index.js", REPOSITORY_ROOT),
    new URL("packages/accounting/package.json", REPOSITORY_ROOT),
    ...await runtimeSourceUrls("packages/codex-catalog/src"),
    new URL("packages/codex-catalog/index.js", REPOSITORY_ROOT),
    new URL("packages/codex-catalog/package.json", REPOSITORY_ROOT),
    WORKER,
    new URL("../package.json", import.meta.url),
    new URL("../pnpm-lock.yaml", import.meta.url),
    new URL("../pnpm-workspace.yaml", import.meta.url),
  ];
}

export async function inventoryR7OwnedTree(root, {
  allowedTransientSymlinkNames = [],
} = {}) {
  const allowedSymlinkNames = new Set(allowedTransientSymlinkNames);
  const rows = [];
  let entryCount = 0;
  async function walk(directory, prefix) {
    const names = await readBoundedDirectoryEntries(directory, {
      maximumEntries: DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries,
      sort: true,
    });
    for (const name of names) {
      entryCount += 1;
      if (entryCount > DEFAULT_EXPORT_RESOURCE_LIMITS.maximumDirectoryEntries) {
        throw new Error("R7 temporary inventory exceeded its bounded entry count");
      }
      const relativeName = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        // The export destination lock is the one symlink the measured
        // lifecycle legitimately creates, and a pass that failed while
        // holding it leaves it behind. Failure-path cleanup opts into
        // tolerating exactly that name; every other symlink stays refused,
        // and the link target is never followed either way.
        if (!allowedSymlinkNames.has(name)) {
          throw new Error("R7 temporary inventory contained a symlink");
        }
        rows.push({ kind: "transient_symlink", relativeName });
      } else if (stat.isDirectory()) {
        await walk(path, relativeName);
        rows.push({ kind: "directory", relativeName });
      } else if (stat.isFile() && stat.nlink === 1) {
        rows.push({
          kind: "file",
          relativeName,
          bytes: stat.size,
          dev: stat.dev,
          ino: stat.ino,
          sha256: await sha256OwnedFile(path, stat),
        });
      } else {
        throw new Error("R7 temporary inventory contained an unsupported entry");
      }
    }
  }
  await walk(root, "");
  const projection = rows.map(({
    kind,
    relativeName,
    bytes = null,
    dev = null,
    ino = null,
    sha256: digest = null,
  }) => ({
    kind,
    relativeName,
    bytes,
    dev,
    ino,
    sha256: digest,
  }));
  return {
    rows,
    entryCount,
    fileCount: rows.filter((row) => row.kind === "file").length,
    inventorySha256: sha256(stableJson(projection)),
    deterministicProjectionSha256: sha256(stableJson(projection.map(
      ({ kind, relativeName, bytes }) => ({ kind, relativeName, bytes }),
    ))),
  };
}

async function assertSameOwnedRoot(root, expectedIdentity) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino) {
    throw new Error("R7 temporary root identity changed");
  }
}

export async function cleanupR7OwnedTree(root, expected, expectedRootIdentity, {
  allowedTransientSymlinkNames = [],
} = {}) {
  await assertSameOwnedRoot(root, expectedRootIdentity);
  const current = await inventoryR7OwnedTree(root, { allowedTransientSymlinkNames });
  if (current.inventorySha256 !== expected.inventorySha256
      || current.entryCount !== expected.entryCount
      || current.fileCount !== expected.fileCount) {
    throw new Error("R7 temporary inventory changed before cleanup");
  }
  for (const row of current.rows) {
    await assertSameOwnedRoot(root, expectedRootIdentity);
    const path = join(root, ...row.relativeName.split("/"));
    if (row.kind === "file") {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== row.bytes
          || stat.dev !== row.dev || stat.ino !== row.ino
          || await sha256OwnedFile(path, stat) !== row.sha256) {
        throw new Error("R7 temporary file changed before cleanup");
      }
      await unlink(path);
    } else if (row.kind === "transient_symlink") {
      const stat = await lstat(path);
      if (!stat.isSymbolicLink()) {
        throw new Error("R7 temporary transient symlink changed before cleanup");
      }
      await unlink(path);
    } else {
      if ((await readBoundedDirectoryEntries(path, { maximumEntries: 1 })).length !== 0) {
        throw new Error("R7 temporary directory was not empty during cleanup");
      }
      await rmdir(path);
    }
  }
  await assertSameOwnedRoot(root, expectedRootIdentity);
  await rmdir(root);
  try {
    await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        inventorySha256: current.inventorySha256,
        entryCount: current.entryCount,
        fileCount: current.fileCount,
        exhausted: true,
      };
    }
    throw error;
  }
  throw new Error("R7 temporary inventory remained after cleanup");
}

export async function runR7BenchmarkWorker(config, {
  timeoutMs = 60_000,
  maximumStdinBytes,
  maximumRssBytes = DEFAULT_EXPORT_RESOURCE_LIMITS.maximumRssBytes,
  runtimeExecutable = process.execPath,
} = {}) {
  if (maximumStdinBytes !== undefined
      && (maximumStdinBytes !== R7_WORKER_MAXIMUM_STDIN_BYTES
        || config?.operation !== "source_scan"
        || !config?.sourcePlanBundle)) {
    throw new TypeError("R7 extended worker input is restricted to real source-plan scans");
  }
  const selectedMaximumStdinBytes = maximumStdinBytes
    ?? R7_WORKER_DEFAULT_MAXIMUM_STDIN_BYTES;
  let workerResult = null;
  const watchdog = await runR7WorkerWatchdog({
    runtimeExecutable,
    workerPath: WORKER.pathname,
    cwd: process.cwd(),
    input: JSON.stringify(config),
    timeoutMs,
    maximumRssBytes,
    maximumStdinBytes: selectedMaximumStdinBytes,
    requireLifetimePeakRss: true,
    consumeStdout(bytes) {
      const value = JSON.parse(bytes.toString("utf8"));
      if (value?.operation !== config.operation || !["completed", "failed"].includes(value?.status)
          || !Number.isSafeInteger(value?.peakRssBytes) || value.peakRssBytes < 1) {
        throw new TypeError("Invalid R7 operation worker result");
      }
      workerResult = value;
      return value.peakRssBytes;
    },
  });
  if (watchdog.outcome !== "completed" || workerResult === null) {
    throw new Error(`R7 operation worker stopped: ${watchdog.outcome}`);
  }
  return {
    ...workerResult,
    parentElapsedMs: watchdog.elapsedMs,
    externalPeakRssBytes: watchdog.peakRssBytes,
    rssSampleCount: watchdog.rssSampleCount,
    rssSampleFailureCount: watchdog.rssSampleFailureCount,
    watchdogStdoutBytes: watchdog.stdoutBytes,
    watchdogStderrBytes: watchdog.stderrBytes,
  };
}

export function projectR7DeterministicOperation(operation) {
  const {
    durableElapsedMs: _durableElapsedMs,
    durablePeakRssBytes: _durablePeakRssBytes,
    // Workspace reservations include the serialized durable resource batch.
    // Its volatile elapsed/RSS digit width can therefore move this high-water
    // mark by a few bytes even when every content and lifecycle result is
    // identical. Keep the measured value in the receipt and ceiling checks,
    // but exclude it from the content-determinism projection.
    workspaceHighWaterBytes: _workspaceHighWaterBytes,
    ...deterministicEvidence
  } = operation.evidence;
  return {
    operation: operation.operation,
    status: operation.status,
    failureCode: operation.failureCode,
    evidence: deterministicEvidence,
  };
}

function retiredR7ReceiptGeneration() {
  throw Object.assign(new Error("R7 v0.1 receipt generation is retired"), {
    code: R7_RECEIPT_GENERATION_RETIRED_CODE,
  });
}

export async function runR7SmokeEvidence() {
  retiredR7ReceiptGeneration();
}

export async function buildR7SmokeReceipt() {
  retiredR7ReceiptGeneration();
}

export async function runR7SmokeBenchmark() {
  retiredR7ReceiptGeneration();
}
