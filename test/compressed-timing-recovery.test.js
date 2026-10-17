import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { openTimingStore, ingestTimingFile, readTimingRows, createCompressedTimingReader,
  createSourceFileAccess, createWindowsFilesystemAdapter } from '../src/platform/index.js';
import { createParser, createToolFreeParser, digest, METHOD, TOOL_FREE_METHOD,
  MAX_STATE_BYTES, INFERENCE_TIMING_PARSER_VERSION } from '../src/providers/codex/logs.js';
import { discoverModelPerformanceSources, modelPerformanceHistoryState,
  modelPerformanceSourceFailure } from '../apps/local/model-performance-worker.js';

const base = Date.parse('2026-10-01T00:00:00Z');
const record = (ms, type, payload) => ({ timestamp: new Date(base + ms).toISOString(), type, payload });
function corpus(count = 9) {
  const rows = [record(0, 'session_meta', { id: 'synthetic-compressed-session' })];
  for (let i = 0; i < count; i++) {
    const turn = `synthetic-${i}`, at = i * 5000;
    rows.push(record(at, 'event_msg', { type: 'task_started', turn_id: turn }),
      record(at, 'turn_context', { turn_id: turn, model: 'gpt-6.1-sol', service_tier: 'default' }),
      record(at + 1000, 'event_msg', { type: 'item_completed', thread_id: 'synthetic-compressed-session',
        turn_id: turn, item: { type: 'AgentMessage' }, started_at_ms: base + at, completed_at_ms: base + at + 1000 }),
      record(at + 1000, 'token_usage_record', { thread_id: 'synthetic-compressed-session', turn_id: turn,
        response_id: `synthetic-response-${i}`, usage: { output_tokens: 100, reasoning_output_tokens: 20 },
        turn_token_usage: { output_tokens: 100, reasoning_output_tokens: 20 } }),
      record(at + 1000, 'event_msg', { type: 'task_complete', turn_id: turn, duration_ms: 1000, time_to_first_token_ms: 200 }),
      record(at + 1001, 'synthetic_padding', { data: 'x'.repeat(90000) }));
  }
  return Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
async function fixture(t) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'compressed-timing-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'owned'), owned = createWindowsFilesystemAdapter(); owned.ensureDirectory(root);
  const home = join(root, 'codex'); await mkdir(join(home, 'sessions'), { recursive: true });
  const path = join(home, 'sessions', 'synthetic.jsonl'), compressed = path + '.zst';
  owned.ensureDirectory(join(root, 'primary')); owned.ensureDirectory(join(root, 'extra'));
  const access = createSourceFileAccess(), reader = createCompressedTimingReader({ filesystem: { openSource: path => access.open(path) } });
  const config = { createParser, digest, METHOD, MAX_STATE_BYTES, parserVersion: INFERENCE_TIMING_PARSER_VERSION, compressedReader: reader };
  return { root, home, path, compressed, reader, config };
}
async function drain(stores, path, maxBytes = 128 * 1024) {
  let calls = 0;
  for (; calls < 1000; calls++) {
    let pending = false;
    for (const store of stores) {
      const result = await ingestTimingFile(store, path, { maxBytes });
      if (result.remaining && !result.unchanged && !(result.partial && result.bytes < maxBytes)) pending = true;
    }
    if (!pending) return calls + 1;
  }
  throw new Error('synthetic_recovery_stalled');
}

test('discovery accepts compressed history, prefers plaintext duplicates and retains logical identity', async t => {
  const f = await fixture(t); await writeFile(f.path, corpus()); await writeFile(f.compressed, zstdCompressSync(corpus()));
  const found = await discoverModelPerformanceSources(f.home);
  assert.equal(found.length, 1); assert.equal(found[0].path, f.path); assert.equal(found[0].logicalPath, f.path);
  await rm(f.path); const compressed = await discoverModelPerformanceSources(f.home);
  assert.equal(compressed.length, 1); assert.equal(compressed[0].path, f.compressed); assert.equal(compressed[0].logicalPath, f.path);
  await f.reader.close();
});

test('representation change stages atomically, shares one decode and then skips without decompression', async t => {
  const f = await fixture(t), bytes = corpus(); await writeFile(f.path, bytes);
  const primary = await openTimingStore(join(f.root, 'primary'), f.config);
  const extra = await openTimingStore(join(f.root, 'extra'), { ...f.config, createParser: createToolFreeParser,
    METHOD: TOOL_FREE_METHOD, correlationKey: primary.key });
  try {
    await drain([primary, extra], f.path);
    const before = readTimingRows(primary, { supplement: extra }), source = primary.db.prepare('SELECT id,digest FROM source').get();
    assert.equal(before.length, 9);
    await writeFile(f.compressed, zstdCompressSync(bytes)); await rm(f.path);
    const first = await ingestTimingFile(primary, f.compressed, { maxBytes: 128 * 1024 });
    assert.equal(first.remaining, 1); assert.deepEqual(readTimingRows(primary, { supplement: extra }), before);
    await drain([extra, primary], f.compressed);
    assert.deepEqual(readTimingRows(primary, { supplement: extra }), before);
    assert.deepEqual(primary.db.prepare('SELECT id,digest FROM source').get(), source);
    assert.equal(primary.db.prepare('SELECT COUNT(*) n FROM source').get().n, 1);
    assert.equal(primary.db.prepare('SELECT COUNT(*) n FROM parser_replay_turn').get().n, 0);
    assert.equal(f.reader.stats().starts, 1);
    assert.equal(f.reader.stats().decodedBytes, bytes.length);
    const counters = f.reader.stats();
    assert.equal((await ingestTimingFile(primary, f.compressed)).unchanged, true);
    assert.equal((await ingestTimingFile(extra, f.compressed)).unchanged, true);
    assert.deepEqual(f.reader.stats(), counters);
    assert.equal(primary.db.prepare('PRAGMA user_version').get().user_version, 10);
    assert.equal(extra.db.prepare('PRAGMA user_version').get().user_version, 11);
    const discovered = new Set([digest(primary.key, 'source-path', f.path)]);
    assert.deepEqual(modelPerformanceHistoryState(readTimingRows(primary, { supplement: extra, withRevision: true }).sources,
      INFERENCE_TIMING_PARSER_VERSION, discovered), { pending: 0, unavailable: 0, recoveryFailed: 0 });
  } finally { await f.reader.close(); await extra.close(); await primary.close(); }
});

test('restart resumes committed staging and cancellation never advances the saved cursor', async t => {
  const f = await fixture(t), bytes = corpus(15); await writeFile(f.compressed, zstdCompressSync(bytes));
  const directory = join(f.root, 'primary'); let store = await openTimingStore(directory, f.config);
  await ingestTimingFile(store, f.compressed, { maxBytes: 128 * 1024 });
  const saved = store.db.prepare('SELECT * FROM source').get(); assert.ok(saved.cursor > 0); assert.equal(readTimingRows(store).length, 0);
  await store.close(); await f.reader.close();
  store = await openTimingStore(directory, { ...f.config, compressedReader: null });
  try {
    const controller = new AbortController();
    await assert.rejects(async () => {
      for (let step = 0; step < 10; step++) await ingestTimingFile(store, f.compressed, {
        maxBytes: 128 * 1024, signal: controller.signal, onReadLine: () => controller.abort(),
      });
    }, /cancelled|abort/iu);
    assert.deepEqual(store.db.prepare('SELECT * FROM source').get(), saved);
    await drain([store], f.compressed);
    assert.equal(readTimingRows(store).length, 15);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM source').get().n, 1);
    assert.equal((await ingestTimingFile(store, f.compressed)).unchanged, true);
  } finally { await store.close(); }
});

test('corrupt compressed input preserves live rows, reports decode failure and can recover after repair', async t => {
  const f = await fixture(t), bytes = corpus(2); await writeFile(f.path, bytes);
  const store = await openTimingStore(join(f.root, 'primary'), f.config);
  try {
    await drain([store], f.path); const before = readTimingRows(store);
    const encoded = zstdCompressSync(bytes); await writeFile(f.compressed, encoded.subarray(0, encoded.length - 3));
    await assert.rejects(drain([store], f.compressed), error => modelPerformanceSourceFailure(error) === 'timing_source_decode_failed');
    assert.deepEqual(readTimingRows(store), before);
    await writeFile(f.compressed, encoded); await drain([store], f.compressed);
    assert.deepEqual(readTimingRows(store), before);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM source').get().n, 1);
  } finally { await f.reader.close(); await store.close(); }
});

test('source diagnostics are classified without exposing raw errors', () => {
  for (const [code, expected] of [['EACCES', 'timing_source_read_failed'], ['ENOENT', 'timing_source_read_failed'],
    ['codex_rollout_content_invalid', 'timing_source_decode_failed'], ['codex_rollout_source_changed', 'timing_source_recovery_failed'],
    ['export_resource_source_bytes', 'timing_source_limit'], ['codex_rollout_compression_unsupported', 'timing_source_unsupported']]) {
    assert.equal(modelPerformanceSourceFailure({ code, message: 'synthetic private detail' }), expected);
  }
});

test('duplicate physical copies do not add turns and changed named identity cannot publish a half replacement', async t => {
  const f = await fixture(t), bytes = corpus(4); await writeFile(f.compressed, zstdCompressSync(bytes));
  const store = await openTimingStore(join(f.root, 'primary'), f.config);
  try {
    await drain([store], f.compressed); const before = readTimingRows(store);
    const copy = join(f.home, 'sessions', 'synthetic-copy.jsonl.zst'); await writeFile(copy, zstdCompressSync(bytes));
    await drain([store], copy); assert.deepEqual(readTimingRows(store), before);
    await writeFile(f.compressed, zstdCompressSync(corpus(6)));
    const snapshot = store.db.prepare('SELECT cursor,state FROM source ORDER BY id LIMIT 1').get();
    let modified = false;
    await assert.rejects(ingestTimingFile(store, f.compressed, { maxBytes: 128 * 1024 }).then(async () => {
      const current = store.db.prepare('SELECT cursor FROM source ORDER BY id LIMIT 1').get();
      assert.ok(current.cursor > 0); modified = true;
      const originalStat = store.filesystem.namedStat;
      store.filesystem.namedStat = async (path, handle) => ({ ...await originalStat(path, handle), ino: 'synthetic-changed-identity' });
      try { await ingestTimingFile(store, f.compressed, { maxBytes: 128 * 1024 }); }
      finally { store.filesystem.namedStat = originalStat; }
    }), error => modelPerformanceSourceFailure(error) === 'timing_source_recovery_failed');
    assert.equal(modified, true); assert.deepEqual(readTimingRows(store), before);
    await drain([store], f.compressed); assert.equal(readTimingRows(store).length, 6);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM source').get().n, 2);
    assert.ok(snapshot.cursor > 0);
  } finally { await f.reader.close(); await store.close(); }
});

test('oversized declared compressed frames fail with a resource diagnostic before publishing', async t => {
  const f = await fixture(t), header = Buffer.alloc(13);
  header.writeUInt32LE(0xfd2fb528); header[4] = 0xe0; header.writeBigUInt64LE(16n * 1024n ** 3n + 1n, 5);
  await writeFile(f.compressed, header); const store = await openTimingStore(join(f.root, 'primary'), f.config);
  try {
    await assert.rejects(ingestTimingFile(store, f.compressed), error => modelPerformanceSourceFailure(error) === 'timing_source_limit');
    assert.equal(readTimingRows(store).length, 0); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM source').get().n, 0);
  } finally { await f.reader.close(); await store.close(); }
});
