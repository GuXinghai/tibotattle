import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { maintainLocalIndex } from "../src/local-index-maintenance.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { auditWorkRollups, WORK_ROLLUP_TRIGGER_NAMES } from "../src/local-index-work-rollup.js";
import { auditWorkloadBuckets } from "../src/local-index-workload-bucket.js";
import {
  createLocalIndexWriter, openLocalIndexStore, upgradeLocalIndexV9ToV10,
} from "../src/local-index-store.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const IMPACT_TABLES = [
  "publication", "source_change", "change_fact_count", "impact_partition",
  "integrity_gap", "projection_watermark", "repair_queue",
];

function downgradeToV9(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const name of [
      "workload_bucket_insert", "workload_bucket_delete", "workload_bucket_update",
      "workload_bucket_cursor_advance", "workload_bucket_cursor_retreat",
      "work_rollup_insert", "work_rollup_delete", "work_rollup_update",
      "work_rollup_cursor_advance", "work_rollup_cursor_retreat",
    ]) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec("DROP TABLE IF EXISTS workload_bucket");
    db.exec("DROP TABLE IF EXISTS work_rollup");
    for (const table of [...IMPACT_TABLES].reverse()) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    db.prepare(`DELETE FROM meta WHERE key IN (
      'impact_schema_version', 'impact_manifest_since_change_id',
      'work_rollup_schema_version', 'workload_bucket_schema_version')`).run();
    db.exec("PRAGMA user_version=9");
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

// v9 installed these triggers on `usage_event` and `source`; dropping the
// derived table does not remove them. The old conflict key omits `tier_id`.
function installLegacyWorkRollupTriggers(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE work_rollup(
        day_ms INTEGER NOT NULL, session_id INTEGER NOT NULL,
        work_directory_id INTEGER NOT NULL, model_id INTEGER NOT NULL,
        account_scope_id INTEGER NOT NULL, shape INTEGER NOT NULL,
        ctx_class INTEGER NOT NULL, prov INTEGER NOT NULL,
        events INTEGER NOT NULL,
        PRIMARY KEY(day_ms, session_id, work_directory_id, model_id,
                    account_scope_id, shape, ctx_class, prov)
      ) STRICT, WITHOUT ROWID`);
    const body = `BEGIN
      INSERT INTO work_rollup(day_ms, session_id, work_directory_id, model_id,
        account_scope_id, shape, ctx_class, prov, events)
      VALUES (0, 0, 0, 0, 0, 0, 0, 0, 1)
      ON CONFLICT(day_ms, session_id, work_directory_id, model_id,
        account_scope_id, shape, ctx_class, prov) DO NOTHING;
    END;`;
    db.exec(`CREATE TRIGGER work_rollup_insert AFTER INSERT ON usage_event ${body}`);
    db.exec(`CREATE TRIGGER work_rollup_delete AFTER DELETE ON usage_event ${body}`);
    db.exec(`CREATE TRIGGER work_rollup_update AFTER UPDATE ON usage_event ${body}`);
    db.exec(`CREATE TRIGGER work_rollup_cursor_advance
      AFTER UPDATE OF scanned_bytes ON source ${body}`);
    db.exec(`CREATE TRIGGER work_rollup_cursor_retreat
      AFTER UPDATE OF scanned_bytes ON source ${body}`);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* keep the original failure */ }
    throw error;
  } finally {
    db.close();
  }
}

function userVersion(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number(db.prepare("PRAGMA user_version").get().user_version); }
  finally { db.close(); }
}

function copyStore(sourceFile, targetFile) {
  const db = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    const target = targetFile.replaceAll("\\", "/").replaceAll("'", "''");
    db.exec(`VACUUM INTO '${target}'`);
  } finally {
    db.close();
  }
}

function counts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries([
      "source", "usage_event", "quota_occurrence", "work_lifecycle_fact",
    ].map((table) => [table, Number(db.prepare(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ).get().n)]));
  } finally {
    db.close();
  }
}

test("a protected v9 copy upgrades atomically and matches the original facts", async () => {
  const workspace = createWorkspace({ files: 2, events: 30, days: 2, seed: 71 });
  try {
    const original = join(workspace.state, "original.sqlite");
    const copy = join(workspace.state, "rehearsal.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: original,
      secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    downgradeToV9(original);

    const before = counts(original);
    copyStore(original, copy);
    assert.throws(() => openLocalIndexStore(original, { readOnly: true }), {
      code: "local_index_family_mismatch",
    });
    assert.equal(userVersion(original), 9);

    const migrated = openLocalIndexStore(copy);
    try {
      assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 11);
      assert.equal(migrated.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.equal(migrated.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally {
      migrated.close();
    }
    assert.deepEqual(counts(copy), before);

    let maintained;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      maintained = await maintainLocalIndex({
        indexFile: copy, maxBackfillBatches: 8, maxBackfillEvents: 1_000,
      });
      if (maintained.status !== "pending") break;
    }
    assert.notEqual(maintained.status, "pending", JSON.stringify(maintained));

    const database = openLocalIndexStore(copy, { readOnly: true });
    try {
      assert.deepEqual(
        database.prepare("SELECT projection_name, status FROM projection_watermark ORDER BY projection_name").all()
          .map((row) => [row.projection_name, row.status]),
        [["work_rollup", "ready"], ["workload_bucket", "ready"]],
      );
      assert.equal(auditWorkRollups(database), 0);
      assert.equal(auditWorkloadBuckets(database), 0);
    } finally {
      database.close();
    }
    assert.deepEqual(counts(original), before);
    assert.equal(userVersion(original), 9);
  } finally {
    workspace.cleanup();
  }
});

test("v10 -> v11 replaces legacy work_rollup triggers before installing its own", async () => {
  const workspace = createWorkspace({ files: 1, events: 12, days: 1, seed: 72 });
  try {
    const file = join(workspace.state, "legacy-triggers.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: file,
      secretFile: workspace.secretFile, workerCount: 1,
    });
    downgradeToV9(file);

    const v10 = new DatabaseSync(file);
    try { upgradeLocalIndexV9ToV10(v10); } finally { v10.close(); }
    installLegacyWorkRollupTriggers(file);
    assert.equal(userVersion(file), 10);

    const migrated = openLocalIndexStore(file);
    try {
      assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 11);
      const triggers = migrated.prepare(`
        SELECT name, sql FROM sqlite_master
        WHERE type='trigger' AND name IN (${WORK_ROLLUP_TRIGGER_NAMES.map(() => "?").join(",")})`)
        .all(...WORK_ROLLUP_TRIGGER_NAMES);
      assert.deepEqual(triggers.map((row) => row.name).sort(),
        [...WORK_ROLLUP_TRIGGER_NAMES].sort());
      for (const trigger of triggers) {
        assert.match(trigger.sql, /tier_id/u, trigger.name);
        assert.doesNotMatch(trigger.sql,
          /ON CONFLICT\(day_ms, session_id, work_directory_id, model_id,\s*account_scope_id, shape, ctx_class, prov\)/u,
          trigger.name);
      }
      assert.doesNotThrow(() => createLocalIndexWriter(migrated));
      assert.doesNotThrow(() =>
        migrated.prepare("UPDATE source SET scanned_bytes = scanned_bytes WHERE 0"));
    } finally {
      migrated.close();
    }
  } finally {
    workspace.cleanup();
  }
});
