import { createHash, randomUUID } from 'node:crypto';
import { isWindowsProtectedStateStore, isWindowsProtectedStateStoreError, isWindowsBrowserProfileStore, isWindowsBrowserProfileStoreError } from '../../src/platform/index.js';
import { X_DEFAULT_SETTINGS, X_TABS, validateXId, validateXPost, validateXSettings, validateXNotificationBaseline, xError } from './desktop-x-contract.js';

const POINTER = 'x-reader-v1.json';
const JOURNAL = 'x-reader-pending-v1.json';
const SESSION_CLEANUP = 'x-session-registry-v1.json';
const MAX_PENDING_SESSIONS = 64;
const CHUNK_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => { throw xError('invalid_x_state'); };
const clone = value => structuredClone(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function sessionId(value) { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function checkpoint(value) {
  if (!exact(value, ['version', 'digest']) || value.version !== 1 || typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) invalid();
  return { version: 1, digest: value.digest };
}
const checkpointName = id => `x-session-checkpoint-${sessionId(id)}.json`;
function profileError(error) {
  if (!isWindowsBrowserProfileStoreError(error)) return xError('session_permission_failed');
  if (['windows_browser_profile_bound_exceeded', 'windows_browser_profile_cache_cleanup_pending'].includes(error.code)) return xError('session_profile_limit');
  if (error.code === 'windows_browser_profile_write_failed') return xError('session_write_failed');
  return xError(error.code === 'windows_browser_profile_read_failed' ? 'session_read_failed' : 'session_permission_failed');
}
function ids(value) {
  if (!Array.isArray(value)) invalid();
  const found = new Set();
  return value.map(id => { validateXId(id); if (found.has(id)) invalid(); found.add(id); return id; });
}
function emptySnapshot() {
  return { version: 3, settings: { ...X_DEFAULT_SETTINGS }, activePartition: null, authScope: null, posts: [], lists: Object.fromEntries(X_TABS.map(tab => [tab, []])), replyLists: {}, notificationBaseline: { posts: { floor: null, seen: [] }, replies: { floor: null, seen: [] } } };
}
function snapshot(value) {
  if (!exact(value, ['version', 'settings', 'activePartition', 'authScope', 'posts', 'lists', ...(value?.version === 3 ? ['replyLists'] : []), 'notificationBaseline']) || ![1, 2, 3].includes(value.version) || !Array.isArray(value.posts) || !exact(value.lists, X_TABS) || !exact(value.notificationBaseline, ['posts', 'replies'])) invalid();
  const posts = value.posts.map(post => validateXPost(post));
  const postIds = new Set(posts.map(post => post.id));
  if (posts.length !== postIds.size) invalid();
  const lists = Object.fromEntries(X_TABS.map(tab => [tab, ids(value.lists[tab])]));
  if (Object.values(lists).some(list => list.some(id => !postIds.has(id)))) invalid();
  const replyLists = {};
  if (value.version === 3) {
    if (!plain(value.replyLists)) invalid();
    const byId = new Map(posts.map(post => [post.id, post]));
    for (const [parent, replies] of Object.entries(value.replyLists)) {
      validateXId(parent); if (!postIds.has(parent)) invalid();
      const ordered = ids(replies);
      if (ordered.some(id => byId.get(id)?.replyTo !== parent)) invalid();
      replyLists[parent] = ordered;
    }
  }
  return { version: 3, settings: validateXSettings(value.settings), activePartition: value.activePartition === null ? null : sessionId(value.activePartition), authScope: value.authScope === null ? null : sessionId(value.authScope), posts, lists, replyLists, notificationBaseline: validateXNotificationBaseline(value.notificationBaseline, Math.min(value.version, 2)) };
}
function envelope(value) {
  if (!exact(value, ['version', 'current', 'archives']) || ![1, 2, 3].includes(value.version) || !Array.isArray(value.archives)) invalid();
  return { version: 3, current: snapshot(value.current), archives: value.archives.map(snapshot) };
}
function descriptor(value) {
  if (!exact(value, ['version', 'generation', 'chunks', 'bytes', 'sha256']) || value.version !== 1 || !UUID.test(value.generation) || !Number.isSafeInteger(value.chunks) || value.chunks < 1 || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.chunks !== Math.ceil(value.bytes / CHUNK_BYTES) || !/^[0-9a-f]{64}$/.test(value.sha256)) invalid();
  return value;
}
const chunkName = (record, index) => `x-cache-${record.generation}-${index}.bin`;
function cleanupRecord(value) {
  if (!exact(value, ['version', 'partitions', 'pendingClear']) || value.version !== 1 || !Array.isArray(value.partitions) || value.partitions.length > MAX_PENDING_SESSIONS || !Array.isArray(value.pendingClear)) invalid();
  const partitions = value.partitions.map(sessionId);
  const pendingClear = value.pendingClear.map(sessionId);
  if (new Set(partitions).size !== partitions.length || new Set(pendingClear).size !== pendingClear.length || pendingClear.some(id => !partitions.includes(id))) invalid();
  return { version: 1, partitions, pendingClear };
}
const publicCache = value => JSON.stringify({ posts: value.posts, lists: value.lists, replyLists: value.replyLists });

/** Storage-neutral logic; production composition must use the branded factory below. */
export function createXRepository({ storage, sessionPath, sessionHealth = async () => {} }) {
  if (!storage || typeof sessionPath !== 'function') invalid();
  let cacheBytes = 0;
  let tail = Promise.resolve();
  const enqueue = action => { const result = tail.then(action); tail = result.catch(() => {}); return result; };
  const pointer = async () => { const value = await storage.readJson(POINTER); return value === null ? null : descriptor(value); };
  const measure = value => { cacheBytes = [value.current, ...value.archives].reduce((sum, item) => sum + (item.posts.length ? Buffer.byteLength(JSON.stringify({ posts: item.posts, lists: item.lists, replyLists: item.replyLists })) : 0), 0); };
  const exclusive = action => storage.withLease ? storage.withLease(action) : action();
  async function pendingSessions() {
    try { const value = await storage.readJson(SESSION_CLEANUP); return value === null ? { version: 1, partitions: [], pendingClear: [] } : cleanupRecord(value); }
    catch { throw xError('session_read_failed'); }
  }
  async function savePendingSessions(value) {
    try {
      const safe = cleanupRecord(value);
      await storage.writeJson(SESSION_CLEANUP, safe);
      const saved = cleanupRecord(await storage.readJson(SESSION_CLEANUP));
      if (JSON.stringify(saved) !== JSON.stringify(safe)) invalid();
    } catch { throw xError('session_persist_failed'); }
  }
  function acknowledgeSession(id, cleared) {
    const selected = sessionId(id);
    return enqueue(() => exclusive(async () => {
      const pending = await pendingSessions();
      if (cleared) {
        // Only the session owner calls this after clearing and verifying cookies.
        // Keep the receipt if checkpoint deletion or acknowledgement fails.
        try { const name = checkpointName(selected); await storage.remove(name); if (await storage.readJson(name) !== null) throw xError('session_clear_failed'); }
        catch { throw xError('session_clear_failed'); }
      }
      if (cleared ? pending.partitions.includes(selected) : pending.pendingClear.includes(selected)) await savePendingSessions({ version: 1, partitions: cleared ? pending.partitions.filter(id => id !== selected) : pending.partitions, pendingClear: pending.pendingClear.filter(id => id !== selected) });
    }));
  }
  function registerSession(id, clear) {
    const selected = sessionId(id);
    return enqueue(() => exclusive(async () => {
      const pending = await pendingSessions();
      const registered = pending.partitions.includes(selected);
      if (!registered && pending.partitions.length >= MAX_PENDING_SESSIONS) throw xError('session_persist_failed');
      if (registered && (!clear || pending.pendingClear.includes(selected))) return;
      await savePendingSessions({ version: 1, partitions: registered ? pending.partitions : [...pending.partitions, selected], pendingClear: clear && !pending.pendingClear.includes(selected) ? [...pending.pendingClear, selected] : pending.pendingClear });
    }));
  }
  async function loadEnvelope() {
    for (let attempt = 0; attempt < 2; attempt++) {
      const selected = await pointer();
      if (selected === null) { const value = { version: 3, current: emptySnapshot(), archives: [] }; measure(value); return value; }
      try {
        const chunks = [];
        for (let index = 0; index < selected.chunks; index++) {
          const bytes = await storage.read(chunkName(selected, index));
          const expected = index === selected.chunks - 1 ? selected.bytes - index * CHUNK_BYTES : CHUNK_BYTES;
          if (!Buffer.isBuffer(bytes) || bytes.length !== expected) invalid();
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks, selected.bytes);
        if (digest(bytes) !== selected.sha256) invalid();
        const value = envelope(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        measure(value); return value;
      } catch (error) {
        // An atomic publication may retire the generation read above. Only retry
        // if the committed pointer actually changed; corruption never means empty.
        const latest = await pointer();
        if (attempt === 0 && latest?.generation !== selected.generation) continue;
        if (error?.code === 'invalid_x_state') throw error;
        throw xError('invalid_x_state');
      }
    }
    invalid();
  }
  async function load() { return (await loadEnvelope()).current; }
  async function recover() {
    const pending = await storage.readJson(JOURNAL);
    if (pending === null) return;
    if (!exact(pending, ['version', 'generations']) || pending.version !== 1 || !Array.isArray(pending.generations) || pending.generations.length > 2) invalid();
    const generations = pending.generations.map(descriptor);
    const selected = await pointer();
    for (const item of generations) {
      if (item.generation === selected?.generation) continue;
      for (let index = 0; index < item.chunks; index++) await storage.remove(chunkName(item, index));
    }
    await storage.remove(JOURNAL);
  }
  async function commit(input, preservePosts, clearArchives = false) {
    await recover();
    const durable = await loadEnvelope();
    const old = durable.current;
    const value = snapshot(input);
    if (preservePosts && value.authScope === old.authScope) {
      const merged = new Map(old.posts.map(post => [post.id, post]));
      for (const post of value.posts) merged.set(post.id, post);
      value.posts = [...merged.values()];
    }
    if (preservePosts && value.authScope !== old.authScope && (old.authScope !== null || old.posts.length > 0)) {
      // Logout deliberately leaves a readable cache. It already belongs to the
      // authenticated archive; logging in again must not archive a second copy.
      const duplicateLogoutCache = old.authScope === null && durable.archives.some(archived => publicCache(archived) === publicCache(old));
      if (!duplicateLogoutCache) durable.archives.push(old);
    }
    if (clearArchives) {
      for (const archived of durable.archives) { archived.posts = []; archived.lists = Object.fromEntries(X_TABS.map(tab => [tab, []])); archived.replyLists = {}; }
    }
    durable.current = value;
    const previous = await pointer();
    const bytes = Buffer.from(JSON.stringify(durable));
    const next = { version: 1, generation: randomUUID(), chunks: Math.ceil(bytes.length / CHUNK_BYTES), bytes: bytes.length, sha256: digest(bytes) };
    // The journal precedes every new chunk. After interruption it identifies
    // only our exact abandoned records; no directory enumeration or broad delete.
    await storage.writeJson(JOURNAL, { version: 1, generations: previous ? [previous, next] : [next] });
    for (let index = 0; index < next.chunks; index++) await storage.create(chunkName(next, index), bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
    await storage.writeJson(POINTER, next);
    measure(durable);
    await recover();
    return clone(value);
  }
  return Object.freeze({
    read: () => enqueue(load),
    write: value => { const safe = snapshot(value); return enqueue(() => exclusive(() => commit(safe, true))); },
    clearCache: () => enqueue(() => exclusive(async () => { const value = await load(); value.posts = []; value.lists = Object.fromEntries(X_TABS.map(tab => [tab, []])); value.replyLists = {}; return commit(value, false, true); })),
    getSessionPath: async id => sessionPath(sessionId(id)),
    checkSessionHealth: async id => sessionHealth(sessionId(id)),
    listSessionCleanup: () => enqueue(async () => { const { partitions, pendingClear } = await pendingSessions(); return clone({ partitions, pendingClear }); }),
    registerSession: id => registerSession(id, false),
    queueSessionCleanup: id => registerSession(id, true),
    completeSessionCleanup: id => acknowledgeSession(id, true),
    retainSession: id => acknowledgeSession(id, false),
    readSessionCheckpoint: id => {
      const name = checkpointName(id);
      return enqueue(async () => {
        try { const value = await storage.readJson(name); return value === null ? null : checkpoint(value); }
        catch { throw xError('session_read_failed'); }
      });
    },
    writeSessionCheckpoint: (id, value) => {
      const name = checkpointName(id); const safe = checkpoint(value);
      return enqueue(() => exclusive(async () => {
        try {
          await storage.writeJson(name, safe);
          const saved = checkpoint(await storage.readJson(name));
          if (saved.digest !== safe.digest) throw xError('session_persist_failed');
        } catch { throw xError('session_persist_failed'); }
      }));
    },
    get cacheBytes() { return cacheBytes; },
  });
}

export function createDesktopXRepository({ store, createSessionStore }) {
  if (!isWindowsProtectedStateStore(store) || store.maxBytes < CHUNK_BYTES || typeof createSessionStore !== 'function') invalid();
  const missing = error => isWindowsProtectedStateStoreError(error) && error.code === 'windows_protected_state_store_missing';
  async function record(name) { try { return await store.read(name); } catch (error) { if (missing(error)) return null; throw error; } }
  return createXRepository({
    storage: {
      withLease: action => store.withOperationLease('x-state-operation.lock', action),
      async readJson(name) { const found = await record(name); if (!found) return null; if (found.data.length > (name === SESSION_CLEANUP ? 8192 : 4096)) invalid(); return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(found.data)); },
      async writeJson(name, value) { if (Buffer.byteLength(JSON.stringify(value)) > (name === SESSION_CLEANUP ? 8192 : 4096)) invalid(); const found = await record(name); if (found) await store.replaceJson(name, found.identity, value); else await store.createJson(name, value); },
      async create(name, bytes) { await store.create(name, bytes); },
      async read(name) { const found = await record(name); if (!found) invalid(); return found.data; },
      async remove(name) { const found = await record(name); if (found) await store.delete(name, found.identity); },
    },
    async sessionPath(id) {
      const selected = await createSessionStore(id);
      if (!isWindowsBrowserProfileStore(selected)) invalid();
      try { await selected.ensureReady(); } catch (error) { throw profileError(error); }
      return selected.rootPath;
    },
    async sessionHealth(id) {
      const selected = await createSessionStore(id);
      if (!isWindowsBrowserProfileStore(selected)) invalid();
      try { return await selected.inspectHealth(); } catch (error) { throw profileError(error); }
    },
  });
}
