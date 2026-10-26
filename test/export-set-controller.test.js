import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "../src/cli.js";
import { summarizeSupplementalSourcePlan } from "../src/export/supplemental-source-plan.js";
import {
  assertWindowsFilesystemProductionSafe,
  createWindowsFilesystemAdapter,
} from "../src/platform/index.js";
import { localExportSourcePipeline, localExportWorkspace } from
  "../src/local-node-runtime.js";
import { stableJson } from "../src/storage.js";
const {
  createLocalExportWorkspace,
  inspectLocalExportWorkspace,
  resumeLocalExportWorkspace,
} = localExportSourcePipeline.controller;
const { ExportWorkspaceError, openExportWorkspace } = localExportWorkspace;

const SECRET = Buffer.alloc(32, 53);

function usage(input, output, cached, reasoning) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "usage-monitor-set-controller-")));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const total = usage(100, 20, 40, 8);
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
    JSON.stringify({
      timestamp: "2026-07-24T12:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: total, last_token_usage: total, prompt: "PRIVATE_PROMPT" },
        rate_limits: {
          limit_id: "codex", plan_type: "pro",
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1784912400 },
          secondary: { used_percent: 6, window_minutes: 10080, resets_at: 1785430800 },
        },
      },
    }),
  ];
  const source = join(home, "sessions", "rollout-2026-07-24T12-00-00-controller.jsonl");
  await writeFile(source, `${lines.join("\n")}\n`);
  return { root, home, source, workspace: join(root, "workspace") };
}

const CLI_ACCOUNT_SCOPE_CANARY = `openai-account:v1:${"Z".repeat(43)}`;

function collectorQuotaRecord() {
  return {
    schemaVersion: "0.3",
    kind: "codex_quota_snapshot",
    provider: "openai_codex",
    observedAt: "2026-07-24T12:04:00.000Z",
    receivedAt: "2026-07-24T12:04:00.000Z",
    stalenessMs: 0,
    source: "app_server_notification",
    windows: [{
      provider: "openai_codex",
      planType: "pro",
      limitId: "codex",
      slot: "primary",
      usedPercent: 17,
      windowDurationMins: 300,
      resetsAt: 1_784_912_400,
    }],
    providerSurface: "account_shared_unallocated",
    accountScope: {
      status: "available",
      reason: null,
      version: "openai-account-v1",
      scopeId: CLI_ACCOUNT_SCOPE_CANARY,
      planType: "pro",
    },
    officialDailyTokens: [],
    officialUsageSummary: null,
    controlledState: "unknown",
    eventKey: "f".repeat(64),
  };
}

async function readExportArtifactText(directory) {
  const texts = [];
  for (const name of await readdir(directory)) {
    const bytes = await readFile(join(directory, name));
    texts.push(name.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8"));
  }
  return texts.join("\n");
}

test("export-set CLI accepts Codex collector selection and rejects retired provider flags", () => {
  const selected = parseArgs(["export-set", "--collector-file", "./private-collector.jsonl"]);
  assert.equal(selected.collectorFile, resolve("./private-collector.jsonl"));
  assert.throws(() => parseArgs(["export-set", "--claude-status"]), /unknown|unsupported|option/iu);
  assert.throws(() => parseArgs(["export-set", "--claude-usage"]), /unknown|unsupported|option/iu);
  assert.equal("claudeStateDirectory" in selected, false);
  assert.equal("claudeProjectsDirectory" in selected, false);
});

test("direct controller rejects retired source options before workspace creation", async () => {
  const value = await fixture();
  const directory = join(value.root, "retired-options-workspace");
  try {
    await assert.rejects(
      createLocalExportWorkspace({
        directory,
        claudeStateDirectory: join(value.root, "must-not-be-read"),
      }),
      (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_checkpoint_mismatch",
    );
    await assert.rejects(readdir(directory), { code: "ENOENT" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("controller creates a complete bounded workspace from frozen source prefixes", async () => {
  const value = await fixture();
  try {
    const result = await createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    });
    assert.deepEqual(result.status.recordCounts, {
      usageEvents: 1,
      quotaSnapshots: 2,
      activityMarkers: 0,
    });
    assert.equal(result.status.scanComplete, true);
    assert.equal(result.resourceUsage.scope, "export_set");
    assert.ok(result.resourceUsage.workspaceHighWaterBytes >= result.status.workspaceBytes);
    assert.ok(result.resourceUsage.counters.workspaceBytes >= result.status.workspaceBytes);
    const persisted = await openExportWorkspace({ directory: value.workspace });
    try {
      assert.equal(
        result.resourceUsage.workspaceHighWaterBytes,
        persisted.resourceUsage().workspaceHighWaterBytes,
      );
    } finally {
      persisted.close();
    }
    const inspected = await inspectLocalExportWorkspace({ directory: value.workspace });
    assert.equal(inspected.sourcePlan.sourceFiles, 1);
    assert.equal(inspected.scanComplete, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceDatabaseSnapshot(directory) {
  const database = new DatabaseSync(join(directory, "workspace.sqlite3"));
  try {
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all().map((row) => row.name);
    return Object.fromEntries(tables.map((name) => {
      const escaped = name.replaceAll('"', '""');
      return [name, database.prepare(`SELECT * FROM "${escaped}"`).all()
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))];
    }));
  } finally {
    database.close();
  }
}

test("legacy Claude supplemental plans remain inspectable but resume rejects before invocation and source reads", async () => {
  const value = await fixture();
  try {
    const created = await createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    });
    const legacySource = {
      ordinal: 0,
      sourceKey: hash("synthetic-retired-source-key"),
      kind: "claude_status_snapshot",
      parserVersion: "claude-statusline-v0.2",
      binding: {
        kind: "frozen_inventory",
        inventoryEntries: 0,
        inventoryBytes: 0,
        inventorySha256: hash("synthetic-retired-inventory"),
      },
      initialCursorJson: stableJson({}),
    };
    const legacySources = [legacySource];
    const legacyPlan = {
      schemaVersion: "supplemental-export-source-plan-v2",
      supplementalSourcePlanSha256: createHash("sha256")
        .update("app-usagemonitor/supplemental-export-source-plan/v1\0")
        .update(stableJson(legacySources))
        .digest("hex"),
      sources: legacySources,
    };
    const descriptor = {
      ...created.descriptor,
      sourceProviders: ["openai_codex", "anthropic_claude_code"],
      supplementalSourcePlan: summarizeSupplementalSourcePlan(legacyPlan),
    };
    const database = new DatabaseSync(join(value.workspace, "workspace.sqlite3"));
    try {
      database.prepare("UPDATE workspace_meta SET value_json = ? WHERE key = 'descriptor'")
        .run(stableJson(descriptor));
      database.prepare(`
        INSERT INTO supplemental_source_plan(
          ordinal, source_key, kind, binding_kind, device, inode, birthtime_ms,
          prefix_bytes, prefix_sha256, inventory_entries, inventory_bytes,
          inventory_sha256, parser_version, initial_cursor_json
        ) VALUES (0, ?, ?, 'frozen_inventory', NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?, ?)
      `).run(legacySource.sourceKey, legacySource.kind, legacySource.binding.inventorySha256,
        legacySource.parserVersion, legacySource.initialCursorJson);
      database.prepare(`
        INSERT INTO supplemental_source_checkpoints(
          source_key, status, cursor_json, checkpoint_seq, parser_version, last_batch_sha256
        ) VALUES (?, 'pending', ?, 0, ?, NULL)
      `).run(legacySource.sourceKey, legacySource.initialCursorJson, legacySource.parserVersion);
    } finally {
      database.close();
    }

    const before = workspaceDatabaseSnapshot(value.workspace);
    const inspected = await inspectLocalExportWorkspace({ directory: value.workspace });
    assert.deepEqual(inspected.sourceProviders, ["openai_codex", "anthropic_claude_code"]);
    const storedWorkspace = await openExportWorkspace({ directory: value.workspace });
    try {
      assert.equal(storedWorkspace.loadSupplementalSourcePlan().sources[0].kind, "claude_status_snapshot");
    } finally {
      storedWorkspace.close();
    }
    await assert.rejects(
      resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: join(value.root, "does-not-exist-codex-home"),
        secret: SECRET,
      }),
      (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_checkpoint_mismatch",
    );
    assert.deepEqual(workspaceDatabaseSnapshot(value.workspace), before);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("controller resumes an interrupted record batch without duplication", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      createLocalExportWorkspace({
        directory: value.workspace,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
        createdAt: "2026-07-24T13:00:00.000Z",
        codexHome: value.home,
        secret: SECRET,
        async failpoint(stage) {
          if (stage === "after_record_batch") throw new Error("simulated interruption");
        },
      }),
      /simulated interruption/,
    );
    const incomplete = await inspectLocalExportWorkspace({ directory: value.workspace });
    assert.equal(incomplete.scanComplete, false);
    assert.deepEqual(incomplete.recordCounts, { usageEvents: 1, quotaSnapshots: 2, activityMarkers: 0 });
    const resumed = await resumeLocalExportWorkspace({
      directory: value.workspace,
      codexHome: value.home,
      secret: SECRET,
    });
    assert.equal(resumed.status.scanComplete, true);
    assert.deepEqual(resumed.status.recordCounts, incomplete.recordCounts);
    assert.ok(resumed.resourceUsage.workspaceHighWaterBytes >= resumed.status.workspaceBytes);
    const persisted = await openExportWorkspace({ directory: value.workspace });
    try {
      assert.equal(
        resumed.resourceUsage.workspaceHighWaterBytes,
        persisted.resourceUsage().workspaceHighWaterBytes,
      );
    } finally {
      persisted.close();
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("controller resumes safely from diagnostics and scan-complete failpoints", async () => {
  for (const failureStage of ["after_diagnostics", "after_scan_complete"]) {
    const value = await fixture();
    try {
      await assert.rejects(
        createLocalExportWorkspace({
          directory: value.workspace,
          startAt: "2026-07-24T11:00:00.000Z",
          endAt: "2026-07-24T13:00:00.000Z",
          createdAt: "2026-07-24T13:00:00.000Z",
          codexHome: value.home,
          secret: SECRET,
          async failpoint(stage) {
            if (stage === failureStage) throw new Error("simulated controller interruption");
          },
        }),
        /simulated controller interruption/,
      );
      const resumed = await resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.home,
        secret: SECRET,
      });
      assert.equal(resumed.status.scanComplete, true);
      assert.deepEqual(resumed.status.recordCounts, {
        usageEvents: 1,
        quotaSnapshots: 2,
        activityMarkers: 0,
      });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("resume fails closed after identity rotation", async () => {
  const value = await fixture();
  try {
    await createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    });
    await assert.rejects(
      resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.home,
        secret: Buffer.alloc(32, 54),
      }),
      (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_checkpoint_mismatch",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("resume fails closed when the bounded activity-marker set changes", async () => {
  const value = await fixture();
  const first = {
    markerId: "019f9010-2222-7222-8222-222222222222",
    observedAt: "2026-07-24T12:01:00.000Z",
    surface: "chatgpt_work",
    state: "pulse",
    agenticPoolCoupling: "shared_agentic_pool",
    planType: "pro",
    planVariant: "pro-20x",
  };
  try {
    await assert.rejects(
      createLocalExportWorkspace({
        directory: value.workspace,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
        createdAt: "2026-07-24T13:00:00.000Z",
        codexHome: value.home,
        secret: SECRET,
        activityMarkers: [first],
        async failpoint(stage) {
          if (stage === "after_record_batch") throw new Error("simulated interruption");
        },
      }),
      /simulated interruption/,
    );
    await assert.rejects(
      resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.home,
        secret: SECRET,
        activityMarkers: [{ ...first, state: "end" }],
      }),
      (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_checkpoint_mismatch",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("export-set CLI creates and resumes a content-free local set", async (t) => {
  try {
    assertWindowsFilesystemProductionSafe(createWindowsFilesystemAdapter());
  } catch (error) {
    if (error?.code === "EXPORT_IDENTITY_WINDOWS_FILESYSTEM_POLICY_UNAVAILABLE") {
      t.skip("local CLI filesystem production policy is unavailable in this environment");
      return;
    }
    throw error;
  }
  const value = await fixture();
  const output = join(value.root, "output");
  const secretFile = join(value.root, "participant-secret");
  const collectorDirectory = join(value.root, "PRIVATE_COLLECTOR_DIRECTORY_CANARY");
  const collectorFile = join(collectorDirectory, "PRIVATE_COLLECTOR_FILENAME_CANARY.jsonl");
  try {
    await mkdir(collectorDirectory, { mode: 0o700 });
    await writeFile(collectorFile, `${JSON.stringify(collectorQuotaRecord())}\n`, { mode: 0o600 });
    const common = [
      "--workspace", value.workspace,
      "--directory", output,
      "--codex-home", value.home,
      "--secret-file", secretFile,
      "--collector-file", collectorFile,
      "--max-records-per-chunk", "1",
      "--max-bundle-bytes", "33554432",
      "--max-artifact-bytes", "35651584",
    ];
    const created = spawnSync(process.execPath, [
      "./src/cli.js", "export-set",
      "--since", "2026-07-24T11:00:00.000Z",
      "--until", "2026-07-24T13:00:00.000Z",
      ...common,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /Local metadata export set: complete/);
    assert.match(created.stdout, /Upload: disabled/);
    assert.match(created.stdout, /Records: 1 usage, 3 quota, 0 markers/);

    const workspace = await openExportWorkspace({ directory: value.workspace });
    try {
      assert.deepEqual(workspace.getDescriptor().sourceProviders, ["openai_codex"]);
      assert.deepEqual(
        workspace.loadSupplementalSourcePlan().sources.map((source) => source.kind),
        ["codex_collector_ledger"],
      );
    } finally {
      workspace.close();
    }

    const inspected = spawnSync(process.execPath, [
      "./src/cli.js", "inspect-export-workspace", "--workspace", value.workspace,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.match(inspected.stdout, /Sources: 2; bytes: \d+/);
    assert.match(inspected.stdout, /Providers: openai_codex/);

    const missingSelection = spawnSync(process.execPath, [
      "./src/cli.js", "export-set", "--resume",
      "--workspace", value.workspace,
      "--directory", output,
      "--codex-home", value.home,
      "--secret-file", secretFile,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(missingSelection.status, 0);
    assert.match(missingSelection.stderr, /checkpoint_mismatch/);

    const resumed = spawnSync(process.execPath, [
      "./src/cli.js", "export-set", "--resume", ...common,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /Workspace status: scan_complete/);

    const verified = spawnSync(process.execPath, [
      "./src/cli.js", "verify-export-set", "--directory", output,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /Local metadata export-set verification: passed/);
    assert.match(verified.stdout, /Records: 1 usage, 3 quota, 0 markers/);

    const artifactText = await readExportArtifactText(output);
    const allOutput = [created.stdout, inspected.stdout, missingSelection.stdout, missingSelection.stderr,
      resumed.stdout, verified.stdout, artifactText].join("\n");
    for (const forbidden of [
      value.root,
      value.home,
      value.source,
      collectorDirectory,
      collectorFile,
      basename(collectorFile),
      CLI_ACCOUNT_SCOPE_CANARY,
      "PRIVATE_SESSION",
      "PRIVATE_PROMPT",
    ]) {
      assert.equal(allOutput.includes(forbidden), false, forbidden);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a post-read source-integrity failure permanently poisons the incomplete workspace", async () => {
  const value = await fixture();
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "PRIVATE_SESSION" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.001Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  for (let index = 1; index <= 1001; index += 1) {
    lines.push(JSON.stringify({
      timestamp: `2026-07-24T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: usage(index, index, 0, 0),
          last_token_usage: usage(1, 1, 0, 0),
        },
        rate_limits: null,
      },
    }));
  }
  const original = `${lines.join("\n")}\n`;
  await writeFile(value.source, original);
  let mutated = false;
  try {
    await assert.rejects(
      createLocalExportWorkspace({
        directory: value.workspace,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
        createdAt: "2026-07-24T13:00:00.000Z",
        codexHome: value.home,
        secret: SECRET,
        async failpoint(stage) {
          if (!mutated && stage === "after_record_batch") {
            mutated = true;
            await writeFile(value.source, original.replace("PRIVATE_SESSION", "CHANGED_SESSION"));
          }
        },
      }),
      /source plan failed \(source_changed\)/,
    );
    const inspected = await inspectLocalExportWorkspace({ directory: value.workspace });
    assert.equal(inspected.poisoned, true);
    assert.equal(inspected.scanComplete, false);
    const cliInspection = spawnSync(process.execPath, [
      "./src/cli.js", "inspect-export-workspace", "--workspace", value.workspace,
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(cliInspection.status, 0, cliInspection.stderr);
    assert.match(cliInspection.stdout, /Status: poisoned_source_integrity/);
    assert.equal(cliInspection.stdout.includes(value.root), false);
    await writeFile(value.source, original);
    await assert.rejects(
      resumeLocalExportWorkspace({
        directory: value.workspace,
        codexHome: value.home,
        secret: SECRET,
      }),
      (error) => error instanceof ExportWorkspaceError
        && error.code === "export_workspace_checkpoint_mismatch",
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("malformed Codex accounting poisons a checkpoint workspace before completion", async () => {
  const value = await fixture();
  try {
    await writeFile(value.source, `${[
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "PRIVATE_SESSION" },
      }),
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.001Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      }),
      "{\"timestamp\":\"2026-07-24T12:02:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"",
    ].join("\n")}\n`);

    await assert.rejects(
      createLocalExportWorkspace({
        directory: value.workspace,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
        createdAt: "2026-07-24T13:00:00.000Z",
        codexHome: value.home,
        secret: SECRET,
      }),
      (error) => error?.code
        === "export_source_codex_rollout_content_invalid",
    );
    const inspected = await inspectLocalExportWorkspace({
      directory: value.workspace,
    });
    assert.equal(inspected.poisoned, true);
    assert.equal(inspected.scanComplete, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a malformed Codex speed setting poisons a checkpoint workspace", async () => {
  const value = await fixture();
  try {
    await writeFile(value.source, `${[
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.000Z",
        type: "session_meta",
        payload: { id: "PRIVATE_SESSION" },
      }),
      JSON.stringify({
        timestamp: "2026-07-24T12:00:00.001Z",
        type: "turn_context",
        payload: { model: "gpt-5.6-sol" },
      }),
      JSON.stringify({
        timestamp: "2026-07-24T12:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { service_tier: 42 },
        },
      }),
    ].join("\n")}\n`);

    await assert.rejects(createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    }), (error) => error?.code
      === "export_source_codex_rollout_content_invalid");
    const inspected = await inspectLocalExportWorkspace({
      directory: value.workspace,
    });
    assert.equal(inspected.poisoned, true);
    assert.equal(inspected.scanComplete, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("copied Codex session metadata keeps a checkpoint workspace valid", async () => {
  const value = await fixture();
  try {
    const firstMeta = JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_SESSION" },
    });
    const copiedMeta = JSON.stringify({
      timestamp: "2026-07-24T12:00:00.001Z",
      type: "session_meta",
      payload: { id: "COPIED_PRIVATE_SESSION" },
    });
    await writeFile(value.source, `${firstMeta}\n${copiedMeta}\n`);
    const result = await createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    });
    assert.equal(result.status.scanComplete, true);
    assert.deepEqual(result.status.recordCounts, {
      usageEvents: 0,
      quotaSnapshots: 0,
      activityMarkers: 0,
    });
    const inspected = await inspectLocalExportWorkspace({
      directory: value.workspace,
    });
    assert.equal(inspected.poisoned, false);
    assert.equal(inspected.scanComplete, true);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("malformed appended Codex session metadata poisons a checkpoint workspace", async () => {
  const value = await fixture();
  try {
    const meta = JSON.stringify({
      timestamp: "2026-07-24T12:00:00.000Z",
      type: "session_meta",
      payload: { id: "PRIVATE_SESSION" },
    });
    const malformedMeta = JSON.stringify({
      timestamp: "2026-07-24T12:00:01.000Z",
      type: "session_meta",
      payload: { cwd: "/private/session" },
    });
    await writeFile(value.source, `${meta}\n${malformedMeta}\n`);
    await assert.rejects(createLocalExportWorkspace({
      directory: value.workspace,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
      createdAt: "2026-07-24T13:00:00.000Z",
      codexHome: value.home,
      secret: SECRET,
    }), (error) => error?.code
      === "export_source_codex_rollout_content_invalid");
    const inspected = await inspectLocalExportWorkspace({
      directory: value.workspace,
    });
    assert.equal(inspected.poisoned, true);
    assert.equal(inspected.scanComplete, false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
