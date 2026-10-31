import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { exportCompatibilityTuple } from "../src/export-contract.js";
import { deriveParticipantId } from "../src/export-identity.js";
import { createCodexExportSourcePlan } from "../src/export-source-plan.js";
import { localExportWorkspace } from "../src/local-node-runtime.js";
import { createWindowsFilesystemAdapter } from "../src/platform/index.js";
import {
  assertWindowsOwnerOnly,
  grantSyntheticEveryoneRead,
} from "./helpers/windows-owner-only-fixture.js";
const {
  buildExportWorkspaceDescriptor,
  createExportWorkspace,
  ExportWorkspaceError,
  inspectExportWorkspaceDiscardState,
  openExportWorkspace,
} = localExportWorkspace;

const SECRET = Buffer.alloc(32, 41);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-workspace-"));
  const home = join(root, "codex-home");
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const source = join(home, "sessions", "rollout-2026-07-24T12-00-00-workspace.jsonl");
  await writeFile(source, `${JSON.stringify({
    timestamp: "2026-07-24T12:00:00.000Z",
    type: "session_meta",
    payload: { id: "PRIVATE_SESSION", prompt: "PRIVATE_PROMPT" },
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
    activityPlan: {
      recordCount: 0,
      recordsSha256: createHash("sha256")
        .update("app-usagemonitor/export-activity-plan/v1\0")
        .update("[]")
        .digest("hex"),
    },
  });
  return { root, home, workspace: join(root, "workspace"), sourcePlan, descriptor };
}

function usageRecord(id = "a", tokens = 10) {
  return {
    schemaVersion: "local-usage-event-v1",
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

test("workspace persists strict safe records without bypassing checkpoint completion", async () => {
  const value = await fixture();
  let workspace;
  let resumed;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
    });
    if (process.platform === "win32") {
      assertWindowsOwnerOnly(value.workspace);
      assertWindowsOwnerOnly(workspace.databaseFile);
    }
    await workspace.insertRecordBatch([{ recordType: "usageEvent", record: usageRecord() }]);
    await workspace.insertRecordBatch([{ recordType: "usageEvent", record: usageRecord() }]);
    workspace.replaceDiagnostics([{ code: "malformed_lines", count: 2 }]);
    const initial = await workspace.status();
    assert.deepEqual(initial.recordCounts, { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 });
    assert.equal(initial.scanComplete, false);
    assert.ok(initial.workspaceBytes > 0);
    assert.equal(await workspace.storageBytes(), initial.workspaceBytes);
    workspace.close();
    workspace = null;

    resumed = await openExportWorkspace({ directory: value.workspace, expectedDescriptor: value.descriptor });
    assert.deepEqual(resumed.counts(), { usageEvents: 1, quotaSnapshots: 0, activityMarkers: 0 });
    assert.deepEqual(resumed.diagnostics(), [{ code: "malformed_lines", count: 2 }]);
    assert.deepEqual(resumed.scanDiagnostics(), {
      sourceFilesScanned: 0,
      codes: [{ code: "malformed_lines", count: 2 }],
    });
    assert.equal([...resumed.iterateRecords()][0].record.eventId, usageRecord().eventId);
    if (process.platform === "win32") {
      assertWindowsOwnerOnly(value.workspace);
      assertWindowsOwnerOnly(resumed.databaseFile);
    } else {
      assert.equal((await stat(resumed.databaseFile)).mode & 0o777, 0o600);
    }
    const databaseBytes = await readFile(resumed.databaseFile);
    assert.equal(databaseBytes.includes(Buffer.from("PRIVATE_PROMPT")), false);
    resumed.close();
    resumed = null;
  } finally {
    resumed?.close();
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("read-only discard preflight preserves an incomplete protected workspace", async () => {
  const value = await fixture();
  let workspace;
  try {
    workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
    });
    const databaseFile = workspace.databaseFile;
    workspace.close();
    workspace = null;
    const bytesBefore = await readFile(databaseFile);
    const namesBefore = (await readdir(value.workspace)).sort();
    let directoryMetadataBefore = null;
    let databaseMetadataBefore = null;
    if (process.platform === "win32") {
      const adapter = createWindowsFilesystemAdapter();
      directoryMetadataBefore = adapter.inspectPath(value.workspace);
      databaseMetadataBefore = adapter.inspectPath(databaseFile);
      assertWindowsOwnerOnly(value.workspace);
      assertWindowsOwnerOnly(databaseFile);
    }

    assert.deepEqual(await inspectExportWorkspaceDiscardState({ directory: value.workspace }), {
      poisoned: false,
      scanComplete: false,
      hasManifestState: false,
      chunkCount: 0,
    });
    assert.deepEqual(await readFile(databaseFile), bytesBefore);
    assert.deepEqual((await readdir(value.workspace)).sort(), namesBefore);
    if (process.platform === "win32") {
      const adapter = createWindowsFilesystemAdapter();
      assert.deepEqual(adapter.inspectPath(value.workspace), directoryMetadataBefore);
      assert.deepEqual(adapter.inspectPath(databaseFile), databaseMetadataBefore);
    }
  } finally {
    workspace?.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace rejects conflicting occurrence IDs atomically", async () => {
  const value = await fixture();
  const workspace = await createExportWorkspace({
    directory: value.workspace,
    descriptor: value.descriptor,
    sourcePlan: value.sourcePlan,
  });
  try {
    await workspace.insertRecordBatch([{ recordType: "usageEvent", record: usageRecord("a", 10) }]);
    await assert.rejects(
      workspace.insertRecordBatch([{ recordType: "usageEvent", record: usageRecord("a", 11) }]),
      (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_record_conflict",
    );
    assert.equal(workspace.counts().usageEvents, 1);
    assert.equal([...workspace.iterateRecords()][0].record.components.inputUncachedTokens, 10);
  } finally {
    workspace.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("workspace refuses descriptor mismatch, hardlinks, unsafe permissions, and disk overflow", async () => {
  const scenarios = process.platform === "win32"
    ? ["descriptor", "hardlink", "permissions", "directory-permissions", "disk"]
    : ["descriptor", "hardlink", "permissions", "disk"];
  for (const scenario of scenarios) {
    const value = await fixture();
    let workspace = await createExportWorkspace({
      directory: value.workspace,
      descriptor: value.descriptor,
      sourcePlan: value.sourcePlan,
    });
    workspace.close();
    workspace = null;
    try {
      if (scenario === "descriptor") {
        const changed = structuredClone(value.descriptor);
        changed.createdAt = "2026-07-24T13:00:01.000Z";
        await assert.rejects(
          openExportWorkspace({ directory: value.workspace, expectedDescriptor: changed }),
          (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_checkpoint_mismatch",
        );
      } else if (scenario === "hardlink") {
        await link(join(value.workspace, "workspace.sqlite3"), join(value.workspace, "foreign-link.sqlite3"));
        await assert.rejects(
          openExportWorkspace({ directory: value.workspace }),
          (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_database_links",
        );
      } else if (scenario === "permissions") {
        const databaseFile = join(value.workspace, "workspace.sqlite3");
        const bytesBefore = await readFile(databaseFile);
        if (process.platform === "win32") {
          const adapter = createWindowsFilesystemAdapter();
          grantSyntheticEveryoneRead(databaseFile);
          assert.equal(adapter.inspectPath(databaseFile).broadAccess, true);
          await assert.rejects(
            openExportWorkspace({ directory: value.workspace }),
            (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_database_permissions",
          );
          assert.equal(adapter.inspectPath(databaseFile).broadAccess, true,
            "an unsafe existing DACL is rejected without repair");
        } else {
          await chmod(databaseFile, 0o644);
          await assert.rejects(
            openExportWorkspace({ directory: value.workspace }),
            (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_database_permissions",
          );
        }
        assert.deepEqual(await readFile(databaseFile), bytesBefore);
      } else if (scenario === "directory-permissions") {
        const databaseFile = join(value.workspace, "workspace.sqlite3");
        const bytesBefore = await readFile(databaseFile);
        const adapter = createWindowsFilesystemAdapter();
        grantSyntheticEveryoneRead(value.workspace);
        grantSyntheticEveryoneRead(databaseFile);
        assert.equal(adapter.inspectPath(value.workspace).broadAccess, true);
        assert.equal(adapter.inspectPath(databaseFile).broadAccess, true);
        await assert.rejects(
          openExportWorkspace({ directory: value.workspace }),
          (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_directory",
        );
        assert.equal(adapter.inspectPath(value.workspace).broadAccess, true,
          "an unsafe existing directory DACL is rejected without repair");
        assert.equal(adapter.inspectPath(databaseFile).broadAccess, true);
        assert.deepEqual(await readFile(databaseFile), bytesBefore);
      } else if (scenario === "disk") {
        await assert.rejects(
          openExportWorkspace({ directory: value.workspace, maximumWorkspaceBytes: 1 }),
          (error) => error instanceof ExportWorkspaceError && error.code === "export_workspace_disk",
        );
      }
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});
