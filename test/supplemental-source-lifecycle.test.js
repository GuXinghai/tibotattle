import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  localExportSetMaterialization,
  localExportSourcePipeline,
  localExportWorkspace,
} from "../src/local-node-runtime.js";
import { planLocalExportDeletion } from "../src/export-deletion.js";
import { deleteLocalExport, recoverLocalExportDeletion } from "../src/export-deletion-executor.js";
import { planLocalExportWorkspaceDiscard } from "../src/export-workspace-discard.js";
import {
  discardLocalExportWorkspace,
  recoverLocalExportWorkspaceDiscard,
} from "../src/export-workspace-discard-executor.js";
import { stableJson } from "../src/storage.js";

const {
  createLocalExportWorkspace,
  inspectLocalExportWorkspace,
  resumeLocalExportWorkspace,
} = localExportSourcePipeline.controller;
const { materializeLocalExportSet } = localExportSetMaterialization;
const { openExportWorkspace } = localExportWorkspace;

const SECRET = Buffer.alloc(32, 117);
const START = "2026-07-24T11:00:00.000Z";
const END = "2026-07-24T13:00:00.000Z";
const CREATED = "2026-07-24T13:00:00.000Z";
const PRIVATE_CANARY = "SUPPLEMENTAL_LIFECYCLE_PRIVATE_CANARY";
const WORKER = new URL("../scripts/test-fixtures/supplemental-checkpoint-crash-worker.js", import.meta.url);
const WORKER_PATH = fileURLToPath(WORKER);

function collectorWindow({ slot = "primary", usedPercent = 12.34 } = {}) {
  return {
    provider: "openai_codex",
    planType: "pro",
    limitId: "codex",
    slot,
    usedPercent,
    windowDurationMins: 10_080,
    resetsAt: 1_784_854_800,
  };
}

function collectorRecord(at, usedPercent = 12.34) {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt: at,
    receivedAt: at,
    stalenessMs: 0,
    source: "app_server_read",
    windows: [collectorWindow({ usedPercent })],
    providerSurface: "account_shared_unallocated",
    accountScope: {
      status: "unavailable",
      reason: "missing_secret",
      version: "openai-account-v1",
      scopeId: null,
      planType: "pro",
    },
    officialDailyTokens: [{ date: "2026-07-24", tokens: 123 }],
    officialUsageSummary: {
      currentStreakDays: 1,
      lifetimeTokens: 2,
      longestRunningTurnSec: 3,
      longestStreakDays: 4,
      peakDailyTokens: 5,
    },
    controlledState: "unknown",
    eventKey: "e".repeat(64),
  };
}

function codexUsage(tokens) {
  return {
    input_tokens: tokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
    total_tokens: tokens + 1,
  };
}

async function byteTree(root) {
  const values = new Map();
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) values.set(relative(root, child), await readFile(child));
      else assert.fail(`unexpected external source entry: ${entry.name}`);
    }
  }
  await visit(root);
  return values;
}

async function externalSourceBytes(value) {
  return {
    codex: await byteTree(value.codexHome),
    collector: await readFile(value.collectorPath),
  };
}

function assertExternalSourcesUnchanged(actual, expected) {
  assert.deepEqual(actual.codex, expected.codex);
  assert.deepEqual(actual.collector, expected.collector);
}

async function fixture({ includeCodex = true, collectorRecords = 3 } = {}) {
  const created = await mkdtemp(join(tmpdir(), "usage-monitor-supplemental-lifecycle-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  const codexHome = join(root, "codex-home");
  const collectorPath = join(root, "collector-events.jsonl");
  const workspace = join(root, "workspace");
  const output = join(root, "output");
  await mkdir(join(codexHome, "sessions"), { recursive: true });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  if (includeCodex) {
    await writeFile(join(codexHome, "sessions", "rollout-2026-07-24T12-00-00-lifecycle.jsonl"), `${[
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "PRIVATE_SESSION", prompt: PRIVATE_CANARY },
      }),
      JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      JSON.stringify({
        timestamp: "2026-07-24T12:02:00.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: codexUsage(10), last_token_usage: codexUsage(10) } },
      }),
    ].join("\n")}\n`, { mode: 0o600 });
  }
  const collectorLines = Array.from({ length: collectorRecords }, (_, index) => JSON.stringify(collectorRecord(
    new Date(Date.parse("2026-07-24T12:10:00.000Z") + (index * 60_000)).toISOString(),
    10 + index,
  )));
  await writeFile(collectorPath, `${collectorLines.join("\n")}\n`, { mode: 0o600 });
  return {
    root, codexHome, collectorPath, workspace, output,
  };
}

function workerEnvironment(value, kind, workspace, crashMarker) {
  return {
    SUPPLEMENTAL_SOURCE_KIND: kind,
    SUPPLEMENTAL_WORKSPACE_DIRECTORY: workspace,
    SUPPLEMENTAL_CODEX_HOME: value.codexHome,
    SUPPLEMENTAL_COLLECTOR_PATH: value.collectorPath,
    SUPPLEMENTAL_SECRET_HEX: SECRET.toString("hex"),
    SUPPLEMENTAL_START_AT: START,
    SUPPLEMENTAL_END_AT: END,
    SUPPLEMENTAL_CREATED_AT: CREATED,
    SUPPLEMENTAL_CRASH_MARKER: crashMarker,
  };
}

function killAfterCommittedAcknowledgement(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let acknowledged = false;
    let sigkillSupported = true;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`supplemental checkpoint worker acknowledgement timed out: ${stderr}`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (acknowledged || !stdout.includes("supplemental_checkpoint_committed\n")) return;
      acknowledged = true;
      if (!child.kill("SIGKILL")) {
        sigkillSupported = false;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, acknowledged, sigkillSupported });
    });
  });
}

async function logicalRecords(directory) {
  const workspace = await openExportWorkspace({ directory });
  try {
    return [...workspace.iterateRecords()].map((row) => ({
      family: row.family,
      recordId: row.recordId,
      recordTime: row.recordTime,
      recordJson: row.recordJson,
    }));
  } finally {
    workspace.close();
  }
}

for (const kind of ["collector"]) {
  test(`parent SIGKILL after a committed ${kind} supplemental batch resumes exactly once and preserves external state`, { timeout: 60_000 }, async (t) => {
    const value = await fixture({ includeCodex: false });
    const crashedWorkspace = join(value.root, `workspace-${kind}-crashed`);
    const controlWorkspace = join(value.root, `workspace-${kind}-control`);
    const expectedExternalSources = await externalSourceBytes(value);
    try {
      const environment = workerEnvironment(value, kind, crashedWorkspace, join(value.root, `${kind}-crash-marker`));
      const crashed = await killAfterCommittedAcknowledgement({
        ...environment,
        SUPPLEMENTAL_WORKER_MODE: "create-and-await-kill",
      });
      if (!crashed.sigkillSupported) {
        t.skip("SIGKILL is unavailable on this platform");
        return;
      }
      assert.equal(crashed.acknowledged, true, crashed.stderr);
      assert.equal(crashed.code, null);
      assert.equal(crashed.signal, "SIGKILL");
      for (const output of [crashed.stdout, crashed.stderr]) {
        assert.equal(output.includes(PRIVATE_CANARY), false);
        assert.equal(output.includes(value.root), false);
      }
      assertExternalSourcesUnchanged(await externalSourceBytes(value), expectedExternalSources);

      const incomplete = await inspectLocalExportWorkspace({ directory: crashedWorkspace });
      assert.equal(incomplete.poisoned, false);
      assert.equal(incomplete.scanComplete, false);
      assert.ok(incomplete.recordCounts.quotaSnapshots > 0);

      const resumed = spawnSync(process.execPath, [WORKER_PATH], {
        cwd: process.cwd(),
        env: { ...process.env, ...environment, SUPPLEMENTAL_WORKER_MODE: "resume" },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.deepEqual(JSON.parse(resumed.stdout), {
        scanComplete: true,
        recordCounts: {
          usageEvents: 0,
          quotaSnapshots: 3,
          activityMarkers: 0,
        },
      });
      assertExternalSourcesUnchanged(await externalSourceBytes(value), expectedExternalSources);

      const sourceOptions = { collectorPath: value.collectorPath, collectorCandidatesPerBatch: 1 };
      await createLocalExportWorkspace({
        directory: controlWorkspace,
        startAt: START,
        endAt: END,
        createdAt: CREATED,
        codexHome: value.codexHome,
        secret: SECRET,
        ...sourceOptions,
      });
      assert.deepEqual(
        stableJson(await logicalRecords(crashedWorkspace)),
        stableJson(await logicalRecords(controlWorkspace)),
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
}

test("bound Codex and collector sources survive interrupted deletion recovery byte-for-byte", { timeout: 60_000 }, async () => {
  const value = await fixture({ includeCodex: true, collectorRecords: 2 });
  const expectedExternalSources = await externalSourceBytes(value);
  try {
    const created = await createLocalExportWorkspace({
      directory: value.workspace,
      startAt: START,
      endAt: END,
      createdAt: CREATED,
      codexHome: value.codexHome,
      collectorPath: value.collectorPath,
      collectorCandidatesPerBatch: 1,
      secret: SECRET,
    });
    assert.equal(created.status.scanComplete, true);
    assert.deepEqual(created.descriptor.sourceProviders, ["openai_codex"]);
    assert.equal(created.descriptor.supplementalSourcePlan.sourceCount, 1);
    await materializeLocalExportSet({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      secret: SECRET,
    });
    const plan = await planLocalExportDeletion({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
    });
    let interrupted = false;
    await assert.rejects(deleteLocalExport({
      workspaceDirectory: value.workspace,
      outputDirectory: value.output,
      confirmationToken: plan.confirmationToken,
      async failpoint(stage, detail) {
        if (!interrupted && stage === "after_inventory_unlink" && detail?.role === "workspace_database") {
          interrupted = true;
          throw new Error("deletion interrupted after bound workspace removal");
        }
      },
    }), /deletion interrupted/);
    assert.equal(interrupted, true);
    assertExternalSourcesUnchanged(await externalSourceBytes(value), expectedExternalSources);
    await recoverLocalExportDeletion({ workspaceDirectory: value.workspace, outputDirectory: value.output });
    assertExternalSourcesUnchanged(await externalSourceBytes(value), expectedExternalSources);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("discarding a failed Codex and collector workspace preserves selected external sources", async () => {
  const value = await fixture({ includeCodex: true, collectorRecords: 2 });
  const expectedExternalSources = await externalSourceBytes(value);
  try {
    await assert.rejects(createLocalExportWorkspace({
      directory: value.workspace,
      startAt: START,
      endAt: END,
      createdAt: CREATED,
      codexHome: value.codexHome,
      collectorPath: value.collectorPath,
      collectorCandidatesPerBatch: 1,
      secret: SECRET,
      async failpoint(stage) {
        if (stage === "after_collector_checkpoint_batch") throw new Error("intentional supplemental workspace failure");
      },
    }), /intentional supplemental workspace failure/);
    const incomplete = await inspectLocalExportWorkspace({ directory: value.workspace });
    assert.equal(incomplete.scanComplete, false);
    assert.equal(incomplete.poisoned, false);
    assertExternalSourcesUnchanged(await externalSourceBytes(value), expectedExternalSources);

    const plan = await planLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    assert.equal(plan.eligibility, "scan_incomplete");
    await discardLocalExportWorkspace({
      workspaceDirectory: value.workspace,
      confirmationToken: plan.confirmationToken,
    });
    assertExternalSourcesUnchanged(await externalSourceBytes(value), expectedExternalSources);
    await recoverLocalExportWorkspaceDiscard({ workspaceDirectory: value.workspace });
    assertExternalSourcesUnchanged(await externalSourceBytes(value), expectedExternalSources);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
