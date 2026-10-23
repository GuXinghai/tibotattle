import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWindowsFilesystemAdapter } from '../src/platform/index.js';
import { createLocalIndexWriter, loadCatalog, LOCAL_INDEX_PARSER_VERSION, LOCAL_INDEX_STORE_USER_VERSION, openLocalIndexStore, openLocalIndexEvidenceStore, readLocalIndexIdentityBeforeMigration } from '../src/local-index-store.js';

const LEGACY_PARSER = 'local-index-rollout-typed-v2+unified-rollout-typed-v21';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'local-index-store-v7-'));
  const state = join(root, 'state'); createWindowsFilesystemAdapter().ensureDirectory(state);
  return { root, state, file: join(state, 'index.sqlite'), cleanup() {
    assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), 'local-index-store-v7-')));
    assert.equal(lstatSync(root).isSymbolicLink(), false); rmSync(root, { recursive: true, force: true });
  } };
}
function seed(file) {
  const db = openLocalIndexStore(file, { create: true }); const writer = createLocalIndexWriter(db);
  writer.begin();
  const sessionId = writer.internSession(Buffer.alloc(32, 1));
  const modelId = writer.internModel('gpt-5.1-codex-max', 'known');
  const tierId = writer.internTier({ apiServiceTier: 'default', billingSurface: 'api', codexSpeedMode: 'standard', tierSource: 'explicit', providerTierRaw: null });
  const surfaceId = writer.internSurface({ agentScope: 'root', surface: 'codex', threadSource: 'cli', lineageDisposition: 'root' });
  const accountScopeId = writer.internAccountScope({ status: 'unattributed', reason: 'synthetic', planType: null, scopeLocal: null });
  const source = writer.registerSource({ sourceLocal: Buffer.alloc(32, 2), ordinal: 37, sessionId, surfaceId, path: 'synthetic.jsonl', rolloutKey: 'synthetic', sizeBytes: 120, mtimeMs: 1 });
  writer.writeUsageEvent({ sourceId: source.id, sourceOffset: 100, observedAtMs: 1000, eventKey: Buffer.alloc(32, 3), sessionId, accountScopeId, modelId, tierId, surfaceId, reasoningEffort: 1, tokensInUncached: 50, tokensInCacheRead: 20, tokensOutCombined: 5 });
  writer.commitSourceState(source.id, { sessionId, surfaceId, path: 'synthetic.jsonl', rolloutKey: 'synthetic', sizeBytes: 120, mtimeMs: 1, scannedBytes: 120, diagnostics: { tokenCounts: 1 } });
  writer.commit();
  // Construct actual predecessor schema on a synthetic fixture only; no real
  // index is relabelled or downgraded.
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'calculation_%'").all()) db.exec(`DROP TRIGGER ${row.name}`);
  db.exec('ALTER TABLE store_state DROP COLUMN calculation_revision; PRAGMA user_version=6');
  db.prepare("UPDATE meta SET value=? WHERE key='parser_version'").run(LEGACY_PARSER);
  db.prepare('UPDATE source SET parser_version=?').run(LEGACY_PARSER);
  db.close();
}
function durableRows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { events: db.prepare('SELECT * FROM usage_event').all(), sources: db.prepare('SELECT * FROM source').all(), diagnostics: db.prepare('SELECT * FROM source_diagnostic').all(), sequence: db.prepare('SELECT * FROM store_state').all(), schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() }; }
  finally { db.close(); }
}

test('v6 copy migrates forward without changing facts, ordinals or cursors', () => {
  const f = fixture();
  try {
    seed(f.file); const before = durableRows(f.file); const copy = join(f.state, 'copy.sqlite');
    copyFileSync(f.file, copy);
    assert.deepEqual(readLocalIndexIdentityBeforeMigration(copy), { hasFacts: true });
    assert.throws(() => openLocalIndexStore(copy, { readOnly: true }), { code: 'local_index_family_mismatch' });
    const db = openLocalIndexStore(copy);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='parser_version'").get().value, LOCAL_INDEX_PARSER_VERSION);
    assert.equal(loadCatalog(db).values().next().value.deferred_tail_bytes, 0);
    db.close(); const after = durableRows(copy);
    for (const key of ['events', 'sources', 'diagnostics']) assert.deepEqual(after[key], before[key]);
    assert.equal(after.sequence[0].commit_seq, before.sequence[0].commit_seq);
    assert.equal(after.sequence[0].calculation_revision, 0);
    const original = new DatabaseSync(f.file, { readOnly: true });
    assert.equal(original.prepare('PRAGMA user_version').get().user_version, 6); original.close();
    assert.equal(LOCAL_INDEX_STORE_USER_VERSION, 8); assert.equal(LOCAL_INDEX_PARSER_VERSION, 'local-index-rollout-typed-v3+unified-rollout-typed-v22');
  } finally { f.cleanup(); }
});

test('existing v4 and v5 forward paths continue through v6 to v8', () => {
  const f = fixture();
  try {
    for (const version of [4, 5]) {
      const file = join(f.state, `legacy-${version}.sqlite`); seed(file); const before = durableRows(file);
      const legacy = new DatabaseSync(file); legacy.exec(`PRAGMA user_version=${version}`); legacy.close();
      const migrated = openLocalIndexStore(file); assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 8); migrated.close();
      const after = durableRows(file);
      for (const key of ['events', 'sources', 'diagnostics']) assert.deepEqual(after[key], before[key]);
      assert.equal(after.sequence[0].commit_seq, before.sequence[0].commit_seq);
    }
  } finally { f.cleanup(); }
});

test('future store rejects reads and writes before journal-mode changes', () => {
  const f = fixture();
  try {
    seed(f.file); const future = new DatabaseSync(f.file); future.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=9'); future.close();
    const digest = () => createHash('sha256').update(readFileSync(f.file)).digest('hex'); const before = digest();
    for (const options of [{ readOnly: true }, {}, { create: true }]) assert.throws(() => openLocalIndexStore(f.file, options), { code: 'local_index_newer_version' });
    assert.throws(() => readLocalIndexIdentityBeforeMigration(f.file), { code: 'local_index_newer_version' });
    assert.equal(digest(), before); assert.equal(existsSync(`${f.file}-wal`), false); assert.equal(existsSync(`${f.file}-shm`), false);
  } finally { f.cleanup(); }
});

test('deferred tail diagnostic survives reopen and rejects negative or unknown diagnostic values', () => {
  const f = fixture();
  try {
    seed(f.file); let db = openLocalIndexStore(f.file); const writer = createLocalIndexWriter(db);
    const row = loadCatalog(db).values().next().value; writer.begin();
    writer.commitSourceState(row.id, { path: row.path, rolloutKey: row.rollout_key, sizeBytes: 160, mtimeMs: 2, scannedBytes: 120, diagnostics: { deferredTailBytes: 40, tokenCounts: 1, arbitraryPrivateField: 1 } }); writer.commit(); db.close();
    db = openLocalIndexStore(f.file, { readOnly: true });
    const current = loadCatalog(db).values().next().value; assert.equal(current.deferred_tail_bytes, 40); assert.equal(current.size_bytes - current.scanned_bytes, 40);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_event').get().n, 1); assert.equal(current.source_ordinal, 37);
    assert.deepEqual(db.prepare('SELECT code,count FROM source_diagnostic ORDER BY code').all().map(row => ({ ...row })), [{ code: 'deferredTailBytes', count: 40 }, { code: 'tokenCounts', count: 1 }]); db.close();
    db = openLocalIndexStore(f.file); const next = createLocalIndexWriter(db); next.begin();
    next.commitSourceState(current.id, { path: current.path, rolloutKey: current.rollout_key, sizeBytes: 160, mtimeMs: 2, scannedBytes: 120, diagnostics: { deferredTailBytes: -1 } }); next.commit();
    assert.equal(loadCatalog(db).values().next().value.deferred_tail_bytes, 0); db.close();
  } finally { f.cleanup(); }
});


test('v7 migration is atomic on trigger-install failure and retries without rewriting retained evidence', () => {
  const f = fixture();
  try {
    seed(f.file);
    const legacy = new DatabaseSync(f.file);
    legacy.exec(`PRAGMA user_version=7;
      CREATE TRIGGER calculation_source_insert AFTER INSERT ON source BEGIN SELECT 1; END;`);
    legacy.close();
    const before = durableRows(f.file);
    assert.throws(() => openLocalIndexStore(f.file), { code: 'local_index_unavailable' });
    assert.deepEqual(durableRows(f.file), before, 'failed migration leaves schema and retained facts intact');
    const repair = new DatabaseSync(f.file);
    assert.equal(repair.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(repair.prepare('PRAGMA table_info(store_state)').all().some(row => row.name === 'calculation_revision'), false);
    repair.exec('DROP TRIGGER calculation_source_insert'); repair.close();
    const db = openLocalIndexStore(f.file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(db.prepare('SELECT calculation_revision n FROM store_state').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_event').get().n, 1);
    db.close();
  } finally { f.cleanup(); }
});

test('semantic revision covers full evidence distinctions and rolls back with interrupted writes', () => {
  const f = fixture();
  try {
    seed(f.file); const db = openLocalIndexStore(f.file);
    try {
      const revision = () => db.prepare('SELECT calculation_revision n FROM store_state').get().n;
      const baseline = revision();
      const sequence = db.prepare('SELECT commit_seq n FROM store_state').get().n;
      for (const sql of [
        'UPDATE usage_event SET tokens_in_cache_write=0',
        'UPDATE usage_event SET flags=flags|4',
        "UPDATE model SET recognition='unknown'",
        "UPDATE tier_semantics SET codex_speed_mode='fast'",
        "UPDATE account_scope SET reason='changed-synthetic-ownership'",
        'UPDATE source SET source_ordinal=source_ordinal+1',
        `UPDATE source SET lineage_json='{"lineage":{"historyMode":"paginated"}}'`,
        "UPDATE source_diagnostic SET count=count+1 WHERE code='tokenCounts'", // benign counter below
      ]) {
        db.exec('BEGIN IMMEDIATE'); db.exec(sql);
        if (sql.includes("code='tokenCounts'")) assert.equal(revision(), baseline);
        else assert.ok(revision() > baseline, sql);
        db.exec('ROLLBACK'); assert.equal(revision(), baseline);
      }
      db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO source_diagnostic(source_id,code,count) VALUES(1,'toolRecordsSkipped',1)").run();
      assert.ok(revision() > baseline); db.exec('ROLLBACK');
      assert.equal(revision(), baseline);
      const writer = createLocalIndexWriter(db);
      writer.begin(); assert.equal(writer.beginSourceCandidate(1), true);
      db.exec('INSERT INTO candidate_usage_event SELECT * FROM usage_event');
      writer.rollback();
      assert.equal(revision(), baseline);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_event').get().n, 1);
      writer.begin(); assert.equal(writer.beginSourceCandidate(1), true);
      db.exec('INSERT INTO candidate_usage_event SELECT * FROM usage_event');
      assert.equal(writer.finishSourceCandidate(), true); writer.commit();
      assert.equal(revision(), baseline);
      assert.equal(db.prepare('SELECT commit_seq n FROM store_state').get().n, sequence + 1);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('existing v8 capture triggers are corrected only on writable opens without changing evidence', () => {
  for (const open of [openLocalIndexStore, openLocalIndexEvidenceStore]) {
    const f = fixture();
    try {
      seed(f.file); openLocalIndexStore(f.file).close();
      const legacy = new DatabaseSync(f.file);
      try {
        for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
          legacy.exec(`CREATE TRIGGER IF NOT EXISTS calculation_runtime_model_evidence_${operation.toLowerCase()}
            AFTER ${operation} ON runtime_model_evidence BEGIN
            UPDATE store_state SET calculation_revision=calculation_revision+1 WHERE id=1; END`);
        }
      } finally { legacy.close(); }
      const before = durableRows(f.file);
      const readonly = openLocalIndexStore(f.file, { readOnly: true });
      readonly.close();
      assert.deepEqual(durableRows(f.file), before, 'read-only diagnostics must never correct persisted triggers');
      const originalExec = DatabaseSync.prototype.exec;
      try {
        DatabaseSync.prototype.exec = function (sql) {
          if (sql === 'DROP TRIGGER IF EXISTS calculation_runtime_model_evidence_update') throw new Error('synthetic drop failure');
          return originalExec.call(this, sql);
        };
        assert.throws(() => open(f.file), { code: 'local_index_unavailable' });
      } finally { DatabaseSync.prototype.exec = originalExec; }
      assert.deepEqual(durableRows(f.file), before, 'a partial correction rolls back all trigger changes');
      const writer = open(f.file);
      try {
        assert.equal(writer.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'calculation_runtime_model_evidence_%'").get().n, 0);
        assert.equal(writer.prepare('PRAGMA user_version').get().user_version, 8);
      } finally { writer.close(); }
      const after = durableRows(f.file);
      for (const key of ['events', 'sources', 'diagnostics', 'sequence']) assert.deepEqual(after[key], before[key]);
      assert.deepEqual(after.schema, before.schema.filter(row => !row.name.startsWith('calculation_runtime_model_evidence_')));
      open(f.file).close();
      assert.deepEqual(durableRows(f.file), after, 'the forward correction is idempotent');
    } finally { f.cleanup(); }
  }
});
