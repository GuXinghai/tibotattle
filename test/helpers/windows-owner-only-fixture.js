import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import { createWindowsFilesystemAdapter, createWindowsProtectedStateStore } from "../../src/platform/index.js";

export function assertWindowsOwnerOnly(path) {
  const metadata = createWindowsFilesystemAdapter().inspectPath(path);
  for (const [key, value] of Object.entries({
    isReparsePoint: false, ownerMatches: true, nullDacl: false,
    daclProtected: true, broadAccess: false, nonOwnerAllow: false,
    unrecognizedAce: false, finalPathResolved: true,
  })) assert.equal(metadata[key], value, key);
  assert.equal(metadata.identity.linkCount, 1);
  return metadata;
}

// Only disposable synthetic test state may be passed to this helper.
export function grantSyntheticEveryoneRead(path) {
  execFileSync("icacls.exe", [path, "/grant", "*S-1-1-0:R"], { stdio: "ignore", windowsHide: true });
  assert.equal(createWindowsFilesystemAdapter().inspectPath(path).broadAccess, true);
}

// Initial synthetic state must obey the same Windows ACL contract as new
// product state. Deliberately unsafe-state fixtures must keep their raw writes.
export function createProtectedFixtureDirectory(path) {
  return createWindowsFilesystemAdapter().ensureDirectory(path);
}

export function writeInitialProtectedFixtureFile(path, text) {
  const store = createWindowsProtectedStateStore({
    adapter: createWindowsFilesystemAdapter(), rootPath: dirname(path),
  });
  const bytes = Buffer.from(text);
  try { store.create(basename(path), bytes); }
  finally { bytes.fill(0); }
}
