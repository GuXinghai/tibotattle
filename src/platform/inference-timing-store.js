import { resolve } from 'node:path';
import { createTimingFilesystem } from './inference-timing-filesystem.js';
import { configureGuardedSqliteConnection } from './windows-protected-sqlite.js';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { forEachRolloutLine } from './rollout-line-reader.js';
import { createCompressedTimingReader, timingLogicalSourcePath } from './compressed-timing-reader.js';


const APPLICATION = 0x54425450;
const CHUNK = 16 * 1024 * 1024;
const PRIMARY_TURN_COLUMNS = Object.freeze([
  'at', 'model', 'effort', 'tokens', 'reasoning', 'duration', 'ttft',
  'responses', 'covered', 'quality', 'sample_tokens', 'sample_reasoning',
  'sample_duration', 'sample_responses', 'sample_total_responses', 'sample_method',
  'turn_duration', 'speed_mode', 'speed_mode_source', 'api_service_tier',
]);
const REQUIRED_TURN_COLUMNS = Object.freeze([
  'key', 'source', 'offset', ...PRIMARY_TURN_COLUMNS,
]);
const REQUIRED_SOURCE_COLUMNS = Object.freeze([
  'id', 'digest', 'fingerprint', 'cursor', 'snapshot', 'state', 'revision', 'telemetry_revision', 'parser_version', 'replay_parser_version', 'rebuild_kind',
]);
const TURN_SCHEMA = `(key BLOB PRIMARY KEY, source INTEGER NOT NULL, offset INTEGER NOT NULL,
  at INTEGER NOT NULL, model TEXT, effort TEXT, tokens INTEGER, reasoning INTEGER,
  duration INTEGER, ttft INTEGER, responses INTEGER NOT NULL, covered INTEGER NOT NULL,
  quality TEXT NOT NULL, sample_tokens INTEGER, sample_reasoning INTEGER,
  sample_duration INTEGER, sample_responses INTEGER NOT NULL,
  sample_total_responses INTEGER NOT NULL, sample_method TEXT,
  turn_duration INTEGER, speed_mode TEXT, speed_mode_source TEXT,
  api_service_tier TEXT) WITHOUT ROWID`;
const safe = (ok, code) => { if (!ok) throw new Error(code); };
function timingSourceError(message, recoveryReason) {
  const error = new Error(message);
  Object.defineProperty(error, 'recoveryReason', { value: recoveryReason });
  return error;
}

// Measurement methods and persisted identity namespaces are independent.
// Older stores must be converted outside the application before a writer in
// this namespace can accept them; a schema number alone cannot prove keying.
const STORE_SCHEMA_METHODS = Object.freeze({ 2: 12, 3: 13 });
const IDENTITY_VERSION = 'usage-monitor-timing-identity-v1';

function schemaMethodFor(method) {
  safe(Object.hasOwn(STORE_SCHEMA_METHODS, method), 'invalid_method');
  return STORE_SCHEMA_METHODS[method];
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function validateTimingSchema(db) {
  const turnColumns = tableColumns(db, 'turn');
  const sourceColumns = tableColumns(db, 'source');
  safe(REQUIRED_TURN_COLUMNS.every(column => turnColumns.has(column))
    && REQUIRED_SOURCE_COLUMNS.every(column => sourceColumns.has(column)),
  'incompatible_database');
  const replayColumns = tableColumns(db, 'parser_replay_turn');
  safe(REQUIRED_TURN_COLUMNS.every(column => replayColumns.has(column)), 'incompatible_database');
}

function validateTimingIdentity(db, { schemaMethod, correlationKey, parserVersion }) {
  safe(db.prepare('PRAGMA application_id').get().application_id === APPLICATION
    && db.prepare('PRAGMA user_version').get().user_version === schemaMethod, 'incompatible_database');
  const columns = tableColumns(db, 'metadata');
  safe(columns.size === 2 && columns.has('key') && columns.has('identity_version'), 'incompatible_timing_identity');
  const metadata = db.prepare('SELECT key,identity_version FROM metadata').all();
  safe(metadata.length === 1 && metadata[0].key instanceof Uint8Array
    && metadata[0].key.length === 32 && metadata[0].identity_version === IDENTITY_VERSION, 'incompatible_timing_identity');
  const key = Buffer.from(metadata[0].key);
  safe(correlationKey === undefined || key.equals(correlationKey), 'correlation_mismatch');
  validateTimingSchema(db);
  for (const column of ['parser_version', 'replay_parser_version']) {
    const newest = db.prepare(`SELECT COALESCE(MAX(${column}),0) AS version FROM source`).get().version;
    safe(Number.isSafeInteger(newest) && newest >= 0 && newest <= parserVersion, 'incompatible_parser_version');
  }
  return key;
}

function revisionToken(db, supplement = null) {
  const primary = Number(db.prepare('SELECT COALESCE(SUM(revision),0) AS revision FROM source').get().revision);
  safe(Number.isSafeInteger(primary) && primary >= 0, 'invalid_revision');
  if (!supplement) return String(primary);
  const secondary = Number(supplement.db.prepare('SELECT COALESCE(SUM(revision),0) AS revision FROM source').get().revision);
  safe(Number.isSafeInteger(secondary) && secondary >= 0, 'invalid_revision');
  return `${primary}:${secondary}`;
}

function sourceFacts(db) {
  return db.prepare('SELECT id,digest,fingerprint,revision,telemetry_revision,parser_version,replay_parser_version,rebuild_kind,snapshot FROM source ORDER BY id').all()
    .map(row => {
      let parsed;
      try { parsed = JSON.parse(row.snapshot); } catch { throw new Error('invalid_source_snapshot'); }
      const digest = Buffer.from(row.digest);
      safe(Number.isSafeInteger(row.id) && row.id > 0
        && digest.length === 32
        && typeof row.fingerprint === 'string' && /^[0-9a-f]{64}$/u.test(row.fingerprint)
        && Number.isSafeInteger(row.revision) && row.revision >= 0
        && Number.isSafeInteger(row.telemetry_revision) && row.telemetry_revision >= 0
        && Number.isSafeInteger(row.parser_version) && row.parser_version >= 0
        && Number.isSafeInteger(row.replay_parser_version) && row.replay_parser_version >= 0
        && ['none', 'source', 'late'].includes(row.rebuild_kind)
        && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'invalid_source_snapshot');
      return {
        id: row.id,
        digest: digest.toString('hex'),
        fingerprint: row.fingerprint,
        revision: row.revision,
        telemetryRevision: row.telemetry_revision,
        parserVersion: row.parser_version,
        replayParserVersion: row.replay_parser_version,
        rebuilding: row.rebuild_kind !== 'none',
        exhausted: parsed.exhausted === true,
      };
    });
}

function databaseIsClosed(database) {
  if (database === undefined || database === null) return true;
  try { return database.isOpen === false; } catch { return false; }
}

function setAttemptedBytes(error, attemptedBytes) {
  try {
    if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
      Object.defineProperty(error, 'attemptedBytes', {
        configurable: true, enumerable: false, value: attemptedBytes, writable: true,
      });
    }
  } catch { /* Preserve arbitrary thrown values and frozen errors. */ }
}

export async function openTimingStore(directory, { createParser, digest, METHOD, MAX_STATE_BYTES, correlationKey, parserVersion = 0,
  compressedReader = null,
  filesystem = createTimingFilesystem(),
  databaseFactory = (file, options) => new DatabaseSync(file, options) }) {
  const schemaMethod = schemaMethodFor(METHOD);
  safe(Number.isSafeInteger(parserVersion) && parserVersion >= 0, 'invalid_parser_version');
  safe(correlationKey === undefined || Buffer.isBuffer(correlationKey) && correlationKey.length === 32, 'invalid_metadata');
  const lease = await filesystem.prepare(directory);
  const { file, created } = lease;
  let db;
  let dbClosed = false;
  let leaseReleaseAttempted = false;
  let leaseReleaseError = null;
  let ownedCompressedReader = null;
  if (compressedReader !== null && ['slice', 'commit', 'detach', 'close', 'register', 'checkpoint'].some(k => typeof compressedReader[k] !== 'function')) {
    lease.release(); throw new TypeError('Invalid compressed timing reader');
  }

  // SQLite must be closed before its native file guards are released. If a
  // close failure leaves the database open, retain the lease and let a caller
  // retry close rather than allowing another owner to reach the file.
  function closeOwnedResources(primaryError = null) {
    let firstError = primaryError;
    if (!dbClosed && db !== undefined) {
      try {
        db.close();
        dbClosed = databaseIsClosed(db);
        if (!dbClosed && firstError === null) firstError = new Error('database_close_incomplete');
      } catch (error) {
        if (firstError === null) firstError = error;
        dbClosed = databaseIsClosed(db);
      }
    } else if (db === undefined) {
      dbClosed = true;
    }
    if (dbClosed && !leaseReleaseAttempted) {
      leaseReleaseAttempted = true;
      try {
        lease.release();
      } catch (error) {
        leaseReleaseError = error;
        if (firstError === null) firstError = error;
      }
    }
    if (firstError === null && leaseReleaseError !== null) firstError = leaseReleaseError;
    return firstError;
  }

  try {
    // Inspect existing stores through a read-only connection before any
    // journal/write pragma. The native lease remains held across reopening.
    db = databaseFactory(file, { timeout: 100, readOnly: !created });
    let key;
    if (!created) {
      key = validateTimingIdentity(db, { schemaMethod, correlationKey, parserVersion });
      db.close();
      dbClosed = databaseIsClosed(db);
      safe(dbClosed, 'database_close_incomplete');
      db = databaseFactory(file, { timeout: 100 });
      dbClosed = false;
      const reopenedKey = validateTimingIdentity(db, { schemaMethod, correlationKey, parserVersion });
      safe(key.equals(reopenedKey), 'correlation_mismatch');
    }
    if (lease.persistentJournal) configureGuardedSqliteConnection(db);
    db.exec('PRAGMA busy_timeout=100; PRAGMA cache_size=-2048; PRAGMA synchronous=FULL; PRAGMA max_page_count=65536;');
    if (created) {
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE metadata (key BLOB NOT NULL CHECK(length(key)=32),
          identity_version TEXT NOT NULL CHECK(identity_version='${IDENTITY_VERSION}'));
        CREATE TABLE source (id INTEGER PRIMARY KEY, digest BLOB UNIQUE NOT NULL,
          fingerprint TEXT NOT NULL, cursor INTEGER NOT NULL, snapshot TEXT NOT NULL,
          state TEXT NOT NULL CHECK(length(state)<=${MAX_STATE_BYTES}),
          revision INTEGER NOT NULL DEFAULT 0,
          telemetry_revision INTEGER NOT NULL DEFAULT 0,
          parser_version INTEGER NOT NULL DEFAULT 0,
          replay_parser_version INTEGER NOT NULL DEFAULT 0,
          rebuild_kind TEXT NOT NULL DEFAULT 'none' CHECK(rebuild_kind IN ('none','source','late')));
        CREATE TABLE turn ${TURN_SCHEMA};
        CREATE TABLE parser_replay_turn ${TURN_SCHEMA};
        CREATE INDEX turn_time ON turn(at);
        PRAGMA application_id=${APPLICATION}; PRAGMA user_version=${schemaMethod};`);
      db.prepare('INSERT INTO metadata VALUES (?,?)').run(correlationKey ?? randomBytes(32), IDENTITY_VERSION);
      db.exec('COMMIT');
    }
    if (created) key = validateTimingIdentity(db, { schemaMethod, correlationKey, parserVersion });
    compressedReader?.register(file);
    return { db, key, file, createParser, digest, filesystem, method: METHOD, parserVersion,
      readCompressed: () => {
        if (compressedReader) return compressedReader;
        if (!ownedCompressedReader) { ownedCompressedReader = createCompressedTimingReader({ filesystem }); ownedCompressedReader.register(file); }
        return ownedCompressedReader;
      },
      close: () => {
      compressedReader?.detach(file);
      const error = closeOwnedResources();
      if (error !== null) throw error;
      return ownedCompressedReader?.close();
    } };
  } catch (e) {
    closeOwnedResources(e);
    throw e;
  }
}

const snapshot = s => ({ dev: s.dev, ino: s.ino, birth: s.birthtimeMs,
  size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birth === b.birth;
async function fingerprint(handle, cursor, key, digest) {
  const first = Buffer.alloc(Math.min(cursor, 4096));
  const tail = Buffer.alloc(Math.min(cursor, 4096));
  if (first.length) {
    safe((await handle.read(first, 0, first.length, 0)).bytesRead === first.length, 'source_changed');
    safe((await handle.read(tail, 0, tail.length, cursor - tail.length)).bytesRead === tail.length, 'source_changed');
  }
  return digest(key, 'prefix-tail', Buffer.concat([first, tail]));
}

export async function ingestTimingFile(store, path, { maxBytes = CHUNK, signal, onReadLine } = {}) {
  safe(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= CHUNK, 'invalid_budget');
  const { db, key, createParser, digest } = store;
  const sourceKey = Buffer.from(digest(key, 'source-path', timingLogicalSourcePath(path)), 'hex');
  const old = db.prepare('SELECT * FROM source WHERE digest=?').get(sourceKey);
  if (path.endsWith('.jsonl.zst')) return ingestCompressedTimingFile(store, path, {
    sourceKey, old, maxBytes, signal, onReadLine,
  });
  let handle;
  try {
    handle = await store.filesystem.openSource(path);
  } catch (error) {
    if (old && (old.rebuild_kind !== 'none'
        || old.parser_version !== store.parserVersion && old.replay_parser_version === store.parserVersion)) {
      throw timingSourceError('source_recovery_failed',
        ['ENOENT', 'WINDOWS_FILESYSTEM_NOT_FOUND'].includes(error?.code)
          ? 'recovery_source_missing' : 'recovery_source_read_failed');
    }
    throw error;
  }
  let attemptedBytes = 0;
  let primaryError = null;
  let recoveryAttempt = false;
  try {
    const stat = await handle.stat();
    const before = snapshot(stat);
    const cursor = old?.cursor ?? 0;
    let previous = null;
    let upgradingParser = false;
    let rebuildKind = old?.rebuild_kind ?? 'none';
    let resetStaging = false;
    if (old) {
      previous = JSON.parse(old.snapshot);
      safe(Number.isSafeInteger(old.parser_version) && old.parser_version >= 0
        && old.parser_version <= store.parserVersion
        && Number.isSafeInteger(old.replay_parser_version) && old.replay_parser_version >= 0
        && old.replay_parser_version <= store.parserVersion, 'incompatible_parser_version');
      upgradingParser = old.parser_version !== store.parserVersion;
      const identityMatches = sameFile(before, previous);
      const cursorFits = cursor <= before.size;
      const prefixMatches = identityMatches && cursorFits
        ? await fingerprint(handle, cursor, key, digest) === old.fingerprint
        : false;
      const sameSizeChanged = identityMatches && before.size === previous.size
        && (before.mtime !== previous.mtime || before.ctime !== previous.ctime);
      const sourceChanged = !identityMatches || !cursorFits || before.size < previous.size
        || sameSizeChanged || identityMatches && cursorFits && !prefixMatches;
      if (sourceChanged) {
        // Rebuild only this source. The prior live rows stay readable while the
        // replacement is parsed in bounded chunks into parser_replay_turn.
        rebuildKind = 'source';
        resetStaging = true;
      }
      if (!sourceChanged && rebuildKind === 'none' && !upgradingParser
          && before.size === previous.size && before.mtime === previous.mtime
          && before.ctime === previous.ctime
          && (cursor === before.size || previous.exhausted === true)) {
        return { bytes: 0, unchanged: true };
      }
      // A source that was completely scanned can later gain a delayed record.
      // Rebuild its logical rows from the beginning in the same transaction so
      // stale measurements disappear even when the late record is not itself
      // a second completion. Keep this selected-source replay staged as well.
      if (!sourceChanged && rebuildKind === 'none' && !upgradingParser
          && before.size > previous.size && previous.exhausted === true) {
        rebuildKind = 'late';
        resetStaging = true;
      }
      if (upgradingParser && old.replay_parser_version !== store.parserVersion) resetStaging = true;
      recoveryAttempt = rebuildKind !== 'none';
    }
    if (signal?.aborted) throw new Error('cancelled');
    const start = resetStaging ? 0 : cursor, end = Math.min(before.size, start + maxBytes);
    attemptedBytes = end - start;
    return await commitTimingBatch(store, { old, sourceKey, before, upgradingParser, rebuildKind,
      resetStaging, start, end, signal, onReadLine, exhausted: end === before.size,
      readLines: controls => forEachRolloutLine(handle, controls),
      verifyAfter: () => verifyTimingSource(store, path, handle, before),
      fingerprintAt: offset => fingerprint(handle, offset, key, digest),
    });
  } catch (e) {
    const reported = recoveryAttempt && e?.message === 'source_changed'
      ? timingSourceError('source_recovery_failed', e.recoveryReason ?? 'source_changed_unknown') : e;
    primaryError = reported;
    setAttemptedBytes(reported, attemptedBytes);
    throw reported;
  } finally {
    try {
      await handle.close();
    } catch (e) {
      if (primaryError === null) {
        setAttemptedBytes(e, attemptedBytes);
        throw e;
      }
      // A cleanup failure must not replace the parser, read, or transaction
      // error that the caller uses to account for attempted bytes.
    }
  }
}

async function ingestCompressedTimingFile(store, path, { sourceKey, old, maxBytes, signal, onReadLine }) {
  let handle, attemptedBytes = 0, primaryError = null;
  try {
    signal?.throwIfAborted();
    handle = await store.filesystem.openSource(path);
    const physical = await handle.stat(), before = snapshot(physical);
    const previous = old ? JSON.parse(old.snapshot) : null;
    if (previous?.compression === 'zstd') safe(Number.isSafeInteger(old.cursor) && old.cursor >= 0
      && typeof previous.exhausted === 'boolean'
      && (previous.logicalSize === null || Number.isSafeInteger(previous.logicalSize)
        && previous.logicalSize >= old.cursor && previous.logicalSize <= 16 * 1024 ** 3)
      && (!previous.exhausted || previous.logicalSize !== null), 'invalid_source_snapshot');
    if (old) safe(Number.isSafeInteger(old.parser_version) && old.parser_version >= 0
      && old.parser_version <= store.parserVersion && Number.isSafeInteger(old.replay_parser_version)
      && old.replay_parser_version >= 0 && old.replay_parser_version <= store.parserVersion, 'incompatible_parser_version');
    const unchangedPhysical = previous?.compression === 'zstd' && sameFile(before, previous)
      && before.size === previous.size && before.mtime === previous.mtime && before.ctime === previous.ctime;
    const upgradingParser = old !== undefined && old.parser_version !== store.parserVersion;
    const reader = store.readCompressed();
    if (unchangedPhysical && !upgradingParser && old.rebuild_kind === 'none'
        && old.replay_parser_version === 0 && previous.exhausted === true) {
      reader.checkpoint(path, store.file, Infinity);
      return { bytes: 0, decodedBytes: 0, unchanged: true };
    }
    const resetStaging = !unchangedPhysical || upgradingParser && old.replay_parser_version !== store.parserVersion;
    const rebuildKind = unchangedPhysical ? old.rebuild_kind : 'source';
    const start = resetStaging ? 0 : old.cursor;
    reader.checkpoint(path, store.file, start);
    const slice = await reader.slice({ path, physical, start, maxBytes, consumer: store.file, signal });
    attemptedBytes = slice.readBytes;
    if (!slice.ready) {
      await verifyTimingSource(store, path, handle, before);
      return { bytes: slice.readBytes, decodedBytes: slice.readBytes, preparing: true,
        unchanged: false, remaining: 1, partial: false };
    }
    // A resumed parser checkpoint must refer to the same decoded prefix. This
    // check costs no additional decompression and never trusts a physical size
    // as a logical cursor.
    if (!resetStaging && old.cursor > 0) safe(
      slice.fingerprint(old.cursor, store.key, store.digest) === old.fingerprint, 'source_changed');
    const memoryHandle = {
      stat: async () => physical,
      async read(buffer, offset, length, position) {
        safe(position >= start && position + length <= slice.end, 'invalid_source_read');
        const bytes = slice.bytes.subarray(position - start, position - start + length);
        buffer.set(bytes, offset); return { bytesRead: bytes.length, buffer };
      },
    };
    const result = await commitTimingBatch(store, { old, sourceKey, before, upgradingParser,
      rebuildKind, resetStaging, start, end: slice.end, signal, onReadLine, exhausted: slice.exhausted,
      readLines: controls => forEachRolloutLine(memoryHandle, controls),
      verifyAfter: async () => ({ ...await verifyTimingSource(store, path, handle, before),
        compression: 'zstd', logicalSize: slice.logicalSize }),
      fingerprintAt: offset => slice.fingerprint(offset, store.key, store.digest),
    });
    reader.commit(path, store.file, result.cursor);
    return { ...result, decodedBytes: slice.readBytes,
      remaining: slice.exhausted ? Math.max(0, slice.end - result.cursor) : 1 };
  } catch (error) {
    primaryError = error;
    const reported = error?.message === 'source_changed' ? Object.assign(
      timingSourceError('source_recovery_failed', error.recoveryReason ?? 'source_changed_unknown'), { code: 'source_recovery_failed' }) : error;
    setAttemptedBytes(reported, attemptedBytes); throw reported;
  } finally {
    try { await handle?.close(); } catch (error) { if (!primaryError) throw error; }
  }
}

export function readTimingRows(store, { supplement = null, withRevision = false, day } = {}) {
  // Bound daily sharing reads before materializing rows. The all-history
  // dashboard/export limit must not make a small day unavailable merely
  // because retained history outside that day exceeds the export ceiling.
  let window = null;
  if (day !== undefined) {
    safe(typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(day), 'invalid_day');
    const start = Date.parse(`${day}T00:00:00.000Z`);
    safe(Number.isSafeInteger(start) && start >= 0
      && new Date(start).toISOString().slice(0, 10) === day, 'invalid_day');
    window = [start, start + 86_400_000];
  }
  // Correlation handles remain local. Only joined numeric observations leave
  // this owner; a supplemental scan cannot add turns or replace old metrics.
  let extras = null;
  if (supplement) {
    safe(store.key.equals(supplement.key), 'correlation_mismatch');
    const candidates = supplement.db.prepare(`SELECT key,at,model,effort,tokens,reasoning,duration,ttft,
      responses,covered,quality,sample_tokens,sample_duration FROM turn
      WHERE sample_method='tool_free'${window ? ' AND at>=? AND at<?' : ''}
      LIMIT 100001`).all(...(window ?? []));
    safe(candidates.length <= 100000, 'export_limit');
    extras = new Map(candidates.map(row => [Buffer.from(row.key).toString('hex'), row]));
  }
  const rows = store.db.prepare(`SELECT key,at,model,effort,tokens,reasoning,duration,ttft,
    responses,covered,quality,sample_tokens,sample_reasoning,sample_duration,
    sample_responses,sample_total_responses,sample_method,turn_duration,speed_mode,
    speed_mode_source,api_service_tier FROM turn${window ? ' WHERE at>=? AND at<?' : ''}
    ORDER BY at LIMIT 100001`).all(...(window ?? []));
  safe(rows.length <= 100000, 'export_limit');
  const result = rows.map(({ key, turn_duration, speed_mode, speed_mode_source, api_service_tier, ...row }) => {
    // Legacy v1 rows predate the performance supplement. Keep their exact
    // reporting shape; newly parsed rows carry at least the explicit unknown
    // mode/service values and therefore expose the additive nullable fields.
    if (turn_duration !== null || speed_mode !== null || speed_mode_source !== null || api_service_tier !== null) {
      row.turn_duration = turn_duration;
      row.speed_mode = speed_mode;
      row.speed_mode_source = speed_mode_source;
      row.api_service_tier = api_service_tier;
    }
    const extra = extras?.get(Buffer.from(key).toString('hex'));
    if (extra && row.model !== null && ['at', 'model', 'effort', 'tokens', 'reasoning',
      'duration', 'ttft', 'responses', 'covered', 'quality'].every(field => row[field] === extra[field])) {
      row.tool_free_tokens = extra.sample_tokens;
      row.tool_free_duration = extra.sample_duration;
    }
    return row;
  });
  if (!withRevision) return result;
  const sources = sourceFacts(store.db).map(source => ({ ...source, role: 'primary' }));
  if (supplement) sources.push(...sourceFacts(supplement.db).map(source => ({ ...source, role: 'supplement' })));
  return { rows: result, revision: revisionToken(store.db, supplement), sources };
}

export function timingReport(store) {
  const rows = readTimingRows(store);
  const diagnostics = {};
  for (const row of store.db.prepare('SELECT state FROM source').iterate()) {
    for (const [k, v] of Object.entries(JSON.parse(row.state).diagnostics ?? {}))
      diagnostics[k] = (diagnostics[k] ?? 0) + v;
  }
  return { method: store.method, diagnostics, turns: rows };
}

async function verifyTimingSource(store, path, handle, before) {
  const after = snapshot(await handle.stat()), named = snapshot(await store.filesystem.namedStat(path, handle));
  if (!sameFile(before, after) || !sameFile(before, named)) throw timingSourceError('source_changed', 'source_identity_changed');
  if (after.size < before.size) throw timingSourceError('source_changed', 'source_truncated_during_read');
  if (after.size > before.size) throw timingSourceError('source_changed', 'source_grew_during_read');
  if (before.mtime !== after.mtime || before.ctime !== after.ctime) throw timingSourceError('source_changed', 'source_metadata_changed_during_read');
  return after;
}

async function commitTimingBatch(store, { old, sourceKey, before, upgradingParser, rebuildKind,
  resetStaging, start, end, signal, onReadLine, exhausted, readLines, verifyAfter, fingerprintAt }) {
  const { db, key, createParser } = store;
  const stagedReplay = upgradingParser || rebuildKind !== 'none';
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!old) db.prepare('INSERT INTO source(digest,fingerprint,cursor,snapshot,state) VALUES (?,?,?,?,?)')
        .run(sourceKey, '', 0, JSON.stringify(before), '{}');
      const source = old?.id ?? Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
      // Parser repairs and source rebuilds may span many bounded reads. Keep
      // prior live rows until the complete replacement commits atomically.
      const table = stagedReplay ? 'parser_replay_turn' : 'turn';
      if (resetStaging) db.prepare('DELETE FROM parser_replay_turn WHERE source=?').run(source);
      const insert = db.prepare(`INSERT OR IGNORE INTO ${table}
        (key,source,offset,${PRIMARY_TURN_COLUMNS.join(',')})
        VALUES (${new Array(3 + PRIMARY_TURN_COLUMNS.length).fill('?').join(',')})`);
      const existing = db.prepare(`SELECT ${PRIMARY_TURN_COLUMNS.join(',')} FROM ${table} WHERE key=?`);
      const conflictFields = "model=NULL,effort=NULL,duration=NULL,ttft=NULL,sample_tokens=NULL,sample_reasoning=NULL,sample_duration=NULL,sample_responses=0,sample_method=NULL,turn_duration=NULL,speed_mode=NULL,speed_mode_source=NULL,api_service_tier=NULL,quality='conflicting_duplicate'";
      const conflict = db.prepare(`UPDATE ${table} SET ${conflictFields} WHERE key=?`);
      const saved = resetStaging ? null : old ? JSON.parse(old.state) : null;
      let discardLine = saved?.discardLine === true;
      const parser = createParser(key, saved, t => {
        const turnKey = Buffer.from(t.key, 'hex');
        const prior = existing.get(turnKey);
        const values = PRIMARY_TURN_COLUMNS.map(column => t[column] ?? null);
        if (prior) {
          if (PRIMARY_TURN_COLUMNS.some((column, index) => prior[column] !== values[index])) conflict.run(turnKey);
        } else insert.run(turnKey, source, t.offset, ...values);
      });
      const receipt = await readLines({ start, end, signal,
        onLine: (line, offset, partial) => {
          if (discardLine) discardLine = false;
          else parser.line(line, offset, partial);
          onReadLine?.();
        } });
      if (receipt.aborted || signal?.aborted) throw new Error('cancelled');
      const after = await verifyAfter();
      let nextOffset = receipt.nextOffset;
      // Persist only the fact that an oversized line is being discarded. This
      // allows arbitrarily large content lines without retaining their bytes or
      // repeatedly reading the same prefix. Resume parsing after its newline.
      if (nextOffset === start && (discardLine || end - start > 64 * 1024)) {
        if (!discardLine) parser.line(Buffer.alloc(0), end, true);
        discardLine = true; nextOffset = end;
      }
      const state = parser.state(); state.discardLine = discardLine;
      // A stable EOF scan may defer an incomplete final line. Mark the source
      // exhausted for this file version so it is not retried forever; a later
      // append triggers the bounded late-source rebuild and parses that line.
      after.exhausted = exhausted;
      if (state.blocked) db.prepare(`UPDATE ${table} SET model=NULL,effort=NULL,duration=NULL,ttft=NULL,sample_tokens=NULL,sample_reasoning=NULL,sample_duration=NULL,sample_responses=0,sample_method=NULL,turn_duration=NULL,speed_mode=NULL,speed_mode_source=NULL,api_service_tier=NULL,quality='blocked_source' WHERE source=?`).run(source);
      const replacementComplete = stagedReplay && after.exhausted;
      if (replacementComplete) {
        db.prepare('DELETE FROM turn WHERE source=?').run(source);
        // Preserve the original cross-source duplicate/conflict policy when
        // the staged replacement joins the live measurement set.
        db.prepare(`UPDATE turn SET ${conflictFields} WHERE key IN (
          SELECT staged.key FROM parser_replay_turn staged JOIN turn live ON live.key=staged.key
          WHERE staged.source=? AND (${PRIMARY_TURN_COLUMNS.map(column => `live.${column} IS NOT staged.${column}`).join(' OR ')})
        )`).run(source);
        const columns = ['key', 'source', 'offset', ...PRIMARY_TURN_COLUMNS].join(',');
        db.prepare(`INSERT OR IGNORE INTO turn (${columns}) SELECT ${columns} FROM parser_replay_turn WHERE source=?`).run(source);
        db.prepare('DELETE FROM parser_replay_turn WHERE source=?').run(source);
      }
      const previousRevision = old === undefined ? 0 : old.revision;
      const previousTelemetryRevision = old === undefined ? 0 : old.telemetry_revision;
      safe(Number.isSafeInteger(previousRevision) && previousRevision >= 0, 'invalid_revision');
      safe(Number.isSafeInteger(previousTelemetryRevision) && previousTelemetryRevision >= 0, 'invalid_telemetry_revision');
      const invalidated = replacementComplete && (upgradingParser || rebuildKind !== 'none');
      const revision = previousRevision + (invalidated ? 1 : 0);
      const telemetryRevision = previousTelemetryRevision + 1;
      safe(Number.isSafeInteger(revision) && revision >= 0, 'invalid_revision');
      safe(Number.isSafeInteger(telemetryRevision) && telemetryRevision >= 1, 'invalid_telemetry_revision');
      db.prepare('UPDATE source SET fingerprint=?,cursor=?,snapshot=?,state=?,revision=?,telemetry_revision=?,parser_version=?,replay_parser_version=?,rebuild_kind=? WHERE id=?')
        .run(await fingerprintAt(nextOffset), nextOffset,
          JSON.stringify(after), JSON.stringify(state), revision, telemetryRevision,
          upgradingParser && !replacementComplete ? old.parser_version : store.parserVersion,
          upgradingParser && !replacementComplete ? store.parserVersion : 0,
          replacementComplete ? 'none' : rebuildKind, source);
      db.exec('COMMIT');
      return { bytes: end - start, unchanged: false, replayed: stagedReplay, invalidated,
        revision, cursor: nextOffset, remaining: exhausted ? Math.max(0, end - nextOffset) : Math.max(1, before.size - nextOffset), partial: receipt.partialDeferred };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* Preserve the operation failure. */ }
      throw e;
    }
}
