import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile, appendFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalExportSourcePorts } from "../src/platform/index.js";
import {
  createSyntheticExportSourcePipeline,
  createSyntheticWindowsSourceFileAccess,
} from "./helpers/synthetic-export-source-pipeline.mjs";
const syntheticPipeline = createSyntheticExportSourcePipeline();
const {
  createCodexExportSourcePlan,
  ExportSourcePlanError,
  openVerifiedCodexExportSource,
  resolveCodexExportSourcePlan,
  summarizeExportSourcePlan,
  verifyCodexExportSourcePlan,
  verifyCodexExportSourceHandle,
} = syntheticPipeline.codexSourcePlan;

const { scanCodexSafeRecords } = syntheticPipeline.safeRecords;

async function fixture({ incompleteTail = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "usage-monitor-source-plan-"));
  await mkdir(join(home, "sessions", "2026", "07", "24"), { recursive: true });
  await mkdir(join(home, "archived_sessions"), { recursive: true });
  const path = join(home, "sessions", "2026", "07", "24", "rollout-2026-07-24T12-00-00-source.jsonl");
  const lines = [
    JSON.stringify({ timestamp: "2026-07-24T12:00:00.000Z", type: "session_meta", payload: { id: "private-session" } }),
    JSON.stringify({ timestamp: "2026-07-24T12:01:00.000Z", type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
  ];
  await writeFile(path, `${lines.join("\n")}\n${incompleteTail ? "partial-private-content" : ""}`);
  return { home, path, complete: `${lines.join("\n")}\n` };
}

function safeFailure(code) {
  return (error) => {
    assert.equal(error instanceof ExportSourcePlanError, true);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("private-session"), false);
    return true;
  };
}

async function scanPlanWithSafeRecords(context, plan, rolloutInfo) {
  const records = [];
  await context.safeRecords.scanCodexSafeRecords({
    startAt: plan.startAt,
    endAt: plan.endAt,
    secret: Buffer.alloc(32, 7),
    rolloutInfos: [{ ...rolloutInfo, sourcePlanOrdinal: 0 }],
    openRolloutSource(info) {
      return context.codexSourcePlan.openVerifiedCodexExportSource(plan.sources[info.sourcePlanOrdinal]);
    },
    onRecord(record) { records.push(record); },
  });
  return records;
}

test("source plan rejects an incomplete trailing JSONL record", async () => {
  const value = await fixture({ incompleteTail: true });
  try {
    await assert.rejects(createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    }), safeFailure("export_source_codex_rollout_tail_incomplete"));
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("source plan freezes a complete source and allows later appends", async () => {
  const value = await fixture();
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    assert.equal(plan.sources.length, 1);
    assert.equal(plan.sources[0].prefixBytes, Buffer.byteLength(value.complete));
    assert.deepEqual(summarizeExportSourcePlan(plan), {
      schemaVersion: "codex-export-source-plan-v2",
      sourcePlanSha256: plan.sourcePlanSha256,
      sourceFiles: 1,
      sourceBytes: Buffer.byteLength(value.complete),
    });
    await appendFile(value.path, "\n");
    await verifyCodexExportSourcePlan(plan);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("Windows source plan preserves U64 volume and U128 file identities as exact decimals", async () => {
  const value = await fixture();
  const volumeHex = "ffffffffffffffff";
  const fileIdHex = "ffffffffffffffffffffffffffffffff";
  const opened = { count: 0 };
  const closed = { count: 0 };
  const context = createSyntheticExportSourcePipeline({
    identity: {
      volumeSerialNumber: volumeHex,
      fileId: fileIdHex,
    },
    onOpen: () => { opened.count += 1; },
    onClose: () => { closed.count += 1; },
  });
  try {
    const plan = await context.codexSourcePlan.createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    assert.equal(plan.sources[0].dev, "18446744073709551615");
    assert.equal(plan.sources[0].ino, "340282366920938463463374607431768211455");
    await context.codexSourcePlan.verifyCodexExportSourcePlan(plan);
    assert.deepEqual(await scanPlanWithSafeRecords(context, plan, plan.sources[0].rolloutInfo), []);
    assert.equal(opened.count, closed.count);
    assert.ok(opened.count > 0);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("Windows source plan refuses a file ID beyond U128 before opening", async () => {
  const value = await fixture();
  const opened = { count: 0 };
  const closed = { count: 0 };
  const context = createSyntheticExportSourcePipeline({
    identity: {
      volumeSerialNumber: "0000000000000001",
      fileId: "100000000000000000000000000000000",
    },
    onOpen: () => { opened.count += 1; },
    onClose: () => { closed.count += 1; },
  });
  try {
    await assert.rejects(context.codexSourcePlan.createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    }), safeFailure("export_source_source_changed"));
    assert.equal(opened.count, 0);
    assert.equal(closed.count, 0);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("Windows v2 applies its exact identity rule to a host-derived synthetic file", async () => {
  const value = await fixture();
  const hostStats = await lstat(value.path, { bigint: true });
  const volume = BigInt(hostStats.dev);
  const fileId = BigInt(hostStats.ino);
  const hex = (value_, width) => BigInt(value_).toString(16).padStart(width, "0");
  const opened = { count: 0 };
  const closed = { count: 0 };
  const context = createSyntheticExportSourcePipeline({
    identity: {
      volumeSerialNumber: hex(volume, 16),
      fileId: hex(fileId, 32),
    },
    onOpen: () => { opened.count += 1; },
    onClose: () => { closed.count += 1; },
  });
  const representable = volume <= 0xffff_ffff_ffff_ffffn
    && fileId <= 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn;
  try {
    if (!representable) {
      await assert.rejects(context.codexSourcePlan.createCodexExportSourcePlan({
        codexHome: value.home,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
      }), safeFailure("export_source_source_changed"));
      assert.equal(opened.count, closed.count);
      return;
    }
    const plan = await context.codexSourcePlan.createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    assert.equal(plan.sources[0].dev, volume.toString(10));
    assert.equal(plan.sources[0].ino, fileId.toString(10));
    assert.equal(opened.count, closed.count);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("Windows Codex scanner compares wide decimal identities exactly", async () => {
  const value = await fixture();
  const opened = { count: 0 };
  const closed = { count: 0 };
  const context = createSyntheticExportSourcePipeline({
    identity: {
      volumeSerialNumber: "ffffffffffffffff",
      fileId: "0000000000000000ffffffffffffffff",
    },
    onOpen: () => { opened.count += 1; },
    onClose: () => { closed.count += 1; },
  });
  try {
    const plan = await context.codexSourcePlan.createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    const sourceInfo = plan.sources[0].rolloutInfo;
    assert.equal(sourceInfo.dev, "18446744073709551615");
    assert.equal(sourceInfo.ino, "18446744073709551615");
    assert.deepEqual(await scanPlanWithSafeRecords(context, plan, sourceInfo), []);
    assert.equal(opened.count, closed.count);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }

  const legacyValue = await fixture();
  const legacyContext = createSyntheticExportSourcePipeline();
  try {
    const plan = await legacyContext.codexSourcePlan.createCodexExportSourcePlan({
      codexHome: legacyValue.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    const sourceInfo = plan.sources[0].rolloutInfo;
    const wrongWideId = (BigInt(sourceInfo.ino) + 1n).toString(10);
    await assert.rejects(
      scanPlanWithSafeRecords(legacyContext, plan, { ...sourceInfo, ino: wrongWideId }),
      (error) => error?.code === "codex_log_source_changed",
    );
    await assert.rejects(
      scanPlanWithSafeRecords(legacyContext, plan, {
        ...sourceInfo,
        ino: Number.MAX_SAFE_INTEGER + 1,
      }),
      (error) => error?.code === "codex_log_source_changed",
    );
    await assert.rejects(
      scanPlanWithSafeRecords(legacyContext, plan, {
        ...sourceInfo,
        ino: "340282366920938463463374607431768211456",
      }),
      (error) => error?.code === "codex_log_source_changed",
    );
  } finally {
    await rm(legacyValue.home, { recursive: true, force: true });
  }
});

test("Windows source ports reject a file ID outside the U128 native contract before open", async () => {
  const value = await fixture();
  const opened = { count: 0 };
  const closed = { count: 0 };
  const ports = createLocalExportSourcePorts({
    platform: "win32",
    sourceFileAccessFactory: () => createSyntheticWindowsSourceFileAccess({
      identity: {
        volumeSerialNumber: "0000000000000001",
        fileId: "100000000000000000000000000000000",
      },
      onOpen: () => { opened.count += 1; },
      onClose: () => { closed.count += 1; },
    }),
  });
  try {
    await assert.rejects(ports.exactSourceLstat(value.path), (error) => {
      assert.equal(error.code, "WINDOWS_FILESYSTEM_OPERATION_FAILED");
      return true;
    });
    assert.equal(opened.count, 0);
    assert.equal(closed.count, 0);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("Windows Codex range and line ports stream bounded UTF-8 reads and close leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-win-source-range-"));
  const path = join(root, "synthetic.jsonl");
  const content = `${"x".repeat(70_000)}\r\nsecond line\n`;
  const readLengths = [];
  const opened = { count: 0 };
  const closed = { count: 0 };
  await writeFile(path, content);
  const ports = createLocalExportSourcePorts({
    platform: "win32",
    sourceFileAccessFactory: () => createSyntheticWindowsSourceFileAccess({
      onOpen: () => { opened.count += 1; },
      onClose: () => { closed.count += 1; },
      onRead: (length) => { readLengths.push(length); },
    }),
  });
  try {
    const chunks = [];
    for await (const chunk of ports.codexLogPorts.filesystem.readUtf8Range(path, {
      start: 0,
      end: Buffer.byteLength(content) - 1,
    })) chunks.push(chunk);
    assert.equal(chunks.join(""), content);
    const lines = [];
    for await (const line of ports.codexLogPorts.filesystem.readUtf8LinesRange(path, {
      start: 0,
      end: Buffer.byteLength(content) - 1,
    })) lines.push(line);
    assert.deepEqual(lines, ["x".repeat(70_000), "second line"]);
    assert.ok(readLengths.length >= 3);
    assert.ok(readLengths.every((length) => length <= 64 * 1024));
    assert.equal(opened.count, closed.count);
    const leasesBeforeOversizedRange = opened.count;
    await assert.rejects(async () => {
      for await (const _chunk of ports.codexLogPorts.filesystem.readUtf8Range(path, {
        start: 0,
        end: 8 * 1024 * 1024,
      })) { /* the range must be rejected before a lease is opened */ }
    }, /byte range is invalid/u);
    assert.equal(opened.count, leasesBeforeOversizedRange);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Codex source closes a lease when path identity changes during open", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-win-source-range-id-"));
  const path = join(root, "synthetic.jsonl");
  const content = "synthetic\n";
  const opened = { count: 0 };
  const closed = { count: 0 };
  await writeFile(path, content);
  let inspectionCount = 0;
  const ports = createLocalExportSourcePorts({
    platform: "win32",
    sourceFileAccessFactory: () => {
      const synthetic = createSyntheticWindowsSourceFileAccess({
        onOpen: () => { opened.count += 1; },
        onClose: () => { closed.count += 1; },
      });
      return Object.freeze({
        contractVersion: synthetic.contractVersion,
        inspectPath(selectedPath) {
          const metadata = synthetic.inspectPath(selectedPath);
          inspectionCount += 1;
          if (inspectionCount !== 2) return metadata;
          return Object.freeze({
            ...metadata,
            identity: Object.freeze({ ...metadata.identity, fileId: "00000000000000000000000000000002" }),
          });
        },
        open: (selectedPath) => synthetic.open(selectedPath),
      });
    },
  });
  try {
    await assert.rejects(async () => {
      for await (const _chunk of ports.codexLogPorts.filesystem.readUtf8Range(path, {
        start: 0,
        end: Buffer.byteLength(content) - 1,
      })) { /* consume the bounded synthetic range */ }
    }, (error) => error?.code === "WINDOWS_FILESYSTEM_OPERATION_FAILED");
    assert.equal(opened.count, closed.count);
    assert.ok(opened.count > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source plan detects prefix mutation and truncation with content-free errors", async () => {
  for (const mutation of [
    (value) => writeFile(value.path, value.complete.replace("private-session", "changed-session")),
    (value) => writeFile(value.path, "{}\n"),
  ]) {
    const value = await fixture();
    try {
      const plan = await createCodexExportSourcePlan({
        codexHome: value.home,
        startAt: "2026-07-24T11:00:00.000Z",
        endAt: "2026-07-24T13:00:00.000Z",
      });
      await mutation(value);
      await assert.rejects(verifyCodexExportSourcePlan(plan), safeFailure("export_source_source_changed"));
    } finally {
      await rm(value.home, { recursive: true, force: true });
    }
  }
});

test("source plan resolves an archive move by privacy-safe source key", async () => {
  const value = await fixture();
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    const moved = join(value.home, "archived_sessions", "rollout-2026-07-24T12-00-00-source.jsonl");
    await rename(value.path, moved);
    const resolved = await resolveCodexExportSourcePlan(plan, { codexHome: value.home });
    assert.equal(resolved.sources[0].path, moved);
    assert.equal(resolved.sourcePlanSha256, plan.sourcePlanSha256);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("safe-record scanning ignores complete records appended beyond the frozen prefix", async () => {
  const value = await fixture();
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    plan.sources[0].rolloutInfo.sourcePlanOrdinal = 0;
    await appendFile(value.path, `\n${JSON.stringify({
      timestamp: "2026-07-24T12:05:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 10, cached_input_tokens: 0, cache_write_input_tokens: 0,
            output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11,
          },
        },
      },
    })}\n`);
    const records = [];
    await scanCodexSafeRecords({
      startAt: plan.startAt,
      endAt: plan.endAt,
      secret: Buffer.alloc(32, 7),
      rolloutInfos: plan.sources.map((source) => source.rolloutInfo),
      openRolloutSource(info) {
        return openVerifiedCodexExportSource(plan.sources[info.sourcePlanOrdinal]);
      },
      onRecord(record) {
        records.push(record);
      },
    });
    assert.deepEqual(records, []);
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("source plan refuses a substituted symlink", async () => {
  const value = await fixture();
  const target = join(value.home, "target.jsonl");
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    await rename(value.path, target);
    await symlink(target, value.path);
    await assert.rejects(verifyCodexExportSourcePlan(plan), (error) => {
      assert.equal(error instanceof ExportSourcePlanError, true);
      assert.match(error.code, /^export_source_source_(?:type|changed)$/);
      return true;
    });
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});

test("same-handle post-read verification detects an in-place prefix rewrite", async () => {
  const value = await fixture();
  try {
    const plan = await createCodexExportSourcePlan({
      codexHome: value.home,
      startAt: "2026-07-24T11:00:00.000Z",
      endAt: "2026-07-24T13:00:00.000Z",
    });
    plan.sources[0].rolloutInfo.sourcePlanOrdinal = 0;
    await assert.rejects(
      scanCodexSafeRecords({
        startAt: plan.startAt,
        endAt: plan.endAt,
        secret: Buffer.alloc(32, 7),
        rolloutInfos: plan.sources.map((source) => source.rolloutInfo),
        async openRolloutSource(info) {
          const handle = await openVerifiedCodexExportSource(plan.sources[info.sourcePlanOrdinal]);
          await writeFile(value.path, value.complete.replace("private-session", "changed-session"));
          return handle;
        },
        verifyRolloutSource(info, handle) {
          return verifyCodexExportSourceHandle(plan.sources[info.sourcePlanOrdinal], handle);
        },
        onRecord() {},
      }),
      safeFailure("export_source_source_changed"),
    );
  } finally {
    await rm(value.home, { recursive: true, force: true });
  }
});
