import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = Buffer.alloc(32, 89);
const EVENT_COUNT = 3_000;
const OPEN_TASK_COUNT = 20_000;
const FORK_SNAPSHOT_COUNT = 10_000;
const PRIVATE_CANARY = "BOUNDED_HEAP_PRIVATE_ARGUMENT_DO_NOT_EXPORT";
const START_AT = "2026-07-24T11:00:00.000Z";
const END_AT = "2026-07-24T13:00:00.000Z";
const CREATED_AT = "2026-07-24T13:00:00.000Z";
const LOCAL_RUNTIME_MODULE = new URL("../src/local-node-runtime.js", import.meta.url).href;

const HEAP_WORKER = String.raw`
const runtime = await import(process.env.HEAP_LOCAL_RUNTIME_MODULE);
const {
  createLocalExportWorkspace,
  resumeLocalExportWorkspace,
} = runtime.localExportSourcePipeline.controller;
const { openExportWorkspace } = runtime.localExportWorkspace;
if (process.env.HEAP_INSPECT_USAGE_ONLY === "1") {
  const workspace = await openExportWorkspace({ directory: process.env.HEAP_WORKSPACE_DIRECTORY });
  try {
    const source = workspace.loadSourcePlan().sources[0];
    const checkpoint = workspace.loadSourceCheckpoint(source.sourceKey);
    process.stdout.write(JSON.stringify({
      lines: workspace.resourceUsage().lines,
      tierLineCount: checkpoint.tierLineCount,
      phase: checkpoint.phase,
    }) + "\n");
  } finally {
    workspace.close();
  }
  process.exit(0);
}
const secret = Buffer.from(process.env.HEAP_SECRET_HEX, "hex");
const options = {
  directory: process.env.HEAP_WORKSPACE_DIRECTORY,
  codexHome: process.env.HEAP_CODEX_HOME,
  secret,
  startAt: process.env.HEAP_START_AT,
  endAt: process.env.HEAP_END_AT,
  createdAt: process.env.HEAP_CREATED_AT,
};
if (process.env.HEAP_CHECKPOINT_LINES_PER_BATCH) {
  options.checkpointLinesPerBatch = Number(process.env.HEAP_CHECKPOINT_LINES_PER_BATCH);
}
let syntheticClockValue = 0;
if (process.env.HEAP_SYNTHETIC_CLOCK === "1") {
  options.resourceClock = () => ++syntheticClockValue;
  options.resourceRss = () => 0;
}
if (process.env.HEAP_MAXIMUM_ELAPSED_MS) {
  options.resourceLimits = { maximumElapsedMs: Number(process.env.HEAP_MAXIMUM_ELAPSED_MS) };
}
if (process.env.HEAP_RESUME_AFTER_TIER === "1") {
  let interrupted = false;
  try {
    await createLocalExportWorkspace({
      ...options,
      failpoint(name, checkpoint) {
        if (!interrupted && name === "after_source_checkpoint_batch"
            && checkpoint?.phase === "record_scan") {
          interrupted = true;
          const error = new Error("synthetic checkpoint interruption");
          error.code = "synthetic_checkpoint_interruption";
          throw error;
        }
      },
    });
  } catch (error) {
    if (error.code !== "synthetic_checkpoint_interruption") throw error;
  }
  if (!interrupted) throw new Error("tier checkpoint interruption was not observed");
  if (process.env.HEAP_STOP_AFTER_TIER === "1") {
    const workspace = await openExportWorkspace({ directory: process.env.HEAP_WORKSPACE_DIRECTORY });
    try {
      const source = workspace.loadSourcePlan().sources[0];
      const checkpoint = workspace.loadSourceCheckpoint(source.sourceKey);
      process.stdout.write(JSON.stringify({
        lines: workspace.resourceUsage().lines,
        tierLineCount: checkpoint.tierLineCount,
        phase: checkpoint.phase,
      }) + "\n");
    } finally {
      workspace.close();
    }
    process.exit(0);
  }
}
let result;
let expectedLimitResult = null;
try {
  const runOptions = process.env.HEAP_HARD_CRASH_AFTER_RESPONSE_PLAN === "1"
    ? {
      ...options,
      failpoint(name) {
        if (name === "after_response_plan_rebuild") process.exit(86);
      },
    }
    : options;
  const resume = process.env.HEAP_RESUME_AFTER_TIER === "1"
    || process.env.HEAP_HARD_CRASH_AFTER_RESPONSE_PLAN === "1";
  result = await (resume ? resumeLocalExportWorkspace(runOptions) : createLocalExportWorkspace(runOptions));
} catch (error) {
  if (process.env.HEAP_EXPECT_ELAPSED_LIMIT === "1"
      && error.code === "export_resource_elapsed_time") {
    expectedLimitResult = {
      resourceLimitCode: error.code,
      observed: error.observed,
      limit: error.limit,
    };
  } else {
    throw error;
  }
}
if (expectedLimitResult !== null) {
  process.stdout.write(JSON.stringify(expectedLimitResult) + "\n");
} else {
  const workspace = await openExportWorkspace({ directory: process.env.HEAP_WORKSPACE_DIRECTORY });
  let usageRecords = 0;
  let localShellTools = 0;
  try {
    for (const row of workspace.iterateRecords()) {
      if (row.family !== "usageEvents") continue;
      usageRecords += 1;
      localShellTools += row.record.toolClassCounts.localShell;
    }
    const sourcePlan = workspace.loadSourcePlan();
    const openTasks = sourcePlan.sources.reduce(
      (sum, source) => sum + workspace.sourceOpenTaskKeys(source.sourceKey).length,
      0,
    );
    process.stdout.write(JSON.stringify({
      scanComplete: result.status.scanComplete,
      recordCounts: result.status.recordCounts,
      sourceFiles: sourcePlan.sources.length,
      openTasks,
      usageRecords,
      localShellTools,
      diagnostics: workspace.diagnostics(),
      lines: result.resourceUsage.counters.lines,
      ...(process.env.HEAP_SYNTHETIC_CLOCK === "1"
        ? { cumulativeElapsedMs: result.resourceUsage.cumulativeElapsedMs }
        : {}),
    }) + "\n");
  } finally {
    workspace.close();
  }
}
`;

function cumulativeUsage(total) {
  return {
    input_tokens: total,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: total,
    reasoning_output_tokens: 0,
    total_tokens: total * 2,
  };
}

async function fixture(eventCount = EVENT_COUNT) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-heap-"));
  const home = join(root, "codex-home");
  const sessions = join(home, "sessions");
  const source = join(sessions, "rollout-2026-07-24T12-00-00-bounded-heap.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_HEAP_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  for (let index = 1; index <= eventCount; index += 1) {
    const base = Date.parse("2026-07-24T12:01:00.000Z") + (index * 10);
    const turnId = `PRIVATE_TASK_${index}`;
    lines.push(
      JSON.stringify({
        timestamp: new Date(base).toISOString(),
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId },
      }),
      JSON.stringify({
        timestamp: new Date(base + 1).toISOString(),
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: `PRIVATE_TOOL_${index}`,
          arguments: PRIVATE_CANARY,
        },
      }),
      JSON.stringify({
        timestamp: new Date(base + 2).toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: cumulativeUsage(index),
            last_token_usage: cumulativeUsage(1),
            prompt: PRIVATE_CANARY,
          },
          rate_limits: null,
        },
      }),
      JSON.stringify({
        timestamp: new Date(base + 3).toISOString(),
        type: "event_msg",
        payload: { type: "task_complete", turn_id: turnId },
      }),
    );
  }
  await writeFile(source, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { root, home, source, sourceLineCount: lines.length, workspace: join(root, "workspace") };
}

async function openTaskFixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-open-tasks-"));
  const home = join(root, "codex-home");
  const sessions = join(home, "sessions");
  const source = join(sessions, "rollout-2026-07-24T12-00-00-open-tasks.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_OPEN_TASK_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  const base = Date.parse("2026-07-24T12:01:00.000Z");
  for (let index = 1; index <= OPEN_TASK_COUNT; index += 1) {
    lines.push(JSON.stringify({
      timestamp: new Date(base + index).toISOString(),
      type: "event_msg",
      payload: { type: "task_started", turn_id: `PRIVATE_OPEN_TASK_${index}` },
    }));
  }
  await writeFile(source, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { root, home, source, workspace: join(root, "workspace") };
}

function tokenCountLine(timestamp, total) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: cumulativeUsage(total),
        last_token_usage: cumulativeUsage(1),
      },
      rate_limits: null,
    },
  });
}

async function forkSnapshotFixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-checkpoint-fork-snapshots-"));
  const home = join(root, "codex-home");
  const sessions = join(home, "sessions");
  const parentSource = join(sessions, "rollout-2026-07-24T12-00-00-snapshot-parent.jsonl");
  const childSource = join(sessions, "rollout-2026-07-24T12-30-00-snapshot-child.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const parentSnapshots = [];
  const base = Date.parse("2026-07-24T12:01:00.000Z");
  for (let index = 1; index <= FORK_SNAPSHOT_COUNT; index += 1) {
    parentSnapshots.push(tokenCountLine(new Date(base + index).toISOString(), index));
  }
  const parent = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SNAPSHOT_PARENT" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    ...parentSnapshots,
  ];
  const child = [
    JSON.stringify({
      timestamp: "2026-07-24T12:30:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_SNAPSHOT_CHILD", forked_from_id: "PRIVATE_SNAPSHOT_PARENT" },
    }),
    JSON.stringify({ timestamp: "2026-07-24T12:30:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    ...parentSnapshots,
  ];
  await writeFile(parentSource, `${parent.join("\n")}\n`, { mode: 0o600 });
  await writeFile(childSource, `${child.join("\n")}\n`, { mode: 0o600 });
  return { root, home, source: parentSource, workspace: join(root, "workspace") };
}

function runHeapWorker(value, {
  checkpointLinesPerBatch,
  resumeAfterTier = false,
  syntheticClock = false,
  maximumElapsedMs,
  expectElapsedLimit = false,
  stopAfterTier = false,
  inspectUsageOnly = false,
  hardCrashAfterResponsePlan = false,
} = {}) {
  const child = spawnSync(process.execPath, [
    "--max-old-space-size=64",
    "--input-type=module",
    "--eval",
    HEAP_WORKER,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 45_000,
    env: {
      ...process.env,
        HEAP_LOCAL_RUNTIME_MODULE: LOCAL_RUNTIME_MODULE,
      HEAP_WORKSPACE_DIRECTORY: value.workspace,
      HEAP_CODEX_HOME: value.home,
      HEAP_SECRET_HEX: SECRET.toString("hex"),
      HEAP_START_AT: START_AT,
      HEAP_END_AT: END_AT,
      HEAP_CREATED_AT: CREATED_AT,
      ...(checkpointLinesPerBatch === undefined
        ? {}
        : { HEAP_CHECKPOINT_LINES_PER_BATCH: String(checkpointLinesPerBatch) }),
      ...(resumeAfterTier ? { HEAP_RESUME_AFTER_TIER: "1" } : {}),
      ...(stopAfterTier ? { HEAP_STOP_AFTER_TIER: "1" } : {}),
      ...(inspectUsageOnly ? { HEAP_INSPECT_USAGE_ONLY: "1" } : {}),
      ...(hardCrashAfterResponsePlan ? { HEAP_HARD_CRASH_AFTER_RESPONSE_PLAN: "1" } : {}),
      ...(syntheticClock ? { HEAP_SYNTHETIC_CLOCK: "1" } : {}),
      ...(maximumElapsedMs === undefined
        ? {}
        : { HEAP_MAXIMUM_ELAPSED_MS: String(maximumElapsedMs) }),
      ...(expectElapsedLimit ? { HEAP_EXPECT_ELAPSED_LIMIT: "1" } : {}),
    },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, hardCrashAfterResponsePlan ? 86 : 0, child.stderr);
  for (const output of [child.stdout, child.stderr]) {
    assert.equal(output.includes(PRIVATE_CANARY), false);
    assert.equal(output.includes(value.root), false);
    assert.equal(output.includes(value.source), false);
  }
  return hardCrashAfterResponsePlan ? null : JSON.parse(child.stdout);
}

test("checkpoint scanner completes a task/tool-heavy export under a constrained old-space heap", { timeout: 60_000 }, async () => {
  const value = await fixture();
  try {
    assert.deepEqual(runHeapWorker(value, { checkpointLinesPerBatch: 256 }), {
      scanComplete: true,
      recordCounts: { usageEvents: EVENT_COUNT, quotaSnapshots: 0, activityMarkers: 0 },
      sourceFiles: 1,
      openTasks: 0,
      usageRecords: EVENT_COUNT,
      localShellTools: EVENT_COUNT,
      diagnostics: [{ code: "missing_rate_limit_records", count: EVENT_COUNT }],
      // The tier and record passes read the whole source. Discovery and the
      // same-handle frozen-metadata check each read its first session_meta.
      lines: ((2 + (EVENT_COUNT * 4)) * 2) + 2,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint resource meter counts actual line reads and bounded restart reconciliation", { timeout: 60_000 }, async () => {
  const value = await fixture(10);
  const baseline = { ...value, workspace: join(value.root, "workspace-baseline") };
  const resumed = { ...value, workspace: join(value.root, "workspace-resumed") };
  try {
    const complete = runHeapWorker(baseline, { syntheticClock: true });
    assert.equal(complete.lines, (value.sourceLineCount * 2) + 2,
      "tier plus response reconciliation share the first source pass");

    const afterRestart = runHeapWorker(resumed, {
      syntheticClock: true,
      resumeAfterTier: true,
    });
    assert.equal(afterRestart.lines, complete.lines + value.sourceLineCount + 2,
      "restart accounting includes the bounded fallback source pass and its two source identity verification reads");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("restart reconciliation remains charged to the existing elapsed-time cap", { timeout: 60_000 }, async () => {
  const value = await fixture(10);
  const baseline = { ...value, workspace: join(value.root, "workspace-baseline") };
  const resumed = { ...value, workspace: join(value.root, "workspace-resumed") };
  try {
    const complete = runHeapWorker(baseline, { syntheticClock: true });
    const rejected = runHeapWorker(resumed, {
      syntheticClock: true,
      resumeAfterTier: true,
      maximumElapsedMs: complete.cumulativeElapsedMs,
      expectElapsedLimit: true,
    });
    assert.equal(rejected.resourceLimitCode, "export_resource_elapsed_time");
    assert.equal(rejected.limit, complete.cumulativeElapsedMs);
    assert.ok(rejected.observed > rejected.limit);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("hard crash after fallback reservation preserves actual read accounting", { timeout: 60_000 }, async () => {
  const value = await fixture(10);
  try {
    const tierCheckpoint = runHeapWorker(value, {
      syntheticClock: true,
      resumeAfterTier: true,
      stopAfterTier: true,
    });
    assert.equal(tierCheckpoint.phase, "record_scan");
    assert.equal(tierCheckpoint.tierLineCount, value.sourceLineCount);

    runHeapWorker(value, { hardCrashAfterResponsePlan: true });

    const afterHardCrash = runHeapWorker(value, { inspectUsageOnly: true });
    assert.equal(afterHardCrash.phase, "record_scan");
    assert.equal(afterHardCrash.tierLineCount, value.sourceLineCount);
    assert.equal(afterHardCrash.lines, tierCheckpoint.lines + value.sourceLineCount,
      "the durable exact-count reservation survives process.exit before finishInvocation");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint scanner bounds a default-batch export with many simultaneously open tasks", { timeout: 60_000 }, async () => {
  const value = await openTaskFixture();
  try {
    assert.deepEqual(runHeapWorker(value), {
      scanComplete: true,
      recordCounts: { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 },
      sourceFiles: 1,
      openTasks: OPEN_TASK_COUNT,
      usageRecords: 0,
      localShellTools: 0,
      diagnostics: [],
      lines: ((2 + OPEN_TASK_COUNT) * 2) + 2,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("checkpoint scanner bounds default-batch inherited snapshot lookups at a second scale", { timeout: 60_000 }, async () => {
  const value = await forkSnapshotFixture();
  try {
    assert.deepEqual(runHeapWorker(value), {
      scanComplete: true,
      recordCounts: { usageEvents: FORK_SNAPSHOT_COUNT, quotaSnapshots: 0, activityMarkers: 0 },
      sourceFiles: 2,
      openTasks: 0,
      usageRecords: FORK_SNAPSHOT_COUNT,
      localShellTools: 0,
      diagnostics: [
        { code: "fork_replay_events_skipped", count: FORK_SNAPSHOT_COUNT },
        { code: "missing_rate_limit_records", count: FORK_SNAPSHOT_COUNT },
      ],
      lines: (((2 + FORK_SNAPSHOT_COUNT) * 2) * 2) + 4,
    });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
