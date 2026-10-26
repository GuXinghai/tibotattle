import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { deriveParticipantId } from "../src/export-identity.js";
import { createCodexExportSourcePlan } from "../src/export-source-plan.js";
import {
  createSupplementalSourcePlan,
  ExportSupplementalSourcePlanError,
  normalizeSupplementalSourcePlan,
  summarizeSupplementalSourcePlan,
} from "../src/export-supplemental-source-plan.js";
import { localCodexCheckpointState, localExportWorkspace } from
  "../src/local-node-runtime.js";
import { stableJson } from "../src/storage.js";

const {
  buildExportWorkspaceDescriptor,
  createExportWorkspace,
  ExportWorkspaceError,
  inspectExportWorkspaceDiscardState,
  openExportWorkspace,
  sourceCheckpointBatchSha256,
  supplementalSourceCheckpointBatchSha256,
} = localExportWorkspace;
const { createEmptyCodexCheckpointState } = localCodexCheckpointState;

const SECRET = Buffer.alloc(32, 79);

function digest(label) {
  return createHash("sha256").update(`supplemental-workspace-test:${label}`).digest("hex");
}

function activityPlan() {
  return {
    recordCount: 0,
    recordsSha256: createHash("sha256")
      .update("app-usagemonitor/export-activity-plan/v1\0")
      .update("[]")
      .digest("hex"),
  };
}

function usageRecord(id = "a", tokens = 10) {
  return {
    schemaVersion: "usage-event-v0.1",
    eventTime: "2026-07-24T12:30:00.000Z",
    provider: "openai_codex",
    modelId: "gpt-5.6-sol",
    modelRecognition: "recognized",
    modelFingerprint: null,
    billingSurface: "chatgpt_subscription",
    speedMode: "standard",
    apiServiceTier: "unknown",
    reasoningEffort: "unknown",
    components: {
      inputUncachedTokens: tokens,
      inputCacheReadTokens: 0,
      inputCacheWriteTokens: 0,
      inputCacheWrite5mTokens: null,
      inputCacheWrite1hTokens: null,
      outputTextTokens: 1,
      outputReasoningTokens: 0,
      outputCombinedTokens: null,
    },
    totalInputContextTokens: tokens,
    surface: "local_interactive_unclassified",
    agentScope: "root",
    lineageDisposition: "standalone",
    toolClassCounts: {
      webSearch: 0, fileSearch: 0, codeInterpreter: 0, hostedShell: 0, computerUse: 0,
      mcp: 0, applyPatch: 0, localShell: 0, subagent: 0, toolGateway: 0, other: 0, unknown: 0,
    },
    outcome: "unknown",
    eventId: `event:v2:${id.repeat(64)}`,
    sessionScopeId: `session:v1:${"9".repeat(64)}`,
    accountScopeId: "unattributed",
  };
}

function supplementalPlan() {
  return createSupplementalSourcePlan({
    sources: [
      {
        ordinal: 0,
        sourceKey: digest("collector"),
        kind: "codex_collector_ledger",
        parserVersion: "codex-collector-ledger-v0.1",
        binding: {
          kind: "file_prefix",
          device: 1,
          inode: 2,
          birthtimeMs: 3,
          prefixBytes: 11,
          prefixSha256: digest("collector-prefix"),
        },
        initialCursorJson: stableJson({ batch: 0 }),
      },
    ],
  });
}

async function fixture({ supplemental = supplementalPlan() } = {}) {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-supplemental-workspace-"));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  await writeFile(join(home, "sessions", "rollout-2026-07-24T12-00-00-supplemental.jsonl"), `${JSON.stringify({
    timestamp: "2026-07-24T12:00:00.000Z",
    type: "session_meta",
    payload: { id: "PRIVATE_SESSION" },
  })}\n`);
  const sourcePlan = await createCodexExportSourcePlan({
    codexHome: home,
    startAt: "2026-07-24T11:00:00.000Z",
    endAt: "2026-07-24T13:00:00.000Z",
  });
  const descriptor = buildExportWorkspaceDescriptor({
    participantId: deriveParticipantId(SECRET),
    createdAt: "2026-07-24T13:00:00.000Z",
    coveredAt: { startAt: sourcePlan.startAt, endAt: sourcePlan.endAt },
    compatibility: exportCompatibilityTuple(),
    sourcePlan,
    supplementalSourcePlan: supplemental,
    activityPlan: activityPlan(),
  });
  return {
    root,
    sourcePlan,
    supplemental,
    descriptor,
    workspace: join(root, "workspace"),
  };
}

function codexBatch(sourceKey, expected, next, resourceDeltas = {}) {
  const value = {
    sourceKey,
    expected: {
      checkpointSeq: expected.checkpointSeq,
      phase: expected.phase,
      byteOffset: expected.byteOffset,
      lineOrdinal: expected.lineOrdinal,
    },
    next,
    records: [],
    seenOccurrences: [],
    localSnapshots: [],
    tierEvents: [],
    openTaskAdds: [],
    openTaskDeletes: [],
    diagnosticDeltas: [],
    resourceDeltas,
  };
  return { ...value, batchSha256: sourceCheckpointBatchSha256(value) };
}

function supplementalBatch(sourceKey, expected, next, {
  records = [], diagnosticDeltas = [], registryGapDeltas = [], resourceDeltas = {},
} = {}) {
  const value = {
    sourceKey,
    expected: {
      checkpointSeq: expected.checkpointSeq,
      status: expected.status,
      cursorJson: expected.cursorJson,
    },
    next,
    records,
    diagnosticDeltas,
    registryGapDeltas,
    resourceDeltas,
  };
  return { ...value, batchSha256: supplementalSourceCheckpointBatchSha256(value) };
}

async function completeCodexSource(workspace, source) {
  const initial = workspace.loadSourceCheckpoint(source.sourceKey);
  await workspace.commitSourceBatch(codexBatch(source.sourceKey, initial, {
    phase: "record_scan",
    byteOffset: 0,
    lineOrdinal: 0,
    parserState: createEmptyCodexCheckpointState(),
    completedPhaseCursor: { byteOffset: source.prefixBytes, lineOrdinal: 1 },
  }, { lines: 1 }));
  const record = workspace.loadSourceCheckpoint(source.sourceKey);
  await workspace.commitSourceBatch(codexBatch(source.sourceKey, record, {
    phase: "complete",
    byteOffset: source.prefixBytes,
    lineOrdinal: 1,
    parserState: record.parserState,
  }, { lines: 1 }));
}

test("new supplemental plans are Codex-only, strict, deterministic, and resource-accountable", async () => {
  const plan = supplementalPlan();
  assert.deepEqual(summarizeSupplementalSourcePlan(plan), {
    schemaVersion: "supplemental-export-source-plan-v2",
    supplementalSourcePlanSha256: plan.supplementalSourcePlanSha256,
    sourceCount: 1,
    sourceFiles: 1,
    sourceBytes: 11,
  });
  for (const mutate of [
    (value) => { value.sources[0].kind = "unreviewed_source"; },
    (value) => {
      value.sources[0].binding = {
        kind: "frozen_inventory",
        inventoryEntries: 1,
        inventoryBytes: 7,
        inventorySha256: digest("wrong-codex-inventory"),
      };
    },
    (value) => { value.sources[0].initialCursorJson = "{\"batch\":0}"; },
    (value) => { value.sources[0].ordinal = 1; },
    (value) => { value.sources[0].sourceKey = "invalid"; },
  ]) {
    const value = structuredClone(plan);
    mutate(value);
    assert.throws(() => summarizeSupplementalSourcePlan(value), (error) => error instanceof ExportSupplementalSourcePlanError
      && error.code === "export_supplemental_source_schema");
  }

  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: value.supplemental,
    });
    assert.deepEqual(workspace.resourceUsage(), {
      policyVersion: workspace.resourceUsage().policyVersion,
      sourceFiles: 2,
      sourceBytes: value.sourcePlan.sources[0].prefixBytes + 11,
      directoryEntries: 0,
      lines: 0,
      oversizedIrrelevantLines: 0,
      outputRecords: 0,
      expandedRecordBytes: 0,
      cumulativeElapsedMs: 0,
      peakRssBytes: 0,
      workspaceHighWaterBytes: 0,
      recoveryReservations: 0,
    });
    assert.deepEqual(workspace.loadSupplementalSourcePlan(), value.supplemental);
    const checkpoint = workspace.loadNextSupplementalSourceCheckpoint();
    assert.equal(checkpoint.sourceKey, value.supplemental.sources[0].sourceKey);
    assert.equal(checkpoint.parserVersion, "codex-collector-ledger-v0.1");
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("retired source kinds decode as legacy state but cannot enter new plans or workspaces", async () => {
  const source = {
    ordinal: 0,
    sourceKey: digest("retired-source-key"),
    kind: "claude_status_snapshot",
    parserVersion: "claude-statusline-v0.2",
    binding: {
      kind: "frozen_inventory",
      inventoryEntries: 0,
      inventoryBytes: 0,
      inventorySha256: digest("retired-inventory"),
    },
    initialCursorJson: stableJson({}),
  };
  const sources = [source];
  const legacy = {
    schemaVersion: "supplemental-export-source-plan-v1",
    supplementalSourcePlanSha256: createHash("sha256")
      .update("app-usagemonitor/supplemental-export-source-plan/v1\0")
      .update(stableJson(sources))
      .digest("hex"),
    sources,
  };
  assert.deepEqual(normalizeSupplementalSourcePlan(legacy), legacy);
  assert.throws(() => createSupplementalSourcePlan({ sources }), (error) => (
    error instanceof ExportSupplementalSourcePlanError
      && error.code === "export_supplemental_source_schema"
  ));

  const value = await fixture({ supplemental: legacy });
  const directory = join(value.root, "must-not-be-created");
  try {
    await assert.rejects(createExportWorkspace({
      directory,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: legacy,
    }), (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_schema");
    await assert.rejects(readdir(directory), { code: "ENOENT" });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("supplemental commits are atomic, byte-identical replays, and gate completion", async () => {
  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: value.supplemental,
    });
    await completeCodexSource(workspace, value.sourcePlan.sources[0]);
    await assert.throws(() => workspace.finalizeScan(), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_checkpoint_mismatch");
    assert.equal(workspace.isScanComplete(), false);
    workspace.close();
    workspace = null;
    assert.equal((await inspectExportWorkspaceDiscardState({ directory: value.workspace })).scanComplete, false);
    workspace = await openExportWorkspace({ directory: value.workspace, expectedDescriptor: value.descriptor });

    const first = workspace.loadSupplementalSourceCheckpoint(value.supplemental.sources[0].sourceKey);
    const batch = supplementalBatch(first.sourceKey, first, {
      status: "pending",
      cursorJson: stableJson({ batch: 1 }),
    }, {
      records: [{ recordType: "usageEvent", record: usageRecord("a", 10) }],
      diagnosticDeltas: [{ code: "malformed_lines", count: 1 }],
      resourceDeltas: { directoryEntries: 1, lines: 1, cumulativeElapsedMs: 4, peakRssBytes: 1024 },
    });
    const committed = await workspace.commitSupplementalSourceBatch(batch);
    assert.equal(committed.alreadyCommitted, false);
    assert.equal(committed.checkpoint.checkpointSeq, 1);
    assert.deepEqual(await workspace.commitSupplementalSourceBatch(batch), {
      alreadyCommitted: true,
      checkpoint: committed.checkpoint,
    });
    assert.deepEqual(workspace.diagnostics(), [{ code: "malformed_lines", count: 1 }]);
    const afterReplayUsage = workspace.resourceUsage();
    assert.equal(afterReplayUsage.outputRecords, 1);
    assert.equal(afterReplayUsage.directoryEntries, 1);

    const branching = supplementalBatch(first.sourceKey, first, {
      status: "pending",
      cursorJson: stableJson({ batch: 99 }),
    });
    await assert.rejects(workspace.commitSupplementalSourceBatch(branching), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_checkpoint_mismatch");

    const current = workspace.loadSupplementalSourceCheckpoint(first.sourceKey);
    const conflict = supplementalBatch(first.sourceKey, current, {
      status: "pending",
      cursorJson: stableJson({ batch: 2 }),
    }, {
      records: [{ recordType: "usageEvent", record: usageRecord("a", 99) }],
      diagnosticDeltas: [{ code: "malformed_lines", count: 9 }],
      resourceDeltas: { lines: 1 },
    });
    await assert.rejects(workspace.commitSupplementalSourceBatch(conflict), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_record_conflict");
    assert.deepEqual(workspace.loadSupplementalSourceCheckpoint(first.sourceKey), current);
    assert.deepEqual(workspace.resourceUsage(), afterReplayUsage);

    const invalidCursor = supplementalBatch(first.sourceKey, current, {
      status: "pending",
      cursorJson: "{\"batch\":2}",
    });
    await assert.rejects(workspace.commitSupplementalSourceBatch(invalidCursor), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_schema");

    await workspace.commitSupplementalSourceBatch(supplementalBatch(first.sourceKey, current, {
      status: "complete",
      cursorJson: stableJson({ batch: 2 }),
    }));
    workspace.finalizeScan();
    assert.equal(workspace.isScanComplete(), true);
    assert.deepEqual(workspace.scanDiagnostics(), {
      sourceFilesScanned: 2,
      codes: [{ code: "malformed_lines", count: 1 }],
    });
    workspace.close();
    workspace = null;
    assert.equal((await inspectExportWorkspaceDiscardState({ directory: value.workspace })).scanComplete, true);
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an empty supplemental plan preserves the Codex-only completion path", async () => {
  const value = await fixture({ supplemental: createSupplementalSourcePlan() });
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
    });
    assert.equal(workspace.loadNextSupplementalSourceCheckpoint(), null);
    assert.equal(workspace.hasPendingSupplementalSources(), false);
    await completeCodexSource(workspace, value.sourcePlan.sources[0]);
    workspace.finalizeScan();
    assert.equal(workspace.isScanComplete(), true);
    workspace.close();
    workspace = null;
    const reopened = await openExportWorkspace({ directory: value.workspace, expectedDescriptor: value.descriptor });
    try {
      assert.equal(reopened.isScanComplete(), true);
      assert.deepEqual(reopened.loadSupplementalSourcePlan(), value.supplemental);
    } finally {
      reopened.close();
    }
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("opening revalidates the descriptor-bound supplemental plan exactly", async () => {
  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
      supplementalSourcePlan: value.supplemental,
    });
    const databaseFile = workspace.databaseFile;
    workspace.close();
    workspace = null;
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databaseFile);
    try {
      database.prepare(`
        UPDATE supplemental_source_plan SET initial_cursor_json = ? WHERE source_key = ?
      `).run(stableJson({ batch: 7 }), value.supplemental.sources[0].sourceKey);
    } finally {
      database.close();
    }
    await assert.rejects(openExportWorkspace({ directory: value.workspace }), (error) => error instanceof ExportWorkspaceError
      && error.code === "export_workspace_schema");
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("retired physical v4 workspaces are refused without modifying retained evidence", async () => {
  const value = await fixture();
  let source; let legacy; let reopened;
  try {
    const current = await createExportWorkspace({ directory: value.workspace, descriptor: value.descriptor,
      sourcePlan: value.sourcePlan, supplementalSourcePlan: value.supplemental });
    current.close();
    const legacyDirectory = join(value.root, "legacy-workspace");
    await mkdir(legacyDirectory, { mode: 0o700 });
    source = new DatabaseSync(join(value.workspace, "workspace.sqlite3"), { readOnly: true });
    legacy = new DatabaseSync(join(legacyDirectory, "workspace.sqlite3"));
    legacy.exec(await readFile(new URL("./fixtures/export-workspace-v4-schema.sql", import.meta.url), "utf8"));
    legacy.exec("PRAGMA foreign_keys=OFF");
    for (const { name } of source.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      assert.match(name, /^[a-z_]+$/);
      for (const row of source.prepare(`SELECT * FROM ${name}`).all()) {
        const columns = Object.keys(row); assert.ok(columns.every(key => /^[a-z][a-z0-9_]*$/.test(key)));
        const data = columns.map(key => row[key]);
        if (name === "workspace_meta" && row.key === "descriptor") {
          const descriptor = JSON.parse(row.value_json);
          descriptor.workspaceVersion = "usage-export-workspace-v0.4";
          descriptor.supplementalSourcePlan.schemaVersion = "supplemental-export-source-plan-v1";
          data[columns.indexOf("value_json")] = stableJson(descriptor);
        }
        legacy.prepare(`INSERT INTO ${name} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...data);
      }
    }
    legacy.close(); legacy = null; source.close(); source = null;
    const databaseFile = join(legacyDirectory, "workspace.sqlite3");
    const originalBytes = await readFile(databaseFile);
    await assert.rejects(openExportWorkspace({ directory: legacyDirectory }), error => error.code === "export_workspace_schema");
    assert.deepEqual(await readFile(databaseFile), originalBytes);
    legacy = new DatabaseSync(join(legacyDirectory, "workspace.sqlite3"), { readOnly: true });
    assert.equal(legacy.prepare("PRAGMA user_version").get().user_version, 4);
  } finally { reopened?.close(); source?.close(); legacy?.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("future workspace schemas are refused before writable pragmas alter the original database", async () => {
  const root = await mkdtemp(join(tmpdir(), "export-workspace-future-"));
  try {
    const databaseFile = join(root, "workspace.sqlite3");
    const database = new DatabaseSync(databaseFile);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA application_id=1431522612; PRAGMA user_version=6; CREATE TABLE future_identity(value TEXT) STRICT;");
    database.close();
    const before = createHash("sha256").update(await readFile(databaseFile)).digest("hex");
    await assert.rejects(openExportWorkspace({ directory: root }), error => error.code === "export_workspace_schema");
    assert.equal(createHash("sha256").update(await readFile(databaseFile)).digest("hex"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
