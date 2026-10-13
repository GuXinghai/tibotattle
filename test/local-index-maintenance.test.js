import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { createLocalIndexBackend } from "../src/local-index-backend.js";
import { maintainLocalIndex } from "../src/local-index-maintenance.js";
import { createWorkspace, v2Facts } from "./helpers/local-index-facts.js";

async function fixture() {
  const workspace = createWorkspace({ variety: true, files: 6, events: 180, days: 4 });
  const indexFile = join(workspace.state, "v2.sqlite");
  const backend = createLocalIndexBackend({ indexFile, secretFile: workspace.secretFile, workerCount: 1 });
  await backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });
  return { workspace, indexFile, backend };
}

function mutate(file, sql) {
  const database = new DatabaseSync(file);
  try { database.exec(sql); } finally { database.close(); }
}

test("worker repairs all derived tables without changing facts or carried identities", async () => {
  const { workspace, indexFile, backend } = await fixture();
  try {
    const facts = v2Facts(indexFile, { workDirectories: true });
    const clean = backend.audit();
    mutate(indexFile, "DELETE FROM usage_rollup; DELETE FROM work_rollup; DELETE FROM cache_candidate; DELETE FROM session_positive");
    const result = await maintainLocalIndex({ indexFile });
    assert.equal(result.status, "repaired");
    assert.equal(result.consistent, true);
    assert.ok(result.rollup > 0 && result.work > 0 && result.pairing > 0);
    assert.equal(result.commitSeq, clean.commitSeq + 1);
    assert.deepEqual(v2Facts(indexFile, { workDirectories: true }), facts);
    assert.equal(backend.audit().consistent, true);
    const repeated = await maintainLocalIndex({ indexFile });
    assert.equal(repeated.status, "audited");
    assert.equal(repeated.commitSeq, result.commitSeq, "clean audits never advance publication");
    assert.deepEqual(Object.keys(result).sort(), ["commitSeq", "consistent", "pairing", "rollup", "status", "work"]);
    assert.ok(!JSON.stringify(result).includes(workspace.root));
  } finally { workspace.cleanup(); }
});

test("failed repair rolls back every derived table and can be retried", async () => {
  const { workspace, indexFile, backend } = await fixture();
  try {
    const facts = v2Facts(indexFile);
    mutate(indexFile, `DELETE FROM usage_rollup; DELETE FROM work_rollup;
      CREATE TRIGGER reject_repair BEFORE INSERT ON work_rollup BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END;`);
    const before = backend.audit();
    await assert.rejects(maintainLocalIndex({ indexFile }), { code: "local_index_maintenance_failed" });
    assert.deepEqual(backend.audit(), before, "earlier usage rebuild is rolled back too");
    assert.deepEqual(v2Facts(indexFile), facts);
    mutate(indexFile, "DROP TRIGGER reject_repair");
    assert.equal((await maintainLocalIndex({ indexFile })).status, "repaired");
  } finally { workspace.cleanup(); }
});

test("nonpositive orphan pairing rows are drift and are repaired", async () => {
  const { workspace, indexFile, backend } = await fixture();
  try {
    mutate(indexFile, "INSERT INTO session_positive(session_id, source_id, events) VALUES (9999, 9999, -5)");
    assert.equal(backend.audit().consistent, false);
    const result = await maintainLocalIndex({ indexFile });
    assert.equal(result.status, "repaired");
    assert.ok(result.pairing > 0);
    assert.equal(backend.audit().consistent, true);
  } finally { workspace.cleanup(); }
});

test("pinned WAL pressure defers repair without publication and allows a later retry", async () => {
  const { workspace, indexFile, backend } = await fixture();
  const reader = new DatabaseSync(indexFile, { readOnly: true });
  try {
    reader.exec("BEGIN");
    reader.prepare("SELECT commit_seq FROM store_state").get();
    mutate(indexFile, "DELETE FROM usage_rollup");
    const before = backend.audit();
    await assert.rejects(maintainLocalIndex({ indexFile, walLimits: {
      softBytes: 0, hardBytes: 1, freeDiskFraction: null,
    } }), { code: "local_index_maintenance_deferred" });
    assert.deepEqual(backend.audit(), before);
    reader.exec("ROLLBACK");
    assert.equal((await maintainLocalIndex({ indexFile })).status, "repaired");
  } finally { reader.close(); workspace.cleanup(); }
});

test("cancelling a worker waiting on a writer releases its handle and preserves state", async () => {
  const { workspace, indexFile, backend } = await fixture();
  const lock = new DatabaseSync(indexFile);
  try {
    mutate(indexFile, "DELETE FROM usage_rollup");
    const before = backend.audit();
    lock.exec("BEGIN IMMEDIATE");
    const controller = new AbortController();
    const pending = maintainLocalIndex({ indexFile, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 150);
    try { await assert.rejects(pending, { code: "local_index_maintenance_cancelled" }); }
    finally { clearTimeout(timer); }
    lock.exec("ROLLBACK");
    assert.deepEqual(backend.audit(), before);
    assert.equal((await maintainLocalIndex({ indexFile })).status, "repaired");
  } finally { lock.close(); workspace.cleanup(); }
});

test("missing or incompatible stores fail closed without creating or relabeling them", async () => {
  const workspace = createWorkspace({ files: 1, events: 1 });
  try {
    const indexFile = join(workspace.state, "missing.sqlite");
    await assert.rejects(maintainLocalIndex({ indexFile }), { code: "local_index_maintenance_failed" });
    const database = new DatabaseSync(indexFile);
    database.exec("PRAGMA user_version = 999; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('preserved')");
    database.close();
    await assert.rejects(maintainLocalIndex({ indexFile }), { code: "local_index_maintenance_failed" });
    const check = new DatabaseSync(indexFile, { readOnly: true });
    try {
      assert.equal(check.prepare("PRAGMA user_version").get().user_version, 999);
      assert.equal(check.prepare("SELECT value FROM sentinel").get().value, "preserved");
    } finally { check.close(); }
  } finally { workspace.cleanup(); }
});

test("backend audits first refresh and daily, retries failures and invalidates repaired publications", async () => {
  const { workspace, indexFile } = await fixture();
  let clock = Date.parse("2026-09-02T00:00:00Z");
  let calls = 0;
  let fail = false;
  const backend = createLocalIndexBackend({
    indexFile, secretFile: workspace.secretFile, workerCount: 1, now: () => clock,
    maintenance: async options => {
      calls += 1;
      if (fail) throw new Error("synthetic_failure");
      return maintainLocalIndex(options);
    },
  });
  const refresh = () => backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });
  try {
    const first = await refresh();
    assert.equal(calls, 1);
    await refresh();
    assert.equal(calls, 1);
    clock += 86_400_000;
    fail = true;
    await assert.rejects(refresh(), /synthetic_failure/u);
    assert.equal(calls, 2);
    fail = false;
    mutate(indexFile, "DELETE FROM usage_rollup");
    const repaired = await refresh();
    assert.equal(calls, 3);
    assert.equal(repaired.unchanged, false);
    assert.ok(repaired.generation.id > first.generation.id);
    assert.notEqual(repaired.generation.fingerprint, first.generation.fingerprint);
    await refresh();
    assert.equal(calls, 3);
    const restarted = createLocalIndexBackend({ indexFile, secretFile: workspace.secretFile, workerCount: 1 });
    mutate(indexFile, "DELETE FROM work_rollup");
    await restarted.refreshUnifiedIndex({ codexHome: workspace.codexHome });
    assert.equal(restarted.audit().consistent, true, "restart schedules an audit even after clean shutdown");
  } finally { workspace.cleanup(); }
});
