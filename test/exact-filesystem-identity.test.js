import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSupplementalSourcePlan } from "../src/export/index.js";
import { createHash } from "node:crypto";
import { exactFilesystemStats } from "../src/platform/exact-filesystem-stats.js";
import { createLocalExportSourcePorts } from "../src/platform/index.js";
import { createCodexCollectorWorkspaceContext } from "../src/application/export-sources/codex-collector-workspace.js";
import { createCodexCollectorExportContext } from "../src/application/export-sources/codex-collector-export.js";
import { createExportResourceGuard } from "../src/export-resource-policy.js";

function stats(inode) {
  return { dev: 44n, ino: BigInt(inode), size: 0n, mode: 0o100600n, uid: 0n, gid: 0n, nlink: 1n,
    birthtimeMs: 1000n, mtimeMs: 1000n, ctimeMs: 1000n,
    isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
    isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false };
}
function context(initial) {
  let inode = initial;
  const read = () => exactFilesystemStats(stats(inode));
  const owner = createCodexCollectorExportContext({ ...createLocalExportSourcePorts(), currentUid: () => null,
    createExportResourceGuard, exactSourceLstat: async () => read(), exactSourceOpen: async () => ({
      stat: async () => read(), close: async () => {}, read: async () => ({ bytesRead: 0 }),
    }),
  });
  return { owner, replace: value => { inode = value; } };
}
const bounds = { collectorPath: "synthetic-ledger.jsonl", startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-01T00:01:00.000Z" };
function digest(plan) {
  const material = Object.fromEntries(["schemaVersion", "startAt", "endAt", "path", "device", "inode", "birthtimeMs", "prefixBytes", "prefixLines", "prefixSha256"].map(key => [key, plan[key]]));
  return createHash("sha256").update("app-usagemonitor/codex-collector-source-plan/v0.1\0").update(JSON.stringify(material)).digest("hex");
}
test("exact source plans distinguish adjacent IDs above Number precision", async () => {
  const { owner, replace } = context("9007199254740992");
  const plan = await owner.createCodexCollectorExportSourcePlan(bounds);
  assert.equal(plan.inode, "9007199254740992");
  assert.equal(plan.device, "44");
  assert.equal(plan.schemaVersion, "codex-collector-export-source-plan-v0.2");
  await owner.verifyCodexCollectorExportSourcePlan(plan);
  replace("9007199254740993");
  await assert.rejects(owner.verifyCodexCollectorExportSourcePlan(plan), error => error.code === "codex_collector_export_source_changed");
});
test("legacy safe numeric plans replay original digest and unsafe legacy values fail closed", async () => {
  const { owner } = context("42");
  const fresh = await owner.createCodexCollectorExportSourcePlan(bounds);
  const legacy = { ...fresh, schemaVersion: "codex-collector-export-source-plan-v0.1", device: 44, inode: 42 };
  legacy.sourcePlanSha256 = digest(legacy);
  const bytes = JSON.stringify(legacy);
  assert.equal((await owner.verifyCodexCollectorExportSourcePlan(legacy)).schemaVersion, legacy.schemaVersion);
  owner.createCodexCollectorExportCursor(legacy);
  const workspaceOwner = createCodexCollectorWorkspaceContext({ codexCollectorExport: owner,
    createHash, resolvePath: resolve, bufferByteLength: Buffer.byteLength });
  const supplemental = workspaceOwner.appendCodexCollectorWorkspaceSource(createSupplementalSourcePlan(), legacy);
  const recovered = await workspaceOwner.resolveCodexCollectorWorkspaceSource({
    collectorPath: legacy.path, resourceGuard: createExportResourceGuard(),
    workspace: { getDescriptor: () => ({ coveredAt: { startAt: legacy.startAt, endAt: legacy.endAt } }), loadSupplementalSourcePlan: () => supplemental },
  });
  assert.deepEqual(recovered.collectorPlan, legacy);
  assert.equal(JSON.stringify(legacy), bytes);
  for (const inode of [9007199254740992, "42", "0042", "18446744073709551616"]) {
    const invalid = { ...legacy, inode }; invalid.sourcePlanSha256 = digest(invalid);
    assert.throws(() => owner.createCodexCollectorExportCursor(invalid), error => error.code === "codex_collector_export_plan_invalid");
  }
});

test("exact stat conversion refuses unsafe Number identities before serialization", () => {
  for (const value of [9007199254740992, -1n, 18446744073709551616n]) {
    const input = stats("42"); input.ino = value;
    assert.throws(() => exactFilesystemStats(input), /filesystem_identity_unavailable/);
  }
});

test("BigInt identity reads preserve Node Stats millisecond timestamps and boundary fractions", async () => {
  const root = await mkdtemp(join(tmpdir(), "exact-stats-time-"));
  try {
    const path = join(root, "synthetic.txt"); await writeFile(path, "synthetic", { mode: 0o600 });
    const ordinary = await stat(path); const precise = exactFilesystemStats(await stat(path, { bigint: true }));
    for (const key of ["birthtimeMs", "mtimeMs", "ctimeMs"]) assert.equal(precise[key], ordinary[key]);
    for (const nanoseconds of [1799999999999999873n, 1800000000000000127n, 900719925499999999n]) {
      const input = stats("42"); input.birthtimeNs = nanoseconds; input.birthtimeMs = nanoseconds / 1000000n;
      const milliseconds = Number(nanoseconds / 1000000000n) * 1000 + Number(nanoseconds % 1000000000n) / 1e6;
      assert.equal(exactFilesystemStats(input).birthtimeMs, milliseconds);
      assert.equal(Math.trunc(exactFilesystemStats(input).birthtimeMs), Math.trunc(milliseconds));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
