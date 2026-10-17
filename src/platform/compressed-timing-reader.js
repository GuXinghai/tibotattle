import { resolve } from 'node:path';
import { readCompressedRolloutBytes, compressedRolloutHandle } from './bounded-rollout-bytes.js';
import { createTimingFilesystem } from './inference-timing-filesystem.js';

const WINDOW_BYTES = 32 * 1024 * 1024 + 8192;
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].every(k => a[k] === b[k]);
const failure = code => Object.assign(new Error(code), { code });
export const timingLogicalSourcePath = path => resolve(path.endsWith('.jsonl.zst') ? path.slice(0, -4) : path);

// One active physical stream, shared by the primary/supplement consumers. Only
// bounded bytes are retained in memory; no decoded transcript is written out.
// Persisted parser cursors survive restart, while the decoder itself is rebuilt
// once and advanced to that cursor under the ordinary slice budget.
export function createCompressedTimingReader({ filesystem = createTimingFilesystem() } = {}) {
  if (typeof filesystem?.openSource !== 'function') throw new TypeError('Timing filesystem is required');
  let active = null, closed = false;
  const consumers = new Map();
  const stats = { starts: 0, decodedBytes: 0 };
  async function release(session) {
    if (!session) return;
    session.abort.abort();
    try { await session.iterator.return(); } finally { await session.handle.close(); }
  }
  async function open(path, physical, positions = new Map([...consumers].map(([key, value]) => [key, value?.path === path ? value.cursor : 0]))) {
    const handle = await filesystem.openSource(path);
    try {
      if (!same(physical, await handle.stat())) throw failure('source_changed');
      const abort = new AbortController();
      const iterator = readCompressedRolloutBytes(compressedRolloutHandle(handle), {
        highWaterMark: 64 * 1024, signal: abort.signal,
      })[Symbol.asyncIterator]();
      stats.starts++;
      return { path, physical, consumers: positions, handle, abort, iterator, parts: [],
        first: Buffer.alloc(0), offset: 0, windowStart: 0, done: false };
    } catch (error) { await handle.close(); throw error; }
  }
  function trim(session) {
    // Keep the final window until the other consumer can read a small file's
    // final batch, even if it has not registered before the first EOF.
    if (session.done) return;
    const floor = Math.max(0, Math.min(...session.consumers.values()) - 4096);
    while (session.parts.length && session.parts[0].end <= floor) {
      session.windowStart = session.parts.shift().end;
    }
  }
  function range(session, start, end) {
    if (end === start) return Buffer.alloc(0);
    if (start < session.windowStart || end > session.offset) throw failure('source_changed');
    const parts = [];
    for (const p of session.parts) if (p.end > start && p.start < end) {
      parts.push(p.bytes.subarray(Math.max(0, start - p.start), Math.min(p.bytes.length, end - p.start)));
    }
    const result = Buffer.concat(parts, end - start);
    if (parts.reduce((n, p) => n + p.length, 0) !== end - start) throw failure('source_changed');
    return result;
  }
  return {
    register(consumer) {
      if (typeof consumer !== 'string' || !consumer.length || consumer.length > 4096) throw new TypeError('Invalid timing consumer');
      if (!consumers.has(consumer) && consumers.size >= 2) throw failure('timing_consumer_limit');
      if (!consumers.has(consumer)) consumers.set(consumer, null);
    },
    checkpoint(path, consumer, cursor) {
      consumers.set(consumer, { path, cursor });
      if (active?.path === path) active.consumers.set(consumer, cursor);
    },
    stats: () => ({ ...stats }),
    async slice({ path, physical, start, maxBytes, consumer, signal }) {
      if (closed) throw failure('timing_reader_closed');
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(maxBytes)
          || maxBytes < 1 || maxBytes > 16 * 1024 * 1024 || !Number.isSafeInteger(start + maxBytes)
          || !consumers.has(consumer)) throw new TypeError('Invalid compressed timing slice');
      signal?.throwIfAborted();
      if (!active || active.path !== path || !same(active.physical, physical)) {
        const old = active; active = null; await release(old);
        active = await open(path, physical);
      }
      active.consumers.set(consumer, start);
      if (start < active.windowStart) {
        const old = active; active = null;
        const consumers = old.consumers; await release(old);
        active = await open(path, physical, consumers);
      }
      const session = active, end = start + maxBytes;
      let readBytes = 0;
      const abort = () => session.abort.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        while (!session.done && session.offset < end && readBytes < maxBytes) {
          signal?.throwIfAborted(); trim(session);
          const floor = Math.min(...session.consumers.values());
          if (session.offset - Math.min(floor, session.offset) >= WINDOW_BYTES - 64 * 1024) break;
          const next = await session.iterator.next();
          if (next.done) { session.done = true; break; }
          const bytes = Buffer.from(next.value);
          if (session.first.length < 4096) session.first = Buffer.concat([
            session.first, bytes.subarray(0, 4096 - session.first.length),
          ]);
          session.parts.push({ start: session.offset, end: session.offset + bytes.length, bytes });
          session.offset += bytes.length; readBytes += bytes.length; stats.decodedBytes += bytes.length;
        }
        signal?.throwIfAborted();
        if (session.done && start > session.offset) throw failure('source_changed');
        if (!session.done && session.offset < end) return { ready: false, readBytes };
        const limit = Math.min(end, session.offset);
        return { ready: true, readBytes, bytes: range(session, start, limit), start, end: limit,
          exhausted: session.done && limit === session.offset,
          logicalSize: session.done ? session.offset : null,
          fingerprint(offset, key, digest) {
            return digest(key, 'prefix-tail', Buffer.concat([
              session.first.subarray(0, Math.min(offset, 4096)), range(session, Math.max(0, offset - 4096), offset),
            ]));
          },
        };
      } catch (error) {
        active = null;
        try { await release(session); } catch { /* Preserve the read/cancellation failure. */ }
        throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    },
    commit(path, consumer, cursor) {
      consumers.set(consumer, { path, cursor });
      if (active?.path !== path) return;
      active.consumers.set(consumer, cursor); trim(active);
    },
    detach(consumer) { consumers.delete(consumer); active?.consumers.delete(consumer); if (active?.consumers.size) trim(active); },
    async close() { closed = true; const old = active; active = null; await release(old); },
  };
}
