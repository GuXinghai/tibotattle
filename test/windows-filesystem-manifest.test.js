import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildWindowsFilesystemBindingManifest,
  createWindowsFilesystemBindingManifest,
} from "../scripts/build-windows-filesystem-manifest.mjs";
import { WINDOWS_RELEASE_OPERATION_METHODS, WINDOWS_LEGACY_STATE_READ_METHODS } from "../src/platform/windows-filesystem.js";

const BYTES = Buffer.from("reviewed native bytes", "utf8");

test('legacy copy manifest binds all frozen read and streaming copy methods', () => {
  const extension = { legacyStateReadContractVersion: 'windows-legacy-state-read-v1',
    ...Object.fromEntries(WINDOWS_LEGACY_STATE_READ_METHODS.map(name => [name, () => {}])) };
  const result = createWindowsFilesystemBindingManifest({ bytes: BYTES, binding: binding(extension) });
  assert.deepEqual(result.legacyStateRead, { contractVersion: 'windows-legacy-state-read-v1', approved: true });
  assert.equal(result.approvedPolicy.productionSafe, false);
  for (const name of WINDOWS_LEGACY_STATE_READ_METHODS) {
    assert.throws(() => createWindowsFilesystemBindingManifest({ bytes: BYTES,
      binding: binding({ ...extension, [name]: undefined }) }), { code: 'WINDOWS_FILESYSTEM_MANIFEST_INVALID_LEGACY_STATE_READ' });
  }
});

test("release storage extension requires the complete narrow native lifecycle", () => {
  const extension = Object.fromEntries(WINDOWS_RELEASE_OPERATION_METHODS.map(name => [name, () => {}]));
  extension.protectedDirectoryGuardContractVersion = 'windows-protected-directory-guard-v1';
  const result = createWindowsFilesystemBindingManifest({ bytes: BYTES, binding: binding(extension) });
  assert.deepEqual(result.releaseOperation, { contractVersion: 'windows-release-operation-storage-v1', approved: true });
  assert.equal(result.approvedPolicy.productionSafe, false);
  assert.equal(result.approvedPolicy.pathWalkRaceSafe, false);
  for (const name of WINDOWS_RELEASE_OPERATION_METHODS) {
    assert.throws(() => createWindowsFilesystemBindingManifest({ bytes: BYTES,
      binding: binding({ ...extension, [name]: undefined }),
    }), { code: 'WINDOWS_FILESYSTEM_MANIFEST_INVALID_RELEASE_OPERATION' });
  }
  assert.throws(() => createWindowsFilesystemBindingManifest({ bytes: BYTES,
    binding: binding({ ...extension, protectedDirectoryGuardContractVersion: 'future' }),
  }), { code: 'WINDOWS_FILESYSTEM_MANIFEST_INVALID_RELEASE_OPERATION' });
});
const IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function binding(overrides = {}) {
  return {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    inspectPath: () => ({ identity: IDENTITY }),
    ensureDirectory: () => IDENTITY,
    readFile: () => ({ data: Buffer.from("data"), identity: IDENTITY }),
    createFile: () => IDENTITY,
    deleteFile: () => ({ deleted: true, identity: IDENTITY }),
    replaceFile: () => IDENTITY,
    acquireCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseCredentialMutex: () => {},
    acquireAccountlessInstallationCredentialMutex: () => ({ lease: {}, abandoned: false }),
    releaseAccountlessInstallationCredentialMutex: () => {},
    acquireCredentialAuditFileGuard: () => ({ lease: {} }),
    releaseCredentialAuditFileGuard: () => {},
    ...overrides,
  };
}

test("binding manifest is deterministic, content-free, and policy-disabled", () => {
  const manifest = createWindowsFilesystemBindingManifest({
    bytes: BYTES,
    binding: binding(),
  });
  assert.deepEqual(manifest, {
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: BYTES.byteLength,
    sha256: createHash("sha256").update(BYTES).digest("hex"),
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
    requiredMethods: [
      "inspectPath",
      "ensureDirectory",
      "readFile",
      "createFile",
      "deleteFile",
      "replaceFile",
      "acquireCredentialAuditFileGuard",
      "releaseCredentialAuditFileGuard",
      "acquireCredentialMutex",
      "releaseCredentialMutex",
      "acquireAccountlessInstallationCredentialMutex",
      "releaseAccountlessInstallationCredentialMutex",
    ],
    nativeClaims: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      credentialAuditFileGuardSafe: true,
    },
    approvedPolicy: {
      productionSafe: false,
      pathWalkRaceSafe: false,
      credentialMutexSafe: true,
      credentialAuditFileGuardSafe: true,
    },
  });
  assert.equal(Object.keys(manifest).some((key) => /path|account|secret|content/iu.test(key)), false);
});

test("manifest builder refuses an unreviewed native production claim", () => {
  assert.throws(
    () => createWindowsFilesystemBindingManifest({
      bytes: BYTES,
      binding: binding({ productionSafe: true }),
    }),
    (error) => error.code === "WINDOWS_FILESYSTEM_MANIFEST_NATIVE_CLAIM_UNREVIEWED",
  );
});

test("manifest source-read extension follows the reviewed source policy only", () => {
  const extension = {
    sourceReadContractVersion: 'windows-source-read-v1',
    openSourceFile() {}, statSourceFile() {}, readSourceFile() {}, closeSourceFile() {},
  };
  const result = createWindowsFilesystemBindingManifest({ bytes: BYTES, binding: binding(extension) });
  assert.deepEqual(result.sourceRead, { contractVersion: 'windows-source-read-v1', approved: true });
  assert.equal(result.approvedPolicy.productionSafe, false);
  assert.equal(result.approvedPolicy.pathWalkRaceSafe, false);
  for (const name of ['openSourceFile', 'statSourceFile', 'readSourceFile', 'closeSourceFile']) {
    assert.throws(() => createWindowsFilesystemBindingManifest({
      bytes: BYTES, binding: binding({ ...extension, [name]: undefined }),
    }), { code: 'WINDOWS_FILESYSTEM_MANIFEST_INVALID_SOURCE_READ' });
  }
  assert.throws(() => createWindowsFilesystemBindingManifest({
    bytes: BYTES, binding: binding({ ...extension, sourceReadContractVersion: 'future-contract' }),
  }), { code: 'WINDOWS_FILESYSTEM_MANIFEST_INVALID_SOURCE_READ' });
});

test("manifest builder writes only the exact native digest and safe aggregate fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-windows-manifest-"));
  try {
    const manifestPath = join(root, "binding.manifest.json");
    const result = await buildWindowsFilesystemBindingManifest({
      bindingPath: join(root, "windows_filesystem.node"),
      manifestPath,
      readBinding: async () => BYTES,
      loadBinding: () => binding(),
    });
    assert.equal(result.sha256, createHash("sha256").update(BYTES).digest("hex"));
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
