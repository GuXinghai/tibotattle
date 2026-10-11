import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createLocalUnifiedIndexPublicationCoordinator } from "../src/local-unified-index-publication.js";
import {
  createUnifiedIndexWriter,
  openLocalUnifiedIndex,
  openLocalUnifiedIndexRead,
  publishStagedUnifiedIndex,
  trackLocalUnifiedIndexReadConnection,
} from "../src/local-unified-index.js";

const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const code = (expected) => (error) => error?.code === expected;

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function fakeDatabase({ failClose = false } = {}) {
  return {
    isOpen: true,
    failClose,
    close() {
      if (this.failClose) throw new Error("synthetic close failed");
      this.isOpen = false;
    },
  };
}

test("Windows publication drains actual readers and gates new readers until publication settles", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-gate.sqlite");
  const existing = coordinator.trackReader(path, fakeDatabase());
  const entered = deferred();
  const release = deferred();
  const events = [];
  const publication = coordinator.publish(path, async () => {
    events.push("publish");
    entered.resolve();
    await release.promise;
  });
  let opened = false;
  const reader = coordinator.openReader(path, () => {
    opened = true;
    events.push("read");
    return coordinator.trackReader(path, fakeDatabase());
  });
  assert.throws(() => coordinator.assertReadable(path), code("local_unified_index_publication_busy"));
  await delay();
  assert.equal(opened, false);
  assert.deepEqual(events, []);
  existing.close();
  await entered.promise;
  assert.equal(opened, false);
  release.resolve();
  await publication;
  const next = await reader;
  assert.deepEqual(events, ["publish", "read"]);
  let nextPublished = false;
  const nextPublication = coordinator.publish(path, () => { nextPublished = true; });
  await delay();
  assert.equal(nextPublished, false, "queued reader remains registered after old publication state is released");
  next.close();
  await nextPublication;
  assert.equal(nextPublished, true);
});

test("a second Windows publisher is refused rather than publishing a potentially obsolete stage later", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-two.sqlite");
  const release = deferred();
  const entered = deferred();
  const first = coordinator.publish(path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let secondCalled = false;
  await assert.rejects(coordinator.publish(path, () => { secondCalled = true; }), code("local_unified_index_publication_busy"));
  assert.equal(secondCalled, false);
  release.resolve();
  await first;
  await coordinator.publish(path, () => { secondCalled = true; });
  assert.equal(secondCalled, true);
});

test("publication timeout releases queued readers but never closes or publishes across an active reader", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-timeout.sqlite");
  const existing = coordinator.trackReader(path, fakeDatabase());
  let published = false;
  const publication = assert.rejects(coordinator.publish(path, () => { published = true; }, { timeoutMs: 40 }), code("local_unified_index_publication_timed_out"));
  const queued = coordinator.openReader(path, () => coordinator.trackReader(path, fakeDatabase()));
  await publication;
  assert.equal(published, false);
  assert.equal(existing.isOpen, true);
  const next = await queued;
  coordinator.assertReadable(path);
  next.close();
  existing.close();
  await coordinator.publish(path, () => { published = true; });
  assert.equal(published, true);
});

test("cancelling Windows publication releases its barrier without closing active readers", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-abort.sqlite");
  const existing = coordinator.trackReader(path, fakeDatabase());
  const controller = new AbortController();
  let called = false;
  const publication = assert.rejects(coordinator.publish(path, () => { called = true; }, { signal: controller.signal }), code("local_unified_index_aborted"));
  const nextReader = coordinator.openReader(path, () => fakeDatabase());
  controller.abort();
  await publication;
  const next = await nextReader;
  assert.equal(called, false);
  assert.equal(existing.isOpen, true);
  coordinator.assertReadable(path);
  existing.close();
  next.close();
});

test("cancelling a queued reader never opens a database and does not cancel publication", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-reader-abort.sqlite");
  const release = deferred();
  const entered = deferred();
  const publication = coordinator.publish(path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const controller = new AbortController();
  let opened = false;
  const reader = assert.rejects(coordinator.openReader(path, () => { opened = true; }, { signal: controller.signal }), code("local_unified_index_aborted"));
  controller.abort();
  await reader;
  assert.equal(opened, false);
  assert.throws(() => coordinator.assertReadable(path), code("local_unified_index_publication_busy"));
  release.resolve();
  await publication;
  coordinator.assertReadable(path);
});

test("a failed close which leaves SQLite open cannot release publication admission", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-close-failure.sqlite");
  const existing = coordinator.trackReader(path, fakeDatabase({ failClose: true }));
  let called = false;
  const publication = coordinator.publish(path, () => { called = true; });
  assert.throws(() => existing.close(), /synthetic close failed/u);
  await delay();
  assert.equal(existing.isOpen, true);
  assert.equal(called, false);
  existing.failClose = false;
  existing.close();
  await publication;
  assert.equal(called, true);
});

test("publication waits for every reader rather than only the first connection closed", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-multiple-readers.sqlite");
  const first = coordinator.trackReader(path, fakeDatabase());
  const second = coordinator.trackReader(path, fakeDatabase());
  let published = false;
  const publication = coordinator.publish(path, () => { published = true; });
  first.close();
  await delay();
  assert.equal(published, false);
  second.close();
  await publication;
  assert.equal(published, true);
});

test("late connection registration fails closed and closes the newly supplied handle", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-late-reader.sqlite");
  const release = deferred();
  const entered = deferred();
  const publication = coordinator.publish(path, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const late = fakeDatabase();
  assert.throws(() => coordinator.trackReader(path, late), code("local_unified_index_publication_busy"));
  assert.equal(late.isOpen, false);
  release.resolve();
  await publication;
});

test("operation failure releases publication admission for subsequent readers and publication", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-publication-operation-failure.sqlite");
  await assert.rejects(coordinator.publish(path, () => { throw new Error("synthetic operation failure"); }), /synthetic operation failure/u);
  coordinator.assertReadable(path);
  const database = await coordinator.openReader(path, () => coordinator.trackReader(path, fakeDatabase()));
  database.close();
  assert.equal(await coordinator.publish(path, () => "next"), "next");
});

test("publication barriers are path-specific and Windows path casing shares a barrier", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "win32" });
  const path = join(tmpdir(), "synthetic-PUBLICATION-case.sqlite");
  const existing = coordinator.trackReader(path, fakeDatabase());
  const publication = coordinator.publish(path.toLowerCase(), () => "done");
  assert.throws(() => coordinator.assertReadable(path), code("local_unified_index_publication_busy"));
  coordinator.assertReadable(`${path}.other`);
  assert.equal(await coordinator.publish(`${path}.other`, () => "independent"), "independent");
  existing.close();
  assert.equal(await publication, "done");
});

test("other platforms preserve open-reader behavior without Windows publication gating", async () => {
  const coordinator = createLocalUnifiedIndexPublicationCoordinator({ platform: "linux" });
  const path = join(tmpdir(), "synthetic-publication-posix.sqlite");
  const database = fakeDatabase();
  const originalClose = database.close;
  assert.equal(coordinator.trackReader(path, database), database);
  assert.equal(database.close, originalClose);
  const release = deferred();
  const publication = coordinator.publish(path, () => release.promise);
  coordinator.assertReadable(path);
  assert.equal(await coordinator.openReader(path, () => "read"), "read");
  release.resolve();
  await publication;
  assert.equal(database.isOpen, true);
  database.close();
});

async function createSyntheticIndex(path, marker) {
  const database = openLocalUnifiedIndex(path, { create: true, staging: true });
  const writer = createUnifiedIndexWriter(database, { contractVersion: "usage-event-v0.2" });
  database.prepare("INSERT INTO meta(key, value) VALUES ('publication_test', ?)").run(marker);
  await writer.close({ fsyncPath: path });
}

async function publicationFixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "unified-index-publication-"));
  const indexFile = join(root, "published.sqlite");
  const stageFile = join(root, "stage.sqlite");
  try {
    await createSyntheticIndex(indexFile, "old");
    await createSyntheticIndex(stageFile, "new");
    await callback({ indexFile, stageFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function marker(database) {
  return database.prepare("SELECT value FROM meta WHERE key = 'publication_test'").get().value;
}

const windowsOnly = { skip: process.platform !== "win32" };

test("physical Windows tracked SQLite reader drains before replacement and new async readers see the published file", windowsOnly, async () => {
  await publicationFixture(async ({ indexFile, stageFile }) => {
    const existing = openLocalUnifiedIndex(indexFile, { readOnly: true });
    let next = null;
    try {
      assert.equal(marker(existing), "old");
      let settled = false;
      const publication = publishStagedUnifiedIndex(stageFile, indexFile, { publicationTimeoutMs: 2_000 }).then(() => { settled = true; });
      let opened = false;
      let openedMetadata = null;
      const pendingReader = openLocalUnifiedIndexRead(indexFile, {
        onOpened: (metadata) => { openedMetadata = metadata; },
      }).then((database) => { opened = true; next = database; return database; });
      await delay(50);
      assert.equal(settled, false);
      assert.equal(opened, false);
      assert.equal(marker(existing), "old");
      assert.throws(() => openLocalUnifiedIndex(indexFile, { readOnly: true }), code("local_unified_index_publication_busy"));
      existing.close();
      await publication;
      await pendingReader;
      assert.equal(marker(next), "new");
      assert.equal(openedMetadata.ino, (await stat(indexFile)).ino,
        "waiting readers receive the validated identity of the new publication");
      await assert.rejects(stat(stageFile), { code: "ENOENT" });
    } finally {
      if (existing.isOpen) existing.close();
      if (next?.isOpen) next.close();
    }
  });
});

test("physical Windows publication also drains manually tracked SQLite readers", windowsOnly, async () => {
  await publicationFixture(async ({ indexFile, stageFile }) => {
    const existing = trackLocalUnifiedIndexReadConnection(indexFile, new DatabaseSync(indexFile, { readOnly: true }));
    try {
      let settled = false;
      const publication = publishStagedUnifiedIndex(stageFile, indexFile, { publicationTimeoutMs: 2_000 }).then(() => { settled = true; });
      await delay(40);
      assert.equal(settled, false);
      existing.close();
      await publication;
    } finally {
      if (existing.isOpen) existing.close();
    }
    const next = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try { assert.equal(marker(next), "new"); }
    finally { next.close(); }
  });
});

test("physical Windows external SQLite sharing conflict retries after the untracked handle closes", windowsOnly, async () => {
  await publicationFixture(async ({ indexFile, stageFile }) => {
    const external = new DatabaseSync(indexFile, { readOnly: true });
    assert.equal(marker(external), "old");
    let settled = false;
    const publication = publishStagedUnifiedIndex(stageFile, indexFile, { publicationTimeoutMs: 2_000 }).then(() => { settled = true; });
    try {
      await delay(100);
      assert.equal(settled, false);
      assert.equal(marker(external), "old");
      external.close();
      await publication;
    } finally {
      if (external.isOpen) external.close();
    }
    const next = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try { assert.equal(marker(next), "new"); }
    finally { next.close(); }
  });
});

test("physical Windows exhausted external-sharing budget preserves old publication and stage", windowsOnly, async () => {
  await publicationFixture(async ({ indexFile, stageFile }) => {
    const before = await readFile(indexFile);
    const candidate = await readFile(stageFile);
    const external = new DatabaseSync(indexFile, { readOnly: true });
    try {
      assert.equal(marker(external), "old");
      await assert.rejects(publishStagedUnifiedIndex(stageFile, indexFile, { publicationTimeoutMs: 200 }), code("local_unified_index_publication_timed_out"));
      assert.deepEqual(await readFile(indexFile), before);
      assert.deepEqual(await readFile(stageFile), candidate);
      assert.equal(external.isOpen, true);
      external.close();
      await publishStagedUnifiedIndex(stageFile, indexFile, { publicationTimeoutMs: 2_000 });
    } finally {
      if (external.isOpen) external.close();
    }
  });
});

test("physical Windows cancellation during external-sharing retry preserves both files and permits explicit retry", windowsOnly, async () => {
  await publicationFixture(async ({ indexFile, stageFile }) => {
    const before = await readFile(indexFile);
    const candidate = await readFile(stageFile);
    const external = new DatabaseSync(indexFile, { readOnly: true });
    const controller = new AbortController();
    let abortTimer;
    try {
      assert.equal(marker(external), "old");
      const pending = assert.rejects(publishStagedUnifiedIndex(stageFile, indexFile, { signal: controller.signal }), code("local_unified_index_aborted"));
      abortTimer = setTimeout(() => controller.abort(), 100);
      await pending;
      assert.deepEqual(await readFile(indexFile), before);
      assert.deepEqual(await readFile(stageFile), candidate);
      external.close();
      await publishStagedUnifiedIndex(stageFile, indexFile, { publicationTimeoutMs: 2_000 });
    } finally {
      clearTimeout(abortTimer);
      if (external.isOpen) external.close();
    }
  });
});

// These child cases inject sharing errors and adversarial changes at the exact
// rename boundary. Physical Windows SQLite behavior is independently tested
// above; changing the platform here is only for deterministic policy coverage.
function runPublicationChild(scenario) {
  const moduleUrl = new URL("../src/local-unified-index.js", import.meta.url).href;
  const source = `
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import { mkdtemp, rm, writeFile, readFile, lstat } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const fs = require("node:fs/promises");
    const originalRename = fs.rename;
    const originalOpen = fs.open;
    const root = await mkdtemp(join(tmpdir(), "unified-publication-policy-"));
    const stage = join(root, "stage.sqlite");
    const target = join(root, "published.sqlite");
    const controller = new AbortController();
    const scenario = ${JSON.stringify(scenario)};
    let attempts = 0;
    let firstAttemptAt = null;
    let recoveryLock;
    fs.open = async (path, ...rest) => {
      const metadata = await lstat(path);
      if (metadata.isDirectory()) throw Object.assign(new Error("synthetic directory sync unavailable"), { code: "EPERM" });
      const handle = await originalOpen(path, ...rest);
      if (scenario === "deadline-during-sync" && path === stage) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await new Promise((resolve) => setTimeout(resolve, 300)); await sync(); };
      }
      return handle;
    };
    fs.rename = async (from, to) => {
      attempts += 1;
      if (scenario === "target-changed" && attempts === 1) {
        await originalRename(target, join(root, "previous.sqlite"));
        await writeFile(target, "replacement", { mode: 0o600 });
      }
      if (scenario === "stage-changed" && attempts === 1) {
        await originalRename(stage, join(root, "previous-stage.sqlite"));
        await writeFile(stage, "replacement-stage", { mode: 0o600 });
      }
      if (scenario === "recovery-lock" && attempts === 1) await writeFile(recoveryLock, "synthetic recovery lock", { mode: 0o600 });
      if (scenario === "abort" && attempts === 1) controller.abort();
      if (scenario === "nontransient") throw Object.assign(new Error("private arbitrary error must not escape"), { code: "EIO" });
      if (scenario === "retry-success" && attempts > 1) return originalRename(from, to);
      if (scenario === "long-sharing") {
        firstAttemptAt ??= Date.now();
        if (Date.now() - firstAttemptAt > 5_500) return originalRename(from, to);
      }
      throw Object.assign(new Error("synthetic sharing conflict"), { code: "EPERM" });
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { publishStagedUnifiedIndex, defaultLocalUnifiedIndexRecoveryLockPath } = await import(${JSON.stringify(moduleUrl)});
    recoveryLock = defaultLocalUnifiedIndexRecoveryLockPath(target);
    try {
      await writeFile(target, "old", { mode: 0o600 });
      await writeFile(stage, "new", { mode: 0o600 });
      let errorCode = null;
      try { await publishStagedUnifiedIndex(stage, target, { publicationTimeoutMs: scenario === "long-sharing" ? 12_000 : 250, signal: controller.signal }); }
      catch (error) { errorCode = error.code; }
      const stageValue = await readFile(stage, "utf8").catch((error) => error.code === "ENOENT" ? null : "unknown");
      const targetValue = await readFile(target, "utf8");
      process.stdout.write(JSON.stringify({ errorCode, attempts, stageValue, targetValue }));
    } finally { await rm(root, { recursive: true, force: true }); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Windows rename policy retries transient sharing failures and retains the atomic target replacement", () => {
  assert.deepEqual(runPublicationChild("retry-success"), { errorCode: null, attempts: 2, stageValue: null, targetValue: "new" });
});

test("Windows rename policy keeps retrying a sharing conflict past five seconds within the publication budget", () => {
  const result = runPublicationChild("long-sharing");
  assert.equal(result.errorCode, null);
  assert.equal(result.targetValue, "new");
  assert.equal(result.stageValue, null);
  assert.equal(result.attempts > 10, true);
});

for (const scenario of ["target-changed", "stage-changed", "recovery-lock", "abort", "nontransient", "timeout", "deadline-during-sync"]) {
  test(`Windows retry policy fails closed after ${scenario}`, () => {
    const result = runPublicationChild(scenario);
    const expectedCode = {
      "target-changed": "local_unified_index_file_changed",
      "stage-changed": "local_unified_index_file_changed",
      "recovery-lock": "local_unified_index_recovery_in_progress",
      abort: "local_unified_index_aborted",
      nontransient: "local_unified_index_publication_failed",
      timeout: "local_unified_index_publication_timed_out",
      "deadline-during-sync": "local_unified_index_publication_timed_out",
    }[scenario];
    assert.equal(result.errorCode, expectedCode);
    assert.equal(result.targetValue, scenario === "target-changed" ? "replacement" : "old");
    assert.equal(result.stageValue, scenario === "stage-changed" ? "replacement-stage" : "new");
    if (scenario === "deadline-during-sync") assert.equal(result.attempts, 0);
    else {
      assert.equal(result.attempts >= 1, true);
      if (scenario !== "timeout") assert.equal(result.attempts, 1);
    }
  });
}
