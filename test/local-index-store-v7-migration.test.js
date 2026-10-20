import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWindowsFilesystemAdapter } from '../src/platform/index.js';
import { createLocalIndexWriter, loadCatalog, LOCAL_INDEX_PARSER_VERSION, LOCAL_INDEX_STORE_USER_VERSION, openLocalIndexStore, readLocalIndexIdentityBeforeMigration } from '../src/local-index-store.js';

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
  // The v6 physical tables are identical. This content-free fixture constructs
  // its legacy semantic marker; no real index is relabelled or downgraded.
  db.exec('PRAGMA user_version=6');
  db.prepare("UPDATE meta SET value=? WHERE key='parser_version'").run(LEGACY_PARSER);
  db.prepare('UPDATE source SET parser_version=?').run(LEGACY_PARSER);
  db.close();
}
function durableRows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { events: db.prepare('SELECT * FROM usage_event').all(), sources: db.prepare('SELECT * FROM source').all(), diagnostics: db.prepare('SELECT * FROM source_diagnostic').all(), sequence: db.prepare('SELECT * FROM store_state').all(), schema: db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() }; }
  finally { db.close(); }
}

test('v6 copy migrates to v7 without changing facts, ordinals, cursors or physical schema', () => {
  const f = fixture();
  try {
    seed(f.file); const before = durableRows(f.file); const copy = join(f.state, 'copy.sqlite');
    copyFileSync(f.file, copy);
    assert.deepEqual(readLocalIndexIdentityBeforeMigration(copy), { hasFacts: true });
    assert.throws(() => openLocalIndexStore(copy, { readOnly: true }), { code: 'local_index_family_mismatch' });
    const db = openLocalIndexStore(copy);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='parser_version'").get().value, LOCAL_INDEX_PARSER_VERSION);
    assert.equal(loadCatalog(db).values().next().value.deferred_tail_bytes, 0);
    db.close(); assert.deepEqual(durableRows(copy), before);
    const original = new DatabaseSync(f.file, { readOnly: true });
    assert.equal(original.prepare('PRAGMA user_version').get().user_version, 6); original.close();
    assert.equal(LOCAL_INDEX_STORE_USER_VERSION, 7); assert.equal(LOCAL_INDEX_PARSER_VERSION, 'local-index-rollout-typed-v3+unified-rollout-typed-v21');
  } finally { f.cleanup(); }
});

test('existing v4 and v5 forward paths continue through v6 to v7', () => {
  const f = fixture();
  try {
    for (const version of [4, 5]) {
      const file = join(f.state, `legacy-${version}.sqlite`); seed(file); const before = durableRows(file);
      const legacy = new DatabaseSync(file); legacy.exec(`PRAGMA user_version=${version}`); legacy.close();
      const migrated = openLocalIndexStore(file); assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 7); migrated.close();
      assert.deepEqual(durableRows(file), before);
    }
  } finally { f.cleanup(); }
});

test('future store rejects reads and writes before journal-mode changes', () => {
  const f = fixture();
  try {
    seed(f.file); const future = new DatabaseSync(f.file); future.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=8'); future.close();
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
