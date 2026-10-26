import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExportWorkspace } from "../src/local-node-runtime.js";
import { createWindowsFilesystemAdapter } from "../src/platform/index.js";
import {
  assertWindowsOwnerOnly,
  createProtectedFixtureDirectory,
  grantSyntheticEveryoneRead,
} from "./helpers/windows-owner-only-fixture.js";

const {
  ExportWorkspaceLockError,
  withExportWorkspaceLease,
} = localExportWorkspace;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-workspace-lock-"));
  const directory = join(root, "workspace");
  if (process.platform === "win32") createProtectedFixtureDirectory(directory);
  else await mkdir(directory, { mode: 0o700 });
  return { root, directory };
}

test("workspace lease excludes a concurrent owner and releases after completion", async () => {
  const { root, directory } = await fixture();
  try {
    await withExportWorkspaceLease(directory, async () => {
      if (process.platform === "win32") {
        assertWindowsOwnerOnly(directory);
        assertWindowsOwnerOnly(join(directory, ".app-usagemonitor-export-workspace.lock"));
      }
      await assert.rejects(
        withExportWorkspaceLease(directory, async () => {}),
        (error) => error instanceof ExportWorkspaceLockError
          && error.code === "export_workspace_lock_contended",
      );
    });
    await withExportWorkspaceLease(directory, async () => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace lease reaps a strict dead-process lock and rejects malformed locks", async () => {
  for (const malformed of [false, true]) {
    const { root, directory } = await fixture();
    const lock = join(directory, ".app-usagemonitor-export-workspace.lock");
    try {
      const contents = malformed
        ? "not-json\n"
        : JSON.stringify({ version: "export-workspace-lock-v1", pid: 999_999_999, token: "11111111-1111-4111-8111-111111111111" }) + "\n";
      if (process.platform === "win32") {
        createWindowsFilesystemAdapter().createFile(lock, Buffer.from(contents, "utf8"));
      } else {
        await writeFile(lock, contents, { mode: 0o600 });
      }
      if (malformed) {
        await assert.rejects(
          withExportWorkspaceLease(directory, async () => {}),
          (error) => error instanceof ExportWorkspaceLockError
            && error.code === "export_workspace_lock_invalid",
        );
      } else {
        await withExportWorkspaceLease(directory, async () => {});
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("workspace lease refuses and preserves an existing broad Windows directory", {
  skip: process.platform !== "win32",
}, async () => {
  const { root, directory } = await fixture();
  try {
    const adapter = createWindowsFilesystemAdapter();
    grantSyntheticEveryoneRead(directory);
    assert.equal(adapter.inspectPath(directory).broadAccess, true);
    await assert.rejects(
      withExportWorkspaceLease(directory, async () => {}),
      (error) => error instanceof ExportWorkspaceLockError
        && error.code === "export_workspace_lock_invalid",
    );
    assert.equal(adapter.inspectPath(directory).broadAccess, true,
      "the lease refuses an unsafe existing DACL without repair");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
