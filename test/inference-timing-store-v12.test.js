import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, realpath, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync, writeFileSync, openSync, readSync, fstatSync, closeSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParser, createToolFreeParser, digest, METHOD, TOOL_FREE_METHOD, MAX_STATE_BYTES, INFERENCE_TIMING_PARSER_VERSION } from '../src/providers/codex/logs.js';
import { ingestTimingFile, openTimingStore, readTimingRows } from '../src/platform/inference-timing-store.js';
import { createTimingFilesystem } from '../src/platform/inference-timing-filesystem.js';

const BASE = Date.parse('2026-09-01T12:00:00Z');
const rec = (ms, type, payload) => ({ timestamp: new Date(BASE + ms).toISOString(), type, payload });
const fixture = () => [
  rec(0, 'session_meta', { id: 'synthetic-session' }),
  rec(0, 'event_msg', { type: 'task_started', turn_id: 'synthetic-turn' }),
  rec(0, 'turn_context', { turn_id: 'synthetic-turn', model: 'gpt-5.6-sol', effort: 'high' }),
  rec(1000, 'event_msg', { type: 'item_completed', thread_id: 'synthetic-session', turn_id: 'synthetic-turn',
    item: { type: 'Reasoning' }, started_at_ms: BASE, completed_at_ms: BASE + 1000 }),
  rec(1000, 'token_usage_record', { thread_id: 'synthetic-session', turn_id: 'synthetic-turn', response_id: 'synthetic-response',
    usage: { output_tokens: 100, reasoning_output_tokens: 50 },
    turn_token_usage: { output_tokens: 100, reasoning_output_tokens: 50 } }),
  rec(1000, 'event_msg', { type: 'task_complete', turn_id: 'synthetic-turn', duration_ms: 1000, time_to_first_token_ms: 200 }),
];
const namedFixture = (name, model = 'gpt-5.6-sol') => {
  const rows = JSON.parse(JSON.stringify(fixture())
    .replaceAll('synthetic-session', `synthetic-session-${name}`)
    .replaceAll('synthetic-turn', `synthetic-turn-${name}`)
    .replaceAll('synthetic-response', `synthetic-response-${name}`));
  Object.assign(rows.find(row => row.type === 'turn_context').payload, { model });
  return rows;
};
const lines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const syntheticNative = (() => {
  const guards = new Set(), sources = new Map();
  const identity = { volumeSerialNumber: '0000000000000001', fileId: '00000000000000000000000000000002', linkCount: 1 };
  return {
    credentialAuditFileGuardContractVersion: 'windows-credential-audit-file-guard-v1',
    credentialAuditFileGuardSafe: true,
    ensureDirectory: path => mkdirSync(path, { recursive: true, mode: 0o700 }),
    createFile: (path, data) => writeFileSync(path, data, { flag: 'wx', mode: 0o600 }),
    inspectPath: path => lstatSync(path),
    acquireCredentialAuditFileGuard(path) { const guard = { path }; guards.add(guard); return { guard, identity }; },
    releaseCredentialAuditFileGuard(guard) { assert.ok(guards.delete(guard), 'only live guards are released'); },
    closeSourceFile(lease) { closeSync(sources.get(lease)); sources.delete(lease); },
    openSourceFile(path) { const lease = {}; sources.set(lease, openSync(path, 'r')); return lease; },
    statSourceFile(lease) { return fstatSync(sources.get(lease)); },
    readSourceFile(lease, position, length) {
      assert.ok(length <= 65_536);
      const data = Buffer.alloc(length);
      return data.subarray(0, readSync(sources.get(lease), data, 0, length, position));
    },
  };
})();
const syntheticFilesystem = createTimingFilesystem({ platform: 'win32', loadWindowsBinding: () => syntheticNative });
const options = { createParser, digest, METHOD, MAX_STATE_BYTES, filesystem: syntheticFilesystem };

test('rejects unconverted and foreign timing stores without writing their original bytes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-v12-schema-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'timing'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'timing-experiment.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE metadata (key BLOB NOT NULL CHECK(length(key)=32));
    CREATE TABLE source (id INTEGER PRIMARY KEY, digest BLOB UNIQUE NOT NULL,
      fingerprint TEXT NOT NULL, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
      state TEXT NOT NULL CHECK(length(state)<=${MAX_STATE_BYTES}));
    CREATE TABLE turn (key BLOB PRIMARY KEY, source INTEGER NOT NULL, offset INTEGER NOT NULL,
      at INTEGER NOT NULL, model TEXT, effort TEXT, tokens INTEGER, reasoning INTEGER,
      duration INTEGER, ttft INTEGER, responses INTEGER NOT NULL, covered INTEGER NOT NULL,
      quality TEXT NOT NULL, sample_tokens INTEGER, sample_reasoning INTEGER,
      sample_duration INTEGER, sample_responses INTEGER NOT NULL,
      sample_total_responses INTEGER NOT NULL, sample_method TEXT) WITHOUT ROWID;
    CREATE INDEX turn_time ON turn(at);
    INSERT INTO metadata VALUES (X'0707070707070707070707070707070707070707070707070707070707070707');
    INSERT INTO turn VALUES (X'0909090909090909090909090909090909090909090909090909090909090909', 1, 4,
      ${BASE}, 'gpt-5.6-sol', 'high', 100, 50, 1000, 200, 1, 1, 'complete',
      100, 50, 1000, 1, 1, 'receipt');
    PRAGMA application_id=0x54425450;
    PRAGMA user_version=${METHOD};
  `);
  db.close();
  await chmod(file, 0o600);
  for (const version of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    const setup = new DatabaseSync(file);
    setup.exec(`PRAGMA user_version=${version}`);
    setup.close();
    const before = await readFile(file);
    const calls = [];
    await assert.rejects(openTimingStore(directory, {
      ...options,
      databaseFactory(path, connectionOptions) {
        assert.equal(connectionOptions.readOnly, true);
        const connection = new DatabaseSync(path, connectionOptions);
        return {
          prepare: connection.prepare.bind(connection),
          exec(sql) { calls.push(sql); return connection.exec(sql); },
          close: connection.close.bind(connection),
          get isOpen() { return connection.isOpen; },
        };
      },
    }), version === 12 ? /incompatible_timing_identity/u : /incompatible_database/u);
    assert.deepEqual(calls, [], 'refusal runs no DDL or write pragmas');
    assert.deepEqual(await readFile(file), before, 'unconverted evidence is preserved byte for byte');
  }
});

test('foreign identity markers and duplicate correlation metadata are refused before writable reopening', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-identity-refusal-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const malformed of ['foreign-namespace', 'duplicate-metadata']) {
    const directory = join(root, malformed);
    const store = await openTimingStore(directory, options);
    const file = store.file;
    store.close();
    const setup = new DatabaseSync(file);
    setup.exec('ALTER TABLE metadata RENAME TO original_metadata; CREATE TABLE metadata (key BLOB, identity_version TEXT)');
    setup.exec('INSERT INTO metadata SELECT key,identity_version FROM original_metadata');
    if (malformed === 'foreign-namespace') setup.exec("UPDATE metadata SET identity_version='synthetic-foreign-v1'");
    else setup.exec('INSERT INTO metadata SELECT key,identity_version FROM original_metadata');
    setup.exec('DROP TABLE original_metadata');
    setup.close();
    const before = await readFile(file);
    let connections = 0;
    await assert.rejects(openTimingStore(directory, {
      ...options,
      databaseFactory(path, connectionOptions) {
        connections += 1;
        assert.equal(connectionOptions.readOnly, true);
        return new DatabaseSync(path, connectionOptions);
      },
    }), /incompatible_timing_identity/u);
    assert.equal(connections, 1, 'no writable connection is opened for an unknown identity');
    assert.deepEqual(await readFile(file), before);
  }
});

test('parser upgrades replay unchanged verified sources once without changing stable turn identities', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-parser-replay-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl');
  const rows = fixture();
  Object.assign(rows.find(row => row.type === 'turn_context').payload, { model: 'gpt-6.1-sol', service_tier: 'ultrafast' });
  await writeFile(file, lines(rows), { mode: 0o600 });
  for (const [name, parser, method, newSchema] of [
    ['primary', createParser, METHOD, 12],
    ['supplement', createToolFreeParser, TOOL_FREE_METHOD, 13],
  ]) {
    const directory = join(root, name);
    const config = { ...options, createParser: parser, METHOD: method };
    const old = await openTimingStore(directory, config);
    await ingestTimingFile(old, file);
    old.db.prepare("UPDATE turn SET speed_mode='other',model=NULL").run();
    const oldKey = Buffer.from(old.db.prepare('SELECT key FROM turn').get().key);
    const oldRows = readTimingRows(old);
    old.close();
    const current = await openTimingStore(directory, { ...config, parserVersion: INFERENCE_TIMING_PARSER_VERSION });
    try {
      assert.equal(current.db.prepare('PRAGMA user_version').get().user_version, newSchema);
      assert.deepEqual(readTimingRows(current), oldRows, 'opening only adds provenance; it does not relabel old evidence');
      assert.equal(readTimingRows(current, { withRevision: true }).sources[0].parserVersion, 0);
      const before = current.db.prepare('SELECT * FROM source').get();
      const cancel = new AbortController();
      await assert.rejects(ingestTimingFile(current, file, { signal: cancel.signal, onReadLine: () => cancel.abort() }), /cancelled/u);
      assert.deepEqual(current.db.prepare('SELECT * FROM source').get(), before);
      assert.deepEqual(readTimingRows(current), oldRows, 'cancelled replay preserves earlier measurements');
      const replay = await ingestTimingFile(current, file);
      assert.equal(replay.replayed, true);
      assert.equal(replay.invalidated, true);
      assert.equal(replay.revision, 1);
      assert.deepEqual(Buffer.from(current.db.prepare('SELECT key FROM turn').get().key), oldKey);
      const after = readTimingRows(current, { withRevision: true });
      assert.equal(after.rows.length, 1);
      assert.equal(after.rows[0].model, 'gpt-6.1-sol');
      assert.equal(after.rows[0].speed_mode, 'ultrafast');
      assert.equal(after.rows[0].api_service_tier, 'unknown');
      assert.equal(after.sources[0].parserVersion, INFERENCE_TIMING_PARSER_VERSION);
      assert.equal(after.sources[0].telemetryRevision, 2);
      assert.deepEqual(await ingestTimingFile(current, file), { bytes: 0, unchanged: true });
      await assert.rejects(openTimingStore(directory, { ...config, parserVersion: INFERENCE_TIMING_PARSER_VERSION - 1 }), /incompatible_parser_version/u);
    } finally { current.close(); }
  }
});

test('bounded parser repair keeps last-good rows until the complete replay commits after restart', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-parser-staging-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl'), directory = join(root, 'timing');
  const first = fixture();
  Object.assign(first.find(row => row.type === 'turn_context').payload, { model: 'gpt-6.1-sol', service_tier: 'ultrafast' });
  const second = JSON.parse(JSON.stringify(first.slice(1)).replaceAll('synthetic-turn', 'synthetic-next-turn')
    .replaceAll('synthetic-response', 'synthetic-next-response'));
  for (const row of second) {
    row.timestamp = new Date(Date.parse(row.timestamp) + 2000).toISOString();
    for (const key of ['started_at_ms', 'completed_at_ms']) if (Object.hasOwn(row.payload, key)) row.payload[key] += 2000;
  }
  await writeFile(file, lines([...first, ...second]), { mode: 0o600 });
  const priorVersion = INFERENCE_TIMING_PARSER_VERSION - 1;
  const old = await openTimingStore(directory, { ...options, parserVersion: priorVersion });
  await ingestTimingFile(old, file);
  old.db.exec("UPDATE turn SET model=NULL,speed_mode='other'");
  const before = readTimingRows(old);
  assert.equal(before.length, 2);
  old.close();
  const currentOptions = { ...options, parserVersion: INFERENCE_TIMING_PARSER_VERSION };
  let current = await openTimingStore(directory, currentOptions);
  try {
    const partial = await ingestTimingFile(current, file, { maxBytes: Buffer.byteLength(lines(first)) });
    assert.equal(partial.replayed, true);
    assert.equal(partial.invalidated, false);
    assert.equal(partial.revision, 0);
    assert.deepEqual(readTimingRows(current), before);
    assert.equal(current.db.prepare('SELECT COUNT(*) AS count FROM parser_replay_turn').get().count, 1);
    const source = current.db.prepare('SELECT * FROM source').get();
    assert.equal(source.parser_version, priorVersion);
    assert.equal(source.replay_parser_version, INFERENCE_TIMING_PARSER_VERSION);
    const cancel = new AbortController();
    await assert.rejects(ingestTimingFile(current, file, { signal: cancel.signal, onReadLine: () => cancel.abort() }), /cancelled/u);
    assert.deepEqual(current.db.prepare('SELECT * FROM source').get(), source);
    assert.deepEqual(readTimingRows(current), before);
    current.close();
    await assert.rejects(openTimingStore(directory, { ...options, parserVersion: priorVersion }), /incompatible_parser_version/u);
    current = await openTimingStore(directory, currentOptions);
    assert.deepEqual(readTimingRows(current), before);
    const complete = await ingestTimingFile(current, file);
    assert.equal(complete.replayed, true);
    assert.equal(complete.invalidated, true);
    assert.equal(complete.revision, 1);
    const after = readTimingRows(current, { withRevision: true });
    assert.equal(after.rows.length, 2);
    assert.ok(after.rows.every(row => row.model === 'gpt-6.1-sol' && row.speed_mode === 'ultrafast'));
    assert.equal(after.sources[0].parserVersion, INFERENCE_TIMING_PARSER_VERSION);
    assert.equal(after.sources[0].replayParserVersion, 0);
    assert.equal(current.db.prepare('SELECT COUNT(*) AS count FROM parser_replay_turn').get().count, 0);
    assert.deepEqual(await ingestTimingFile(current, file), { bytes: 0, unchanged: true });
  } finally { current.close(); }
});

test('single-source recovery preserves live rows across replacement, restart, disappearance, and retry', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-source-rebuild-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl'), otherFile = join(root, 'other.jsonl'), directory = join(root, 'timing');
  const oldRows = [...namedFixture('old'), ...namedFixture('old-second').slice(1)];
  const otherRows = namedFixture('unaffected', 'gpt-6-sol');
  await writeFile(file, lines(oldRows), { mode: 0o600 });
  await writeFile(otherFile, lines(otherRows), { mode: 0o600 });
  let store = await openTimingStore(directory, options);
  await ingestTimingFile(store, file);
  await ingestTimingFile(store, otherFile);
  const before = readTimingRows(store, { withRevision: true });
  assert.equal(before.rows.length, 3);
  const replacement = [...namedFixture('new-first', 'gpt-6-astra'), ...namedFixture('new-second', 'gpt-6-astra').slice(1)];
  const replacementFirstTurnBytes = Buffer.byteLength(lines(replacement.slice(0, 6)));
  await rm(file);
  await writeFile(file, lines(replacement), { mode: 0o600 });
  let partial;
  try {
    partial = await ingestTimingFile(store, file, { maxBytes: replacementFirstTurnBytes });
    assert.equal(partial.replayed, true);
    assert.equal(partial.invalidated, false);
    assert.deepEqual(readTimingRows(store), before.rows, 'old live measurements remain available during the staged rebuild');
    assert.equal(store.db.prepare("SELECT rebuild_kind FROM source WHERE digest=?").get(
      Buffer.from(store.digest(store.key, 'source-path', file), 'hex')).rebuild_kind, 'source');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM parser_replay_turn').get().count, 1);
    assert.equal(readTimingRows(store, { withRevision: true }).sources.find(source => source.digest === store.digest(store.key, 'source-path', file)).rebuilding, true);
    store.close();
    store = await openTimingStore(directory, options);
    assert.deepEqual(readTimingRows(store), before.rows, 'reopening leaves last-good rows readable');
    await rm(file);
    await assert.rejects(ingestTimingFile(store, file), /source_recovery_failed/u);
    assert.deepEqual(readTimingRows(store), before.rows, 'a missing active source cannot clear saved rows');
    await writeFile(file, lines(replacement), { mode: 0o600 });
    await ingestTimingFile(store, file, { maxBytes: replacementFirstTurnBytes });
    assert.deepEqual(readTimingRows(store), before.rows);
    const complete = await ingestTimingFile(store, file);
    assert.equal(complete.invalidated, true);
    assert.equal(complete.revision, 1);
    const after = readTimingRows(store, { withRevision: true });
    assert.equal(after.rows.length, 3);
    assert.deepEqual(after.rows.filter(row => row.model === 'gpt-6-astra').map(row => row.model), ['gpt-6-astra', 'gpt-6-astra']);
    assert.equal(after.rows.find(row => row.model === 'gpt-6-sol').model, 'gpt-6-sol');
    assert.equal(after.sources.length, 2, 'the independent source stays present');
    assert.equal(after.sources.find(source => source.digest === store.digest(store.key, 'source-path', file)).revision, 1);
    assert.equal(after.sources.find(source => source.digest === store.digest(store.key, 'source-path', otherFile)).revision, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM parser_replay_turn').get().count, 0);
    assert.deepEqual(await ingestTimingFile(store, file), { bytes: 0, unchanged: true }, 'a repeated pass does not duplicate rows');
    assert.equal(readTimingRows(store).length, 3);
  } finally { store.close(); }
});

test('a second replacement during one staged read rolls back and restarts that source from zero', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-source-replace-twice-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl'), directory = join(root, 'timing');
  await writeFile(file, lines([...namedFixture('old'), ...namedFixture('old-second').slice(1)]), { mode: 0o600 });
  const store = await openTimingStore(directory, options);
  try {
    await ingestTimingFile(store, file);
    const liveBefore = readTimingRows(store);
    const firstGeneration = [...namedFixture('gen-one', 'gpt-6-sol'), ...namedFixture('gen-one-second', 'gpt-6-sol').slice(1)];
    const bytesToFirstTurn = Buffer.byteLength(lines(firstGeneration.slice(0, 6))) + 512;
    await rm(file);
    await writeFile(file, lines(firstGeneration), { mode: 0o600 });
    await ingestTimingFile(store, file, { maxBytes: bytesToFirstTurn });
    const stageBefore = store.db.prepare('SELECT key FROM parser_replay_turn ORDER BY offset').all().map(row => Buffer.from(row.key).toString('hex'));
    assert.equal(stageBefore.length, 1, 'the first source generation has exactly one staged turn');

    const secondGeneration = [...namedFixture('gen-two', 'gpt-6-astra'), ...namedFixture('gen-two-second', 'gpt-6-astra').slice(1)];
    await rm(file);
    await writeFile(file, lines(secondGeneration), { mode: 0o600 });
    const cancel = new AbortController();
    await assert.rejects(ingestTimingFile(store, file, { maxBytes: bytesToFirstTurn, signal: cancel.signal,
      onReadLine: () => cancel.abort() }), /cancelled/u);
    assert.deepEqual(store.db.prepare('SELECT key FROM parser_replay_turn ORDER BY offset').all().map(row => Buffer.from(row.key).toString('hex')), stageBefore,
      'rollback retains the previous committed stage and drops partial work');
    assert.deepEqual(readTimingRows(store), liveBefore);
    const restarted = await ingestTimingFile(store, file, { maxBytes: bytesToFirstTurn });
    assert.equal(restarted.replayed, true);
    assert.equal(restarted.invalidated, false);
    const stagedModels = store.db.prepare('SELECT model FROM parser_replay_turn ORDER BY offset').all().map(row => row.model);
    assert.deepEqual(stagedModels, ['gpt-6-astra'], JSON.stringify({ restarted,
      source: store.db.prepare('SELECT cursor,snapshot,rebuild_kind,state FROM source').get() }));
    assert.deepEqual(readTimingRows(store), liveBefore);
    const complete = await ingestTimingFile(store, file);
    assert.equal(complete.invalidated, true);
    assert.ok(readTimingRows(store).every(row => row.model === 'gpt-6-astra'));
  } finally { store.close(); }
});

test('a mutation during one bounded read fails closed while a stable EOF with an incomplete tail can resume after append', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-source-stable-read-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl'), directory = join(root, 'timing');
  await writeFile(file, lines(fixture()), { mode: 0o600 });
  const store = await openTimingStore(directory, options);
  try {
    await ingestTimingFile(store, file);
    const before = readTimingRows(store);
    await rm(file);
    const incomplete = lines(namedFixture('incomplete', 'gpt-6-astra')).slice(0, -1);
    await writeFile(file, incomplete, { mode: 0o600 });
    await assert.rejects(ingestTimingFile(store, file, { maxBytes: Buffer.byteLength(incomplete),
      onReadLine: () => appendFileSync(file, '\n') }), /source_recovery_failed/u);
    assert.deepEqual(readTimingRows(store), before, 'mid-read source mutation rolls back the staged transaction');

    // Restore stable content with an incomplete last record and rebuild it.
    await writeFile(file, incomplete, { mode: 0o600 });
    const completeScan = await ingestTimingFile(store, file, { maxBytes: Buffer.byteLength(incomplete) });
    assert.equal(completeScan.invalidated, true);
    assert.equal(readTimingRows(store).length, 0, 'the incomplete final JSONL line is deferred, not parsed as a turn');
    assert.deepEqual(await ingestTimingFile(store, file), { bytes: 0, unchanged: true }, 'stable incomplete EOF does not stay pending');
    await appendFile(file, '\n');
    await ingestTimingFile(store, file);
    assert.equal(readTimingRows(store).length, 1, 'a later newline triggers a bounded replay that includes the deferred line');

    const oversized = join(root, 'oversized.jsonl');
    await writeFile(oversized, 'x'.repeat(600 * 1024), { mode: 0o600 });
    await ingestTimingFile(store, oversized);
    const oversizedState = store.db.prepare('SELECT cursor,snapshot FROM source WHERE digest=?').get(
      Buffer.from(store.digest(store.key, 'source-path', oversized), 'hex'));
    assert.equal(oversizedState.cursor, 600 * 1024);
    assert.equal(JSON.parse(oversizedState.snapshot).exhausted, true);
    assert.deepEqual(await ingestTimingFile(store, oversized), { bytes: 0, unchanged: true },
      'an oversized unterminated line at stable EOF does not remain pending');
  } finally { store.close(); }
});

test('replays an exhausted source after append and advances a content-free revision fence', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-v12-replay-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'timing'), file = join(root, 'source.jsonl');
  await writeFile(file, lines(fixture()), { mode: 0o600 });
  const store = await openTimingStore(directory, options);
  try {
    const initial = await ingestTimingFile(store, file);
    assert.equal(initial.replayed, false);
    assert.equal(readTimingRows(store, { withRevision: true }).revision, '0');
    const before = readTimingRows(store);
    const beforeWithSources = readTimingRows(store, { withRevision: true });
    assert.equal(before.length, 1);
    assert.equal(beforeWithSources.sources[0].telemetryRevision, 1);
    assert.equal(before[0].turn_duration, 1000);
    await appendFile(file, JSON.stringify(rec(1100, 'event_msg', { type: 'task_started', turn_id: 'late-turn' })) + '\n');
    const replay = await ingestTimingFile(store, file);
    assert.equal(replay.replayed, true);
    assert.equal(replay.invalidated, true);
    assert.equal(replay.revision, 1);
    const after = readTimingRows(store, { withRevision: true });
    assert.equal(after.revision, '1');
    assert.equal(after.sources.length, 1);
    assert.equal(after.sources[0].revision, 1);
    assert.equal(after.sources[0].telemetryRevision, 2);
    assert.match(after.sources[0].digest, /^[0-9a-f]{64}$/u);
    assert.match(after.sources[0].fingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(Object.hasOwn(after.sources[0], 'path'), false);
    assert.deepEqual(after.rows, before, 'stable logical turn remains after a conservative replay');
  } finally { store.close(); }
});

test('advances the telemetry counter on an ordinary append without changing cache revision', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-v12-append-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'timing'), file = join(root, 'source.jsonl');
  const initialRows = fixture().slice(0, 3);
  await writeFile(file, lines(initialRows), { mode: 0o600 });
  const store = await openTimingStore(directory, options);
  try {
    const partial = await ingestTimingFile(store, file, { maxBytes: 1 });
    assert.equal(partial.replayed, false);
    const before = readTimingRows(store, { withRevision: true });
    assert.equal(before.revision, '0');
    assert.equal(before.sources[0].telemetryRevision, 1);

    await appendFile(file, lines(fixture().slice(3)));
    const append = await ingestTimingFile(store, file);
    assert.equal(append.replayed, false, 'an incomplete source resumes from its cursor');
    assert.equal(append.revision, 0, 'the cache/replay revision remains unchanged');
    const after = readTimingRows(store, { withRevision: true });
    assert.equal(after.revision, '0');
    assert.equal(after.sources[0].telemetryRevision, 2);
    assert.equal(after.rows.length, 1);
  } finally { store.close(); }
});

test('daily reads bound primary and supplemental history before the retained export limit', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'timing-v12-day-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'source.jsonl');
  await writeFile(file, lines(fixture()), { mode: 0o600 });
  const store = await openTimingStore(join(root, 'timing'), options);
  try {
    await ingestTimingFile(store, file);
    const initial = readTimingRows(store, { withRevision: true });
    const originalKey = store.db.prepare('SELECT key FROM turn').get().key;
    const columns = store.db.prepare('PRAGMA table_info(turn)').all().map(row => row.name);
    const dayStart = Date.parse('2026-09-01T00:00:00.000Z');
    // Synthetic retained history exceeds both primary and supplement ceilings.
    // A day selector must reach SQLite, not filter the already bounded export.
    const priorSelection = columns.map(column => column === 'key' ? "CAST(printf('%032x',n.x) AS BLOB)"
      : column === 'offset' ? 'n.x' : column === 'at' ? String(dayStart - 1)
      : column === 'sample_method' ? "'tool_free'" : `t.${column}`).join(',');
    store.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100001)
      INSERT INTO turn (${columns.join(',')}) SELECT ${priorSelection}
      FROM n CROSS JOIN turn t WHERE t.key=?`).run(originalKey);
    const edgeSelection = columns.map(column => ['key', 'at'].includes(column) ? '?' : `t.${column}`).join(',');
    const edge = store.db.prepare(`INSERT INTO turn (${columns.join(',')})
      SELECT ${edgeSelection} FROM turn t WHERE t.key=?`);
    edge.run(Buffer.alloc(32, 0xf1), dayStart, originalKey);
    edge.run(Buffer.alloc(32, 0xf2), dayStart + 86_400_000, originalKey);
    assert.throws(() => readTimingRows(store), /export_limit/u);
    assert.throws(() => readTimingRows(store, { supplement: store }), /export_limit/u);
    const daily = readTimingRows(store, { day: '2026-09-01', supplement: store, withRevision: true });
    assert.equal(daily.rows.length, 2);
    assert.deepEqual(daily.rows.map(row => row.at), [dayStart, initial.rows[0].at]);
    assert.deepEqual(daily.sources, initial.sources.map(source => ({ ...source, role: 'primary' }))
      .concat(initial.sources.map(source => ({ ...source, role: 'supplement' }))));
    assert.equal(readTimingRows(store, { day: '2026-09-02' }).length, 1,
      'the UTC upper endpoint belongs only to the next day');
    assert.equal(readTimingRows(store, { day: '2026-09-03' }).length, 0);
    for (const day of ['2026-02-30', '2026-9-01', '', null, true]) {
      assert.throws(() => readTimingRows(store, { day }), /invalid_day/u);
    }
  } finally { store.close(); }
});
