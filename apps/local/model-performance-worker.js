import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { opendir, lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { MODEL_PERFORMANCE_MAX_WINDOWS, MODEL_PERFORMANCE_SOURCE_DIAGNOSTICS } from './model-performance-snapshots.js';
import { openTimingStore, ingestTimingFile, readTimingRows, createCompressedTimingReader, timingLogicalSourcePath } from '../../src/platform/index.js';
import { createModelPerformanceContext } from '../../src/application/index.js';

// The Windows native SQLite guard retains the two nearest parent-directory
// handles with delete sharing disabled. A nested supplemental store would
// therefore be unable to reopen its guarded parent while the primary store is
// live. Keep the sidecar under a sibling root on Windows so both stores can be
// opened concurrently without weakening the native guard.
export function modelPerformanceSupplementDirectory({ directory, timingRoot, platform = process.platform }) {
  if (platform !== 'win32' || typeof timingRoot !== 'string' || timingRoot.length === 0
      || typeof directory !== 'string' || directory.length === 0) {
    return join(directory, 'tool-free-v1');
  }
  return join(dirname(timingRoot), 'inference-timing-tool-free-v1', basename(directory));
}

const PERFORMANCE_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const PERFORMANCE_PROVIDER = 'openai_codex';

export async function discoverModelPerformanceSources(codexHome, signal = null) {
  const result = new Map(); let entries = 0;
  async function walk(path, depth) {
    signal?.throwIfAborted();
    if (depth > 3) return;
    let directory;
    try { directory = await opendir(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (++entries > 50000) throw new Error('discovery_limit');
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next, depth + 1);
      else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst'))) {
        const stat = await lstat(next), logicalPath = timingLogicalSourcePath(next);
        const file = { path: next, logicalPath, at: stat.mtimeMs, compressed: next.endsWith('.zst') };
        const prior = result.get(logicalPath);
        if (!prior || prior.compressed && !file.compressed) result.set(logicalPath, file);
      }
    }
  }
  await walk(join(codexHome, 'sessions'), 0);
  await walk(join(codexHome, 'archived_sessions'), 0);
  return [...result.values()].sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
}

export function modelPerformanceSourceFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (error?.message === 'source_recovery_failed' || code === 'codex_rollout_source_changed') return 'timing_source_recovery_failed';
  if (code === 'codex_rollout_compression_unsupported') return 'timing_source_unsupported';
  if (code === 'codex_rollout_content_invalid') return 'timing_source_decode_failed';
  if (code.startsWith('export_resource_')) return 'timing_source_limit';
  if (['ENOENT', 'EACCES', 'EPERM'].includes(code) || code.startsWith('WINDOWS_FILESYSTEM_')) return 'timing_source_read_failed';
  return 'timing_store_failed';
}

export function modelPerformanceSourceRecoveryReason(error) {
  return MODEL_PERFORMANCE_SOURCE_DIAGNOSTICS.includes(error?.recoveryReason) ? error.recoveryReason
    : error?.message === 'source_recovery_failed' || error?.code === 'codex_rollout_source_changed'
      ? 'source_changed_unknown' : null;
}

export function modelPerformanceRecoveryDiagnostics(failures, sources, discoveredDigests) {
  const counts = new Map();
  const add = (code, digest) => {
    if (!MODEL_PERFORMANCE_SOURCE_DIAGNOSTICS.includes(code)) return;
    const ids = counts.get(code) ?? new Set(); ids.add(digest); counts.set(code, ids);
  };
  for (const [digest, reasons] of failures) for (const reason of reasons) add(reason, digest);
  if (discoveredDigests !== null) for (const row of sources) {
    if (row.rebuilding && !discoveredDigests.has(row.digest)) add('recovery_source_not_discovered', row.digest);
  }
  return [...counts].map(([code, ids]) => ({ code, count: ids.size }));
}

export function modelPerformanceHistoryState(sources, parserVersion, discoveredDigests) {
  let pending = 0, unavailable = 0, recoveryFailed = 0;
  for (const source of sources) {
    const discovered = discoveredDigests === null || discoveredDigests.has(source.digest);
    if (source.rebuilding) {
      if (discovered) pending++;
      else { unavailable++; recoveryFailed++; }
      continue;
    }
    if (source.parserVersion === parserVersion && source.replayParserVersion === 0) continue;
    if (discovered) pending++;
    else unavailable++;
  }
  return { pending, unavailable, recoveryFailed };
}

// Separate from accounting: no accounting DB. The worker serves bounded
// dashboard reads. Fixed, bounded errors only.
async function run() {
  const compressedReader = createCompressedTimingReader();
  const context = createModelPerformanceContext({ openStore: openTimingStore, compressedReader });
  const abort = new AbortController();
  let timer, store, supplement, files = null, cursor = 0, discoveryAt = 0, stopped = false, degraded = false, passFailed = false;
  let publishedRevision = null;
  let discoveredDigests = null;
  const diagnostics = new Set();
  const sourceFailures = new Map();
  const sourceRecoveryReasons = new Map();
  let recoveryDiagnostics = [];
  let stage = 'timing_store_failed';
  const emitDiagnostics = () => parentPort.postMessage({ type: 'diagnostics', codes: [...diagnostics], sourceDetails: recoveryDiagnostics });
  const windows = new Map();
  let windowsChanged = false;
  const stop = () => { stopped = true; clearTimeout(timer); abort.abort(); };
  parentPort.on('message', message => {
    if (message?.type === 'stop') stop();
    else if (message?.type === 'window' && ['1','7','30','all'].includes(message.period)
      && Number.isSafeInteger(message.end) && message.end >= 0 && message.end <= Date.now()
      && ['standard', 'fast', 'ultrafast'].includes(message.speedMode)
      && message.requestKey === `${message.period}:${message.speedMode}:${message.end}`) {
      windows.set(message.requestKey, message); windowsChanged = true;
      while (windows.size > MODEL_PERFORMANCE_MAX_WINDOWS) windows.delete(windows.keys().next().value);
    }
  });
  let lastPublished = 0, lastCollecting = null;
  function publish(collecting) {
    let rows, revision, history, sourceFacts;
    try {
      const result = readTimingRows(store, { supplement, withRevision: true });
      rows = result.rows; revision = result.revision;
      sourceFacts = result.sources;
      history = modelPerformanceHistoryState(result.sources, context.parserVersion, discoveredDigests);
    } catch {
      degraded = true; passFailed = true;
      diagnostics.add('timing_store_failed');
      const result = readTimingRows(store, { withRevision: true });
      rows = result.rows; revision = result.revision;
      sourceFacts = result.sources;
      history = modelPerformanceHistoryState(result.sources, context.parserVersion, discoveredDigests);
    }
    if (history.unavailable) diagnostics.add('timing_history_unavailable');
    else diagnostics.delete('timing_history_unavailable');
    recoveryDiagnostics = modelPerformanceRecoveryDiagnostics(sourceRecoveryReasons, sourceFacts, discoveredDigests);
    for (const code of ['timing_source_recovery_failed', 'timing_source_decode_failed', 'timing_source_read_failed', 'timing_source_limit', 'timing_source_unsupported']) {
      if (code === 'timing_source_recovery_failed' && history.recoveryFailed
          || [...sourceFailures.values()].some(codes => codes.has(code))) diagnostics.add(code);
      else diagnostics.delete(code);
    }
    if (publishedRevision !== null && revision !== publishedRevision) {
      // A completed source grew after its last scan. The store replay has
      // already removed/rebuilt affected logical rows; invalidate any durable
      // dashboard snapshot before publishing the replacement projection.
      parentPort.postMessage({ type: 'invalidate', revision });
    }
    publishedRevision = revision;
    const now = Date.now();
    lastPublished = now; lastCollecting = collecting; windowsChanged = false;
    stage = 'timing_projection_failed';
    parentPort.postMessage({ type: 'snapshots', revision,
      cacheable: files !== null && !collecting && !degraded && history.pending === 0, values: [
      ...['1', '7', '30', 'all'].flatMap(period => ['standard', 'fast', 'ultrafast'].map(speedMode => ({ period, speedMode, end: now }))), ...windows.values(),
    ].map(({period, speedMode, end, requestKey}) => ({
      ...(requestKey ? { requestKey } : {}),
      ...context.project(rows, { period, speedMode, now: end, rolling: Boolean(requestKey), historyProgress: files === null ? null : {
        checked: Math.min(cursor, files.length), total: files.length,
      } }), updatedAt: new Date(now).toISOString(), collecting,
      stale: degraded || history.pending > 0 || history.unavailable > 0,
    })) });
    diagnostics.delete('timing_projection_failed');
    emitDiagnostics();
  }
  try {
    // Windows' qualified filesystem adapter creates and verifies both parent
    // directories through its native owner-protection boundary inside open().
    if (process.platform !== 'win32' && workerData.timingRoot !== undefined) {
      const root = resolve(workerData.timingRoot);
      if (await realpath(dirname(root)) !== dirname(root)) throw new Error('unsafe_directory');
      await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const metadata = await lstat(root);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
          || (metadata.mode & 0o077)) throw new Error('unsafe_directory');
    }
    // Additive, independently checkpointed backfill. Failure leaves all
    // original saved measurements usable; neither store is converted to the
    // other's method or correlation key.
    store = await context.open(workerData.directory);
    // Publish only after both independent stores are opened so the first
    // revision token does not spuriously change when the supplement appears.
    try {
      supplement = await context.openSupplement(modelPerformanceSupplementDirectory({
        directory: workerData.directory,
        timingRoot: workerData.timingRoot,
      }), store.key);
    }
    catch { degraded = true; diagnostics.add('timing_store_failed'); }
    publish(true);
    while (!stopped) {
      try {
        if (files === null || (cursor >= files.length && Date.now() - discoveryAt >= 60_000)) {
          stage = 'timing_scan_failed';
          files = await discoverModelPerformanceSources(workerData.codexHome, abort.signal); cursor = 0; discoveryAt = Date.now(); passFailed = !supplement;
          discoveredDigests = new Set(files.map(file => store.digest(store.key, 'source-path', file.logicalPath)));
          diagnostics.delete('timing_scan_failed');
          if (supplement) diagnostics.delete('timing_store_failed');
        }
        const started = performance.now(); let bytes = 0;
        while (!stopped && cursor < files.length && bytes < 32 * 1024 ** 2 && performance.now() - started < 750) {
          try {
            stage = 'timing_store_failed';
            let done = true;
            const failuresForSource = new Set();
            const recoveryReasonsForSource = new Set();
            // Two 2-MiB chunks preserve the original total 4-MiB slice budget.
            for (const target of [store, supplement].filter(Boolean)) {
              try {
                const result = await ingestTimingFile(target, files[cursor].path, { maxBytes: 2 * 1024 ** 2, signal: abort.signal });
                bytes += result.bytes;
                if (result.remaining && !result.unchanged && !(result.partial && result.bytes < 2 * 1024 ** 2)) done = false;
              } catch (e) {
                if (stopped) break;
                bytes += e.attemptedBytes ?? 0; degraded = true; passFailed = true;
                const code = modelPerformanceSourceFailure(e);
                const reason = modelPerformanceSourceRecoveryReason(e);
                if (reason !== null) recoveryReasonsForSource.add(reason);
                failuresForSource.add(code); diagnostics.add(code);
              }
            }
            const sourceDigest = store.digest(store.key, 'source-path', files[cursor].logicalPath);
            if (failuresForSource.size) sourceFailures.set(sourceDigest, failuresForSource);
            else sourceFailures.delete(sourceDigest);
            if (recoveryReasonsForSource.size) sourceRecoveryReasons.set(sourceDigest, recoveryReasonsForSource);
            else sourceRecoveryReasons.delete(sourceDigest);
            while (sourceRecoveryReasons.size > 50_000) sourceRecoveryReasons.delete(sourceRecoveryReasons.keys().next().value);
            if (done) cursor++;
          } catch (e) {
            if (stopped) break;
            bytes += e.attemptedBytes ?? 0; cursor++; degraded = true; passFailed = true;
            diagnostics.add('timing_store_failed');
          }
          await yieldTurn();
        }
        if (files && cursor >= files.length) degraded = passFailed;
        const collecting = cursor < files.length;
        if (!stopped && (windowsChanged || lastCollecting !== collecting || Date.now() - lastPublished >= 5_000))
          publish(collecting);
      } catch {
        if (stopped) break;
        degraded = true; passFailed = true;
        diagnostics.add(stage); emitDiagnostics();
        if (!stopped) { try { publish(false); } catch { parentPort.postMessage({ type: 'unavailable', code: 'timing_projection_failed' }); } }
      }
      if (!stopped) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); };
        timer = setTimeout(done, files && cursor < files.length ? 250 : 5000);
        abort.signal.addEventListener('abort', done, { once: true });
      });
    }
  } catch { parentPort.postMessage({ type: 'unavailable', code: stage }); }
  finally {
    try { await compressedReader.close(); }
    catch { diagnostics.add('timing_source_read_failed'); emitDiagnostics(); }
    finally { try { await supplement?.close(); } finally { await store?.close(); parentPort.close(); } }
  }
}
if (!isMainThread && workerData?.modelPerformance === true) void run();
