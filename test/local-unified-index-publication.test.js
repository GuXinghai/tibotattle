import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ingestLocalUnifiedIndexIncrement } from "../src/local-unified-index-ingest.js";
import {
  createUnifiedIndexWriter,
  LOCAL_UNIFIED_INDEX_SNAPSHOT_ORPHAN_MIN_AGE_MS,
  localUnifiedIndexPointerPath,
  openLocalUnifiedIndex,
  openLocalUnifiedIndexRead,
  publishStagedUnifiedIndex,
  removeObsoleteLocalUnifiedIndexSnapshots,
  resolveLocalUnifiedIndexFile,
} from "../src/local-unified-index.js";
import { rebuildLocalUnifiedIndex } from "../src/local-unified-index-build.js";

const code = (expected) => (error) => error?.code === expected;
const windows = process.platform === "win32";
const CONTRACT = "usage-event-v0.2";
const LATER = Date.now() + LOCAL_UNIFIED_INDEX_SNAPSHOT_ORPHAN_MIN_AGE_MS + 60_000;

// A publication that waits for a reader would hang the test instead of failing.
function withinSeconds(promise, seconds = 10) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("publication waited for a reader")), seconds * 1_000);
    }),
  ]);
}

async function createSyntheticIndex(path, marker) {
  const database = openLocalUnifiedIndex(path, { create: true, staging: true });
  const writer = createUnifiedIndexWriter(database, { contractVersion: CONTRACT });
  database.prepare("INSERT INTO meta(key, value) VALUES ('publication_test', ?)").run(marker);
  await writer.close({ fsyncPath: path });
}

function marker(database) {
  return database.prepare("SELECT value FROM meta WHERE key = 'publication_test'").get().value;
}

function readMarker(indexFile) {
  const database = openLocalUnifiedIndex(indexFile, { readOnly: true });
  try { return marker(database); } finally { database.close(); }
}

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "unified-index-publication-"));
  const indexFile = join(root, "published.sqlite");
  try {
    await createSyntheticIndex(indexFile, "gen-1");
    await callback({ root, indexFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function publishMarker(root, indexFile, value) {
  const stage = join(root, `stage-${value}.sqlite`);
  await createSyntheticIndex(stage, value);
  await withinSeconds(publishStagedUnifiedIndex(stage, indexFile));
}

async function names(root) {
  return (await readdir(root)).sort();
}

test("an uncontended publication keeps the single-file layout", async () => {
  await fixture(async ({ root, indexFile }) => {
    await publishMarker(root, indexFile, "gen-2");
    assert.equal(resolveLocalUnifiedIndexFile(indexFile), indexFile);
    assert.deepEqual(await names(root), ["published.sqlite"]);
    assert.equal(readMarker(indexFile), "gen-2");
  });
});

test("publication does not wait for a reader, which keeps the generation it opened", async () => {
  await fixture(async ({ root, indexFile }) => {
    const reader = await openLocalUnifiedIndexRead(indexFile);
    try {
      await publishMarker(root, indexFile, "gen-2");
      assert.equal(marker(reader), "gen-1", "an open reader is never switched mid-read");
      assert.equal(readMarker(indexFile), "gen-2", "a new reader sees the new publication");
      if (windows) {
        // Windows refused to replace the open file, so a pointer names a snapshot.
        assert.notEqual(resolveLocalUnifiedIndexFile(indexFile), indexFile);
        assert.ok((await names(root)).includes("published.sqlite"),
          "the open superseded file is retained while its reader is open");
      }
    } finally {
      reader.close();
    }
  });
});

test("overlapping readers and repeated publications each see one consistent generation", async () => {
  await fixture(async ({ root, indexFile }) => {
    const first = await openLocalUnifiedIndexRead(indexFile);
    let second = null;
    try {
      await publishMarker(root, indexFile, "gen-2");
      second = await openLocalUnifiedIndexRead(indexFile);
      await publishMarker(root, indexFile, "gen-3");
      assert.equal(marker(first), "gen-1");
      assert.equal(marker(second), "gen-2");
      assert.equal(readMarker(indexFile), "gen-3");
    } finally {
      first.close();
      second?.close();
    }
    // Once nothing holds them, every superseded publication is reclaimed.
    await removeObsoleteLocalUnifiedIndexSnapshots(indexFile, { nowMs: LATER });
    const remaining = await names(root);
    const current = basename(resolveLocalUnifiedIndexFile(indexFile));
    assert.deepEqual(
      remaining,
      windows ? [current, "published.sqlite.current"].sort() : ["published.sqlite"],
    );
    assert.equal(readMarker(indexFile), "gen-3");
  });
});

test("cleanup retains a superseded snapshot while it is open and removes it after", { skip: !windows }, async () => {
  await fixture(async ({ root, indexFile }) => {
    const holdLegacy = await openLocalUnifiedIndexRead(indexFile);
    await publishMarker(root, indexFile, "gen-2");
    holdLegacy.close();
    const snapshotReader = await openLocalUnifiedIndexRead(indexFile);
    const held = resolveLocalUnifiedIndexFile(indexFile);
    try {
      await publishMarker(root, indexFile, "gen-3");
      const result = await removeObsoleteLocalUnifiedIndexSnapshots(indexFile, { nowMs: LATER });
      assert.equal(result.retained, 1, "Windows refuses to delete the open snapshot");
      assert.ok((await names(root)).includes(basename(held)));
      assert.equal(marker(snapshotReader), "gen-2");
    } finally {
      snapshotReader.close();
    }
    const result = await removeObsoleteLocalUnifiedIndexSnapshots(indexFile, { nowMs: LATER });
    assert.equal(result.retained, 0);
    assert.equal((await names(root)).includes(basename(held)), false);
  });
});

test("cleanup keeps a recent unreferenced snapshot a concurrent publication may still point at", async () => {
  await fixture(async ({ root, indexFile }) => {
    const reader = await openLocalUnifiedIndexRead(indexFile);
    try {
      await publishMarker(root, indexFile, "gen-2");
    } finally {
      reader.close();
    }
    if (!windows) return;
    const orphan = join(root, `published.sqlite.snapshot-${Date.now().toString(36)}-${"a".repeat(32)}`);
    const old = join(root, `published.sqlite.snapshot-${(Date.now() - 2 * LOCAL_UNIFIED_INDEX_SNAPSHOT_ORPHAN_MIN_AGE_MS).toString(36)}-${"b".repeat(32)}`);
    await writeFile(orphan, "crash orphan", { mode: 0o600 });
    await writeFile(old, "older crash orphan", { mode: 0o600 });
    await removeObsoleteLocalUnifiedIndexSnapshots(indexFile);
    const remaining = await names(root);
    assert.ok(remaining.includes(basename(orphan)), "a young orphan is not yet proven abandoned");
    assert.equal(remaining.includes(basename(old)), false, "an old crash orphan is reclaimed");
    assert.equal(readMarker(indexFile), "gen-2");
  });
});

test("pointer temporaries are reclaimed only when their writer has exited", async () => {
  await fixture(async ({ root, indexFile }) => {
    await writeFile(localUnifiedIndexPointerPath(indexFile), JSON.stringify({
      format: "tibotattle-local-unified-index-pointer-v1",
      snapshot: "published.sqlite.snapshot-0-" + "c".repeat(32),
    }), { mode: 0o600 });
    await createSyntheticIndex(join(root, "published.sqlite.snapshot-0-" + "c".repeat(32)), "pointed");
    const dead = join(root, `published.sqlite.current.tmp-4242-${"d".repeat(16)}`);
    const alive = join(root, `published.sqlite.current.tmp-${process.pid}-${"e".repeat(16)}`);
    await writeFile(dead, "{}", { mode: 0o600 });
    await writeFile(alive, "{}", { mode: 0o600 });
    await removeObsoleteLocalUnifiedIndexSnapshots(indexFile, {
      isProcessAlive: (pid) => pid === process.pid,
    });
    const remaining = await names(root);
    assert.equal(remaining.includes(basename(dead)), false);
    assert.ok(remaining.includes(basename(alive)));
    assert.equal(remaining.includes("published.sqlite"), false, "the superseded single file is reclaimed");
    assert.equal(readMarker(indexFile), "pointed");
  });
});

test("a damaged or redirected pointer fails closed instead of falling back to a stale file", async () => {
  for (const content of [
    "not json",
    JSON.stringify({ format: "tibotattle-local-unified-index-pointer-v1", snapshot: "../elsewhere.sqlite" }),
    JSON.stringify({ format: "tibotattle-local-unified-index-pointer-v1", snapshot: "other.sqlite.snapshot-0-" + "a".repeat(32) }),
    JSON.stringify({ format: "tibotattle-local-unified-index-pointer-v1", snapshot: "published.sqlite.snapshot-0-" + "a".repeat(32), extra: 1 }),
  ]) {
    await fixture(async ({ indexFile }) => {
      await writeFile(localUnifiedIndexPointerPath(indexFile), content, { mode: 0o600 });
      assert.throws(() => resolveLocalUnifiedIndexFile(indexFile), code("local_unified_index_file_invalid"));
      await assert.rejects(openLocalUnifiedIndexRead(indexFile), code("local_unified_index_file_invalid"));
    });
  }
  await fixture(async ({ indexFile }) => {
    await writeFile(localUnifiedIndexPointerPath(indexFile), JSON.stringify({
      format: "tibotattle-local-unified-index-pointer-v1",
      snapshot: "published.sqlite.snapshot-0-" + "f".repeat(32),
    }), { mode: 0o600 });
    await assert.rejects(openLocalUnifiedIndexRead(indexFile), code("local_unified_index_unavailable"),
      "a pointer to a missing snapshot is unavailable, never the superseded file");
  });
});

// The child cases force the Windows sharing refusal at the single-file rename
// and inject faults at the exact snapshot publication boundaries.
function runSnapshotChild(scenario) {
  const moduleUrl = new URL("../src/local-unified-index.js", import.meta.url).href;
  const source = `
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const require = createRequire(import.meta.url);
    const fs = require("node:fs/promises");
    const originalRename = fs.rename;
    const root = await mkdtemp(join(tmpdir(), "unified-snapshot-policy-"));
    const stage = join(root, "stage.sqlite");
    const target = join(root, "published.sqlite");
    const controller = new AbortController();
    const scenario = ${JSON.stringify(scenario)};
    let recoveryLock;
    fs.rename = async (from, to) => {
      if (to === target) throw Object.assign(new Error("synthetic sharing conflict"), { code: "EPERM" });
      if (to.endsWith(".current") && scenario === "pointer-fails") {
        throw Object.assign(new Error("private detail"), { code: "EIO" });
      }
      if (to.includes(".snapshot-")) {
        // Between the snapshot rename and the pointer swap.
        if (scenario === "abort") controller.abort();
        if (scenario === "recovery-lock") await writeFile(recoveryLock, "synthetic recovery lock", { mode: 0o600 });
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const index = await import(${JSON.stringify(moduleUrl)});
    recoveryLock = index.defaultLocalUnifiedIndexRecoveryLockPath(target);
    try {
      await writeFile(target, "old", { mode: 0o600 });
      await writeFile(stage, "new", { mode: 0o600 });
      if (scenario === "stage-changed") {
        // Replace the stage after its identity was captured but before the swap.
        const originalLstat = fs.lstat;
        let calls = 0;
        fs.lstat = async (path, ...rest) => {
          if (path === stage && ++calls === 2) {
            await originalRename(stage, join(root, "previous-stage.sqlite"));
            await writeFile(stage, "replacement-stage", { mode: 0o600 });
          }
          return originalLstat(path, ...rest);
        };
        syncBuiltinESMExports();
      }
      let errorCode = null;
      try { await index.publishStagedUnifiedIndex(stage, target, { signal: controller.signal }); }
      catch (error) { errorCode = error.code; }
      const live = await readFile(index.resolveLocalUnifiedIndexFile(target), "utf8");
      const files = (await readdir(root)).map((name) => name
        .replace(/snapshot-[0-9a-z]+-[0-9a-f]{32}$/u, "snapshot-*")
        .replace(/tmp-[0-9]+-[0-9a-f]{16}$/u, "tmp-*")).sort();
      process.stdout.write(JSON.stringify({ errorCode, live, files }));
    } finally { await rm(root, { recursive: true, force: true }); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("a refused Windows swap publishes a snapshot and points to it", () => {
  const result = runSnapshotChild("success");
  assert.equal(result.errorCode, null);
  assert.equal(result.live, "new");
  // Nothing really holds the superseded file here, so cleanup removes it at once.
  assert.deepEqual(result.files, [
    "published.sqlite.current",
    "published.sqlite.snapshot-*",
  ]);
});

for (const [scenario, expectedCode] of [
  ["pointer-fails", "local_unified_index_publication_failed"],
  ["abort", "local_unified_index_aborted"],
  ["recovery-lock", "local_unified_index_recovery_in_progress"],
]) {
  test(`snapshot publication keeps the old publication live after ${scenario}`, () => {
    const result = runSnapshotChild(scenario);
    assert.equal(result.errorCode, expectedCode);
    assert.equal(result.live, "old", "the pointer never moved");
    // The unreferenced snapshot is an orphan for cleanup; no temporary remains.
    assert.deepEqual(result.files, [
      "published.sqlite",
      "published.sqlite.snapshot-*",
      ...(scenario === "recovery-lock" ? ["published.sqlite.recovery.lock"] : []),
    ].sort());
  });
}

test("a stage replaced before the swap is never published", () => {
  const result = runSnapshotChild("stage-changed");
  assert.equal(result.errorCode, "local_unified_index_file_changed");
  assert.equal(result.live, "old");
});

// The production shape: a long report read holds the live index while a
// refresh ingests new history and publishes it.
function sessionMeta(sessionId) {
  return JSON.stringify({
    timestamp: "2026-07-25T00:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId, session_id: sessionId, thread_source: "user", originator: "codex_cli_rs", cwd: "/Users/nobody/project" },
  });
}

function turnContext(timestamp) {
  return JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: { turn_id: "turn-1", cwd: "/Users/nobody/project", model: "gpt-5.6-sol", effort: "high", summary: "auto" },
  });
}

function tokenCount(timestamp, total, last) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
  });
}

function usage(input) {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: input,
  };
}

function usageEvents(database) {
  return Number(database.prepare("SELECT COUNT(*) AS count FROM usage_event").get().count);
}

test("a refresh publishes new history while a report read holds the index open", async () => {
  const root = await mkdtemp(join(tmpdir(), "unified-index-active-reader-"));
  const sessions = join(root, "sessions", "2026", "07", "25");
  const rollout = join(sessions, "rollout-2026-07-25T00-00-00-active-reader.jsonl");
  const indexFile = join(root, "index.sqlite");
  const options = {
    codexHome: root,
    indexFile,
    secretFile: join(root, "salt"),
    contractVersion: CONTRACT,
  };
  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(rollout, `${[
      sessionMeta("session-active-reader"),
      turnContext("2026-07-25T00:00:00.000Z"),
      tokenCount("2026-07-25T00:00:01.000Z", usage(100), usage(100)),
    ].join("\n")}\n`);
    await rebuildLocalUnifiedIndex(options);
    const report = await openLocalUnifiedIndexRead(indexFile);
    try {
      assert.equal(usageEvents(report), 1);
      for (const [index, total] of [[2, 250], [3, 400]]) {
        await appendFile(rollout, `${tokenCount(`2026-07-25T00:00:0${index}.000Z`, usage(total), usage(150))}\n`);
        const result = await withinSeconds(ingestLocalUnifiedIndexIncrement(options), 60);
        assert.equal(result.status, "ingested");
        assert.equal(result.totalUsageEvents, index);
        const fresh = openLocalUnifiedIndex(indexFile, { readOnly: true });
        try { assert.equal(usageEvents(fresh), index); } finally { fresh.close(); }
      }
      assert.equal(usageEvents(report), 1, "the long read finishes on the generation it opened");
    } finally {
      report.close();
    }
    // A later refresh reclaims what the report held; the live index is intact.
    await removeObsoleteLocalUnifiedIndexSnapshots(indexFile, { nowMs: LATER });
    const after = openLocalUnifiedIndex(indexFile, { readOnly: true });
    try { assert.equal(usageEvents(after), 3); } finally { after.close(); }
    const stray = (await readdir(root)).filter((name) => (
      name.startsWith("index.sqlite") && name !== basename(resolveLocalUnifiedIndexFile(indexFile))
        && name !== "index.sqlite.current"));
    assert.deepEqual(stray, []);
    // An external untracked SQLite handle is treated exactly like our own.
    const external = new DatabaseSync(resolveLocalUnifiedIndexFile(indexFile), { readOnly: true });
    try {
      await appendFile(rollout, `${tokenCount("2026-07-25T00:00:04.000Z", usage(500), usage(100))}\n`);
      const result = await withinSeconds(ingestLocalUnifiedIndexIncrement(options), 60);
      assert.equal(result.totalUsageEvents, 4);
    } finally {
      external.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
