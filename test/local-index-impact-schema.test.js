import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createLocalIndexImpactSchema,
  pruneImpactManifest,
} from "../src/local-index-impact.js";
import {
  createLocalIndexWriter,
  LOCAL_INDEX_STORE_USER_VERSION,
  openLocalIndexStore,
  upgradeLocalIndexV9ToV10,
  upgradeLocalIndexV10ToV11,
} from "../src/local-index-store.js";

const IMPACT_TABLES = [
  "publication",
  "source_change",
  "change_fact_count",
  "impact_partition",
  "integrity_gap",
  "projection_watermark",
  "repair_queue",
];

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "local-index-impact-"));
  return {
    root,
    file: join(root, "index.sqlite"),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function seed(file) {
  const db = openLocalIndexStore(file, { create: true });
  const writer = createLocalIndexWriter(db);
  try {
    writer.begin();
    const sessionId = writer.internSession(Buffer.alloc(32, 1), "11111111-1111-4111-8111-111111111111");
    const modelId = writer.internModel("gpt-5.1-codex-max", "recognized");
    const tierId = writer.internTier({
      apiServiceTier: "default", billingSurface: "chatgpt_subscription",
      codexSpeedMode: "standard", tierSource: "turn_override", providerTierRaw: "default",
    });
    const surfaceId = writer.internSurface({
      agentScope: "root", surface: "codex", threadSource: "cli",
      lineageDisposition: "standalone",
    });
    const accountScopeId = writer.internAccountScope({
      status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null,
    });
    const source = writer.registerSource({
      sourceLocal: Buffer.alloc(32, 2), ordinal: 0, sessionId, surfaceId,
      path: "synthetic.jsonl", rolloutKey: "synthetic", sizeBytes: 120, mtimeMs: 1,
    });
    writer.writeUsageEvent({
      sourceId: source.id, sourceOffset: 100, observedAtMs: 1_000,
      eventKey: Buffer.alloc(32, 3), sessionId, accountScopeId, modelId, tierId,
      surfaceId, reasoningEffort: 1, tokensInUncached: 50,
      tokensInCacheRead: 20, tokensOutCombined: 5,
    });
    writer.commitSourceState(source.id, {
      sessionId, surfaceId, path: "synthetic.jsonl", rolloutKey: "synthetic",
      sizeBytes: 120, mtimeMs: 1, scannedBytes: 120,
      diagnostics: { tokenCounts: 1 },
    });
    writer.commit();
  } finally {
    db.close();
  }
}

function downgradeWorkProjections(file) {
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
    db.exec(`CREATE TABLE work_rollup(
      day_ms INTEGER NOT NULL, session_id INTEGER NOT NULL,
      work_directory_id INTEGER NOT NULL, model_id INTEGER NOT NULL,
      account_scope_id INTEGER NOT NULL, shape INTEGER NOT NULL,
      ctx_class INTEGER NOT NULL, prov INTEGER NOT NULL, events INTEGER NOT NULL,
      in_uncached INTEGER NOT NULL, in_cache_read INTEGER NOT NULL,
      in_cache_write INTEGER NOT NULL, out_text INTEGER NOT NULL,
      out_reasoning INTEGER NOT NULL, out_combined INTEGER NOT NULL,
      last_at_ms INTEGER,
      PRIMARY KEY(day_ms, session_id, work_directory_id, model_id,
                  account_scope_id, shape, ctx_class, prov)) STRICT, WITHOUT ROWID`);
    db.prepare("DELETE FROM meta WHERE key IN ('work_rollup_schema_version','workload_bucket_schema_version')").run();
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

function downgradeToV10(file) {
  downgradeWorkProjections(file);
  const db = new DatabaseSync(file);
  try { db.exec("PRAGMA user_version=10"); } finally { db.close(); }
}

function downgradeToV9(file) {
  downgradeWorkProjections(file);
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const table of [...IMPACT_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.prepare("DELETE FROM meta WHERE key IN ('impact_schema_version','impact_manifest_since_change_id')").run();
    db.exec("PRAGMA user_version=9");
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

test("v11 creates impact and work projection tables without touching facts", () => {
  const f = workspace();
  try {
    seed(f.file);
    const db = openLocalIndexStore(f.file, { readOnly: true });
    try {
      assert.equal(LOCAL_INDEX_STORE_USER_VERSION, 11);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 11);
      assert.equal(db.prepare("SELECT value FROM meta WHERE key='impact_schema_version'").get().value, "1");
      const names = new Set(db.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).all().map(row => row.name));
      for (const table of [...IMPACT_TABLES, "work_rollup", "workload_bucket"]) {
        assert.ok(names.has(table), table);
      }
      const workColumns = db.prepare("PRAGMA table_info(work_rollup)").all().map(row => row.name);
      assert.ok(workColumns.includes("tier_id"));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 1);
      assert.deepEqual(
        db.prepare("SELECT projection_name, status FROM projection_watermark ORDER BY projection_name").all()
          .map(row => ({ projection_name: row.projection_name, status: row.status })),
        [
          { projection_name: "work_rollup", status: "ready" },
          { projection_name: "workload_bucket", status: "ready" },
        ],
      );
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});

test("writable v9 open performs the one-time v9 -> v10 -> v11 migration", () => {
  const f = workspace();
  try {
    seed(f.file);
    downgradeToV9(f.file);
    assert.throws(() => openLocalIndexStore(f.file, { readOnly: true }), {
      code: "local_index_family_mismatch",
    });
    const upgraded = openLocalIndexStore(f.file);
    try {
      assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 11);
      assert.equal(upgraded.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 1);
      assert.equal(upgraded.prepare("SELECT COUNT(*) AS n FROM source_change").get().n, 0);
      assert.ok(upgraded.prepare("PRAGMA table_info(work_rollup)").all()
        .some(row => row.name === "tier_id"));
      assert.equal(upgraded.prepare("SELECT COUNT(*) AS n FROM workload_bucket").get().n, 0);
      assert.equal(upgraded.prepare(
        "SELECT COUNT(*) AS n FROM projection_watermark WHERE status='pending'",
      ).get().n, 2);
    } finally {
      upgraded.close();
    }
    assert.doesNotThrow(() => openLocalIndexStore(f.file, { readOnly: true }).close());
  } finally {
    f.cleanup();
  }
});

test("v10 -> v11 replaces only the derived work projections and preserves source facts", () => {
  const f = workspace();
  try {
    seed(f.file);
    downgradeToV10(f.file);
    assert.throws(() => openLocalIndexStore(f.file, { readOnly: true }), {
      code: "local_index_family_mismatch",
    });
    const before = new DatabaseSync(f.file, { readOnly: true });
    let beforeFacts;
    try {
      beforeFacts = {
        sources: before.prepare("SELECT COUNT(*) AS n FROM source").get().n,
        usage: before.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n,
        sequence: before.prepare("SELECT commit_seq FROM store_state WHERE id=1").get().commit_seq,
      };
    } finally {
      before.close();
    }

    const upgrade = new DatabaseSync(f.file);
    try {
      upgradeLocalIndexV10ToV11(upgrade);
      assert.equal(upgrade.prepare("PRAGMA user_version").get().user_version, 11);
      assert.equal(upgrade.prepare("SELECT COUNT(*) AS n FROM source").get().n, beforeFacts.sources);
      assert.equal(upgrade.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, beforeFacts.usage);
      assert.equal(upgrade.prepare("SELECT commit_seq FROM store_state WHERE id=1").get().commit_seq,
        beforeFacts.sequence);
      assert.ok(upgrade.prepare("PRAGMA table_info(work_rollup)").all()
        .some(row => row.name === "tier_id"));
      assert.equal(upgrade.prepare("SELECT COUNT(*) AS n FROM workload_bucket").get().n, 0);
    } finally {
      upgrade.close();
    }

    const after = openLocalIndexStore(f.file, { readOnly: true });
    try {
      assert.equal(after.prepare("PRAGMA user_version").get().user_version, 11);
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM source").get().n, beforeFacts.sources);
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, beforeFacts.usage);
    } finally {
      after.close();
    }
  } finally {
    f.cleanup();
  }
});

test("v9 -> v10 adds only manifest objects and can be followed by v11", () => {
  const f = workspace();
  try {
    seed(f.file);
    downgradeToV9(f.file);
    const upgrade = new DatabaseSync(f.file);
    try {
      upgradeLocalIndexV9ToV10(upgrade);
      assert.equal(upgrade.prepare("PRAGMA user_version").get().user_version, 10);
      assert.equal(upgrade.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 1);
      assert.equal(upgrade.prepare("SELECT value FROM meta WHERE key='impact_manifest_since_change_id'").get().value, "0");
      upgradeLocalIndexV10ToV11(upgrade);
      assert.equal(upgrade.prepare("PRAGMA user_version").get().user_version, 11);
    } finally {
      upgrade.close();
    }
  } finally {
    f.cleanup();
  }
});

test("manifest retention removes old changes and advances the proven-since floor", () => {
  const f = workspace();
  try {
    seed(f.file);
    const db = openLocalIndexStore(f.file);
    const writer = createLocalIndexWriter(db);
    try {
      const sourceId = Number(db.prepare("SELECT id FROM source LIMIT 1").get().id);
      for (let index = 0; index < 5; index += 1) {
        writer.begin();
        writer.recordSourceChange({
          sourceId, mode: "append", reason: "retention_test",
          oldEventCount: index, newEventCount: index + 1, confidence: "exact",
          factCounts: [{
            factKind: "usage", oldCount: index, newCount: index + 1,
            oldMinAtMs: index, oldMaxAtMs: index,
            newMinAtMs: index, newMaxAtMs: index + 1,
          }],
          partitions: [{
            partitionKind: "usage_time_range",
            partitionKey: `usage_time_range:${sourceId}`,
            lowerMs: index, upperMs: index + 1,
            basisKind: "fact_delta", status: "dirty",
          }],
        });
        writer.commit({ kind: "refresh", sourcesChanged: 1 });
      }
      writer.begin();
      const result = pruneImpactManifest(db, { keepChanges: 2 });
      writer.commit({ bumpSeq: false });
      assert.equal(result.deletedChanges, 3);
      assert.equal(result.sinceChangeId, 3);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_change").get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM change_fact_count").get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM impact_partition").get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM publication").get().n, 2);
      assert.equal(db.prepare(
        "SELECT value FROM meta WHERE key='impact_manifest_since_change_id'",
      ).get().value, "3");
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});

test("impact schema creation is additive and idempotent", () => {
  const f = workspace();
  try {
    const db = openLocalIndexStore(f.file, { create: true });
    try {
      const version = db.prepare("PRAGMA user_version").get().user_version;
      createLocalIndexImpactSchema(db);
      createLocalIndexImpactSchema(db);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, version);
      const names = new Set(db.prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      ).all().map(row => row.name));
      for (const table of IMPACT_TABLES) assert.ok(names.has(table), table);
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM source_change").get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    f.cleanup();
  }
});
