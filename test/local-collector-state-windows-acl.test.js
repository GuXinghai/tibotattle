import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  commitLocalCollectorState,
  readLocalCollectorState,
} from "../src/local-collector-state.js";
import { createWindowsFilesystemAdapter } from "../src/platform/windows-filesystem.js";
import {
  assertWindowsOwnerOnly,
  grantSyntheticEveryoneRead,
} from "./helpers/windows-owner-only-fixture.js";

function selectedAcl(metadata) {
  return Object.fromEntries([
    "isDirectory",
    "isRegularFile",
    "isReparsePoint",
    "ownerMatches",
    "nullDacl",
    "daclProtected",
    "broadAccess",
    "nonOwnerAllow",
    "unrecognizedAce",
    "finalPathResolved",
  ].map((key) => [key, metadata[key]]));
}

test("collector SQLite creates, reopens and commits protected state, rejecting unsafe synthetic paths without repair", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "collector-acl-"));
  const adapter = createWindowsFilesystemAdapter();
  try {
    const protectedDirectory = join(root, "protected-state");
    const stateFile = join(protectedDirectory, "local-collector-state-v1.sqlite");
    await commitLocalCollectorState({ stateFile, checkpoint: {}, records: [] });
    const stateMetadata = assertWindowsOwnerOnly(stateFile);
    assert.equal(stateMetadata.isRegularFile, true);
    await commitLocalCollectorState({
      stateFile,
      checkpoint: { syntheticReopen: true },
      records: [],
    });
    const reopenedMetadata = assertWindowsOwnerOnly(stateFile);
    assert.deepEqual(reopenedMetadata.identity, stateMetadata.identity);

    const preexistingEmptyFile = join(protectedDirectory, "foreign-empty.sqlite");
    adapter.createFile(preexistingEmptyFile, Buffer.alloc(0));
    const emptyFileBefore = adapter.inspectPath(preexistingEmptyFile);
    await assert.rejects(
      commitLocalCollectorState({ stateFile: preexistingEmptyFile, checkpoint: {}, records: [] }),
      { code: "local_collector_state_schema_invalid" },
    );
    assert.deepEqual(await readFile(preexistingEmptyFile), Buffer.alloc(0));
    assert.deepEqual(
      selectedAcl(adapter.inspectPath(preexistingEmptyFile)),
      selectedAcl(emptyFileBefore),
    );

    const unsafeFile = join(protectedDirectory, "unsafe-existing.sqlite");
    const unsafeBytes = Buffer.from("synthetic-existing-bytes");
    await writeFile(unsafeFile, unsafeBytes);
    grantSyntheticEveryoneRead(unsafeFile);
    const unsafeFileBefore = adapter.inspectPath(unsafeFile);
    await assert.rejects(
      readLocalCollectorState({ stateFile: unsafeFile }),
      { code: "local_collector_state_unavailable" },
    );
    const unsafeFileAfter = adapter.inspectPath(unsafeFile);
    assert.deepEqual(await readFile(unsafeFile), unsafeBytes);
    assert.deepEqual(selectedAcl(unsafeFileAfter), selectedAcl(unsafeFileBefore));

    const unsafeDirectory = join(root, "unsafe-state-directory");
    await mkdir(unsafeDirectory);
    grantSyntheticEveryoneRead(unsafeDirectory);
    const unsafeDirectoryBefore = adapter.inspectPath(unsafeDirectory);
    const rejectedDatabase = join(unsafeDirectory, "local-collector-state-v1.sqlite");
    await assert.rejects(
      commitLocalCollectorState({ stateFile: rejectedDatabase, checkpoint: {}, records: [] }),
      { code: "local_collector_state_unavailable" },
    );
    const unsafeDirectoryAfter = adapter.inspectPath(unsafeDirectory);
    assert.deepEqual(selectedAcl(unsafeDirectoryAfter), selectedAcl(unsafeDirectoryBefore));
    await assert.rejects(readFile(rejectedDatabase), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
