import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  acquireProtectedSqliteFiles,
  configureGuardedSqliteConnection,
  loadWindowsLegacyStateReadBinding,
  loadWindowsLocalVolumeQueryBinding,
} from "../src/platform/index.js";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");

test("native volume admission queries only a fixed root and refuses network syntax before I/O", {
  skip: process.platform === "win32" ? false : "native Windows only",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "index-volume-query-"));
  const missing = join(root, "must-not-be-created", "index.sqlite");
  try {
    const native = loadWindowsLocalVolumeQueryBinding();
    assert.equal(native.isFixedLocalVolume(win32.parse(root).root), true);
    assert.equal(native.isFixedLocalVolume(missing), true);
    assert.equal(native.productionSafe, false);
    assert.equal(native.pathWalkRaceSafe, false);
    for (const path of ["relative.sqlite", "C:relative.sqlite", "\\\\synthetic-invalid-server\\share\\file",
      "\\\\?\\C:\\synthetic", "a".repeat(32768)]) {
      assert.throws(() => native.isFixedLocalVolume(path), error => {
        assert.match(error.code, /^WINDOWS_FILESYSTEM_/u);
        assert.equal(error.message, "Windows filesystem operation failed");
        assert.equal(error.message.includes(path), false);
        return true;
      });
    }
    await assert.rejects(stat(missing), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cold WAL-format copy switches to protected PERSIST without unprotected sidecars", {
  skip: process.platform === "win32" ? false : "native Windows only",
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "index-copy-lifecycle-"));
  const native = loadWindowsLegacyStateReadBinding();
  const root = join(temporary, "protected");
  const sourceRoot = join(root, "source");
  const destinationRoot = join(root, "destination");
  const source = join(sourceRoot, "index.sqlite");
  const destination = join(destinationRoot, "index.sqlite");
  let sourceLease, destinationGuard, files, database;
  try {
    native.ensureDirectory(sourceRoot);
    native.ensureDirectory(destinationRoot);
    native.createFile(source, Buffer.alloc(0));
    database = new DatabaseSync(source);
    assert.equal(database.prepare("PRAGMA journal_mode=WAL").get().journal_mode, "wal");
    database.exec("CREATE TABLE retained(value TEXT NOT NULL); INSERT INTO retained VALUES('synthetic');");
    database.close(); database = null;
    assert.deepEqual(await readdir(sourceRoot), ["index.sqlite"]);
    const original = await readFile(source);
    assert.equal(original[18], 2, "fixture has the real WAL database header");
    assert.equal(original[19], 2);

    sourceLease = native.openLegacyStateFile(source);
    destinationGuard = native.acquireProtectedDirectoryGuard(destinationRoot);
    const copied = native.copyLegacyStateFile(sourceLease, destinationRoot,
      destinationGuard.identity, "index.sqlite");
    const sidecars = new Map();
    for (const suffix of ["-wal", "-shm"]) {
      sidecars.set(suffix, native.createFile(destination + suffix, Buffer.alloc(0)));
      const metadata = native.inspectPath(destination + suffix);
      assert.equal(metadata.daclProtected, true);
      assert.equal(metadata.ownerMatches, true);
      assert.equal(metadata.nonOwnerAllow, false);
      assert.equal(metadata.identity.linkCount, 1);
    }
    files = acquireProtectedSqliteFiles({ native, path: destination });
    database = new DatabaseSync(destination);
    configureGuardedSqliteConnection(database);
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "persist");
    database.exec("PRAGMA journal_size_limit=0; ALTER TABLE retained ADD COLUMN provenance TEXT;");
    assert.deepEqual({ ...database.prepare("SELECT * FROM retained").get() },
      { value: "synthetic", provenance: null });
    for (const suffix of ["-wal", "-shm"]) {
      try {
        assert.equal((await stat(destination + suffix)).size, 0);
        assert.deepEqual(native.inspectPath(destination + suffix).identity, sidecars.get(suffix));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    for (const path of [destination, destination + "-journal"]) {
      const metadata = native.inspectPath(path);
      assert.equal(metadata.daclProtected, true);
      assert.equal(metadata.ownerMatches, true);
      assert.equal(metadata.nonOwnerAllow, false);
      assert.equal(metadata.identity.linkCount, 1);
    }
    assert.deepEqual(native.inspectPath(destination).identity, copied);
    database.close(); database = null;
    files.release(); files = null;
    // SQLite may leave the unused precreated WAL/SHM files. Only after close,
    // remove these exact empty files by their natively validated identities.
    for (const suffix of ["-wal", "-shm"]) {
      try {
        assert.equal((await stat(destination + suffix)).size, 0);
        native.deleteFile(destination + suffix, sidecars.get(suffix));
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "WINDOWS_FILESYSTEM_NOT_FOUND") throw error;
      }
    }
    assert.equal((await stat(destination + "-journal")).size, 0);
    assert.deepEqual((await readdir(destinationRoot)).sort(), ["index.sqlite", "index.sqlite-journal"]);
    const converted = await readFile(destination);
    assert.equal(converted[18], 1, "PERSIST conversion leaves a non-WAL database header");
    assert.equal(converted[19], 1);
    database = new DatabaseSync(destination, { readOnly: true });
    assert.equal(database.prepare("PRAGMA journal_mode").get().journal_mode, "delete",
      "a reopened reader does not retain the writer's per-connection PERSIST policy");
    database.close(); database = null;
    assert.equal(sha(await readFile(source)), sha(original));
    assert.deepEqual(await readdir(sourceRoot), ["index.sqlite"]);
  } finally {
    // Fixture cleanup follows SQLite close and native lease release.
    database?.close();
    files?.release();
    if (sourceLease) native.closeSourceFile(sourceLease);
    if (destinationGuard) native.releaseProtectedDirectoryGuard(destinationGuard.guard);
    await rm(temporary, { recursive: true, force: true });
  }
});
