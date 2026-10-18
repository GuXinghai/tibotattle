import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsFilesystemAdapter, createWindowsProtectedStateStore } from "../../../src/platform/index.js";
import { WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS } from "../../../src/platform/windows-filesystem.js";
import {
  createDesktopStartupDiagnostics,
  DESKTOP_STARTUP_DIAGNOSTIC_FILE as FILE,
  DESKTOP_STARTUP_DIAGNOSTIC_SCHEMA,
} from "../desktop-startup-diagnostics.js";
import { createDesktopSecureStorageFailure } from "../desktop-secure-storage-readiness.js";
import { shellError } from "../errors.js";

// A branded store exercises protected-store validation and identity publication.
// Synthetic metadata does not qualify physical Windows ACL behavior.
function fixture(options = {}) {
  const rootPath = "C:\\synthetic-startup\\diagnostics";
  let generation = 1;
  const identity = () => ({ volumeSerialNumber: "0000000000000001", fileId: (generation++).toString(16).padStart(32, "0"), linkCount: 1 });
  const root = { identity: identity(), isDirectory: true, isRegularFile: false, isReparsePoint: false, ownerMatches: true,
    nullDacl: false, daclProtected: true, broadAccess: false, nonOwnerAllow: false, unrecognizedAce: false, finalPathResolved: true };
  let record = null;
  let writes = 0;
  const missing = () => Object.assign(new Error("Synthetic missing file"), { code: "WINDOWS_FILESYSTEM_NOT_FOUND" });
  const checkRoot = (path, expected, name) => {
    assert.equal(path, rootPath);
    assert.deepEqual(expected, root.identity);
    assert.equal(name, FILE);
  };
  const binding = {
    contractVersion: "windows-filesystem-v1", securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1", productionSafe: false,
    pathWalkRaceSafe: false, credentialMutexSafe: true, credentialAuditFileGuardSafe: true,
    ...Object.fromEntries(WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS.map((name) => [name, () => undefined])),
    ensureDirectory: () => root.identity,
    inspectPath: () => ({ ...root }),
    readProtectedChild() { throw new Error("Unexpected diagnostic read"); },
    deleteProtectedChild() { throw new Error("Unexpected diagnostic delete"); },
    inspectProtectedChild(path, expected, name) {
      checkRoot(path, expected, name);
      if (!record) throw missing();
      return { ...record.metadata };
    },
    createProtectedChild(path, expected, name, data) {
      checkRoot(path, expected, name);
      assert.equal(record, null);
      record = { data: Buffer.from(data), metadata: { ...root, isDirectory: false, isRegularFile: true, identity: identity() } };
      ++writes;
      return record.metadata.identity;
    },
    replaceProtectedChild(path, expected, name, oldIdentity, data) {
      checkRoot(path, expected, name);
      assert.deepEqual(oldIdentity, record.metadata.identity);
      record.data = Buffer.from(data);
      record.metadata.identity = identity();
      ++writes;
      return record.metadata.identity;
    },
  };
  const store = createWindowsProtectedStateStore({
    adapter: createWindowsFilesystemAdapter({ platform: "win32", architecture: "x64", binding }), rootPath, maxBytes: 4096,
  });
  const diagnostics = createDesktopStartupDiagnostics({
    app: { getVersion: () => "0.1.24" }, rootPath, platform: "win32", architecture: "x64", windowsProtectedStateStore: store,
    now: () => new Date("2026-09-22T14:00:00.000Z"), ...options,
  });
  return { diagnostics, root, get record() { return record; }, get writes() { return writes; }, value: () => JSON.parse(record.data.toString()) };
}

test("startup diagnostics persist only the owner-protected content-free record", async () => {
  const f = fixture();
  assert.equal(await f.diagnostics.start(), true);
  f.diagnostics.mark("native_handover");
  assert.equal(await f.diagnostics.fail(createDesktopSecureStorageFailure("locked")), true);
  assert.deepEqual(f.value(), {
    schemaVersion: DESKTOP_STARTUP_DIAGNOSTIC_SCHEMA, recordedAt: "2026-09-22T14:00:00.000Z", startedAt: "2026-09-22T14:00:00.000Z",
    phase: "native_handover", outcome: "failed", code: "secure_storage_locked", platform: "win32", architecture: "x64", version: "0.1.24",
  });
  assert.equal(await f.diagnostics.complete(), false);
  assert.equal(f.writes, 2);
});

test("startup checkpoints replace by identity and retain accepted phases until settlement", async () => {
  const f = fixture();
  assert.equal(await f.diagnostics.start(), true);
  assert.equal(await f.diagnostics.checkpoint("native_handover"), true);
  assert.equal(await f.diagnostics.checkpoint("private path"), false);
  assert.equal(f.value().phase, "native_handover");
  assert.equal(f.value().outcome, "in_progress");
  assert.equal(await f.diagnostics.complete(), true);
  assert.equal(f.value().phase, "ready");
  assert.equal(f.value().outcome, "ready");
  assert.equal(f.value().code, null);
  assert.equal(await f.diagnostics.checkpoint("settings"), false);
});

test("startup diagnostics retain only allowlisted metadata and stop codes", async () => {
  const f = fixture();
  await f.diagnostics.start();
  f.diagnostics.mark("settings");
  await f.diagnostics.fail(shellError("desktop_codex_roots_invalid"));
  assert.equal(f.value().code, "electron_shell_desktop_codex_roots_invalid");
  const second = fixture({ app: { getVersion: () => "private path must not persist" } });
  await second.diagnostics.start();
  second.diagnostics.mark("not-a-real-phase");
  await second.diagnostics.stop("untrusted-value");
  assert.equal(second.value().phase, "bootstrap");
  assert.equal(second.value().version, "unknown");
  assert.equal(second.value().code, "startup_stopped");
});

test("startup diagnostics refuse unsafe root or record metadata without repair or overwrite", async () => {
  for (const target of ["root", "record"]) {
    for (const patch of [{ broadAccess: true }, { ownerMatches: false }, { isReparsePoint: true }, { daclProtected: false }, { nullDacl: true }, { nonOwnerAllow: true }, { unrecognizedAce: true }]) {
      const f = fixture();
      assert.equal(await f.diagnostics.start(), true);
      const before = Buffer.from(f.record.data);
      Object.assign(target === "root" ? f.root : f.record.metadata, patch);
      assert.equal(await f.diagnostics.complete(), false);
      assert.deepEqual(f.record.data, before);
      assert.equal(f.writes, 1);
    }
  }
});

test("startup diagnostics refuse root replacement, hardlinks and unbranded or misbound stores", async () => {
  for (const target of ["root", "record"]) {
    const f = fixture();
    await f.diagnostics.start();
    const metadata = target === "root" ? f.root : f.record.metadata;
    metadata.identity = { ...metadata.identity, linkCount: 2 };
    assert.equal(await f.diagnostics.complete(), false);
    assert.equal(f.writes, 1);
  }
  const f = fixture();
  await f.diagnostics.start();
  f.root.identity = { ...f.root.identity, fileId: "ffffffffffffffffffffffffffffffff" };
  assert.equal(await f.diagnostics.complete(), false);
  for (const options of [{ windowsProtectedStateStore: {} }, { rootPath: "C:\\other-root" }, { platform: "linux" }]) {
    const refused = fixture(options);
    assert.equal(await refused.diagnostics.start(), false);
    assert.equal(refused.writes, 0);
  }
});

test("startup diagnostics remain optional when the clock is unavailable", async () => {
  const f = fixture({ now() { throw new Error("synthetic clock failure"); } });
  assert.equal(await f.diagnostics.start(), false);
  assert.equal(await f.diagnostics.fail(new Error("private material")), false);
  assert.equal(f.writes, 0);
});
