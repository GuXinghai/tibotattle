import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopXService } from '../desktop-x-service.js';
import { X_DEFAULT_SETTINGS } from '../desktop-x-contract.js';

const partition = '12345678-1234-4234-8234-123456789abc';
const orphan = 'abcdef12-1234-4234-8234-123456789abc';
const flush = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setImmediate(resolve)); };
const savedState = () => ({ version: 2, settings: { ...X_DEFAULT_SETTINGS, refreshMinutes: -1, proxyPort: 10808 }, activePartition: partition, authScope: partition, posts: [], lists: { posts: [], replies: [], reposts: [], media: [] }, notificationBaseline: { posts: { floor: null, seen: [] }, replies: { floor: null, seen: [] } } });

function fixture({ saved = savedState(), registry = { partitions: [], pendingClear: [] }, readFailure = false, pathFailure = false } = {}) {
  const f = { disk: structuredClone(saved), registry: structuredClone(registry), readFailure, pathFailure, writes: 0, loads: 0, events: [], sessions: new Map(), checkpoints: new Map(), windows: [], inspectAuthenticated: false };
  const session = id => {
    if (f.sessions.has(id)) return f.sessions.get(id);
    let values = id === partition || id === orphan ? ['auth_token', 'ct0'].map(name => ({ name, value: 'synthetic', domain: '.x.com', path: '/', secure: true })) : [];
    const current = { clearCalls: 0, setProxy: async () => {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, closeAllConnections: async () => {},
      clearStorageData: async () => { current.clearCalls++; if (f.clearFailure) throw Error('synthetic'); values = []; },
      cookies: { get: async filter => values.filter(c => filter?.domain ? c.domain?.replace(/^\./, '') === filter.domain : filter?.url ? c.url === filter.url : true).map(c => ({ ...c })),
        set: async value => { values = values.filter(c => c.name !== value.name); values.push({ ...value, hostOnly: !value.domain }); }, flushStore: async () => {} } };
    f.sessions.set(id, current); return current;
  };
  f.session = session;
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.id = f.windows.length + 1; this.webContents.setWindowOpenHandler = () => {}; this.webContents.stop = () => {}; f.windows.push(this); }
    setMenu() {} show() {} hide() {} isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; } async loadURL() {}
  }
  const repo = { cacheBytes: 0,
    read: async () => { if (f.readFailure) throw Error('synthetic'); return structuredClone(f.disk); },
    write: async value => { if (f.writeFailure) throw Error('synthetic'); f.writes++; f.disk = structuredClone(value); }, clearCache: async () => { f.disk.posts = []; },
    registerSession: async id => { f.events.push(`register:${id}`); if (!f.registry.partitions.includes(id)) f.registry.partitions.push(id); },
    listSessionCleanup: async () => structuredClone(f.registry),
    queueSessionCleanup: async id => { f.events.push(`queue:${id}`); if (f.queueFailure) throw Object.assign(Error(), { code: 'session_persist_failed' }); if (!f.registry.partitions.includes(id)) f.registry.partitions.push(id); if (!f.registry.pendingClear.includes(id)) f.registry.pendingClear.push(id); },
    completeSessionCleanup: async id => { f.events.push(`complete:${id}`); if (f.completeFailure) throw Object.assign(Error(), { code: 'session_persist_failed' }); f.checkpoints.delete(id); f.registry.partitions = f.registry.partitions.filter(value => value !== id); f.registry.pendingClear = f.registry.pendingClear.filter(value => value !== id); },
    retainSession: async id => { f.events.push(`retain:${id}`); f.registry.pendingClear = f.registry.pendingClear.filter(value => value !== id); },
    getSessionPath: async id => { if (f.pathFailure) throw Object.assign(Error(), { code: 'session_permission_failed' }); return id; },
    checkSessionHealth: async () => ({ cookieDatabasePresent: true, cookieDatabaseBytes: 4096 }),
    readSessionCheckpoint: async id => f.checkpoints.get(id) ?? null, writeSessionCheckpoint: async (id, value) => { f.checkpoints.set(id, value); }
  };
  const runtime = { BrowserWindow: Window, safeStorage: { isEncryptionAvailable: () => true }, session: { fromPath: id => { f.events.push(`open:${id}`); return session(id); } }, powerMonitor: new EventEmitter() };
  const timers = { setTimeout() { return { unref() {} }; }, clearTimeout() {} };
  f.service = createDesktopXService({ runtime, repository: repo, timers, importBridge: { begin: async () => ({ code: 'import_ready', pending: true }), cancel() {}, status: () => ({ code: 'import_ready', pending: true }) }, adapterFactory: () => ({ inspect: async () => { if (f.inspectChallenge) throw Object.assign(Error(), { code: 'challenge' }); return { accountMenu: f.inspectAuthenticated }; }, load: async () => { f.loads++; if (f.load) return f.load(); return { authenticated: true, posts: [], exhausted: true }; }, dispose() {} }) });
  f.repository = repo; return f;
}

test('failed initial read blocks settings, cache, login and logout mutations without overwriting saved state', async () => {
  const f = fixture({ readFailure: true }); const old = structuredClone(f.disk);
  await f.service.ready;
  for (const action of [() => f.service.getSettings(), () => f.service.setSettings({ refreshMinutes: 7 }), () => f.service.clearCache(), () => f.service.beginLogin({ method: 'session' }), () => f.service.logout()]) await assert.rejects(action, { code: 'storage_unavailable' });
  assert.equal(f.writes, 0); assert.deepEqual(f.disk, old); assert.deepEqual(f.events, []); await f.service.dispose();
});

test('logout clears the saved partition even when restoring never created an active context', async () => {
  const f = fixture({ pathFailure: true }); await f.service.ready; await flush();
  assert.equal(f.service.getStatus().error, 'session_permission_failed'); assert.equal(f.service.inspectRuntime().activeWebContentsId, null);
  f.pathFailure = false; await f.service.logout();
  assert.equal(f.session(partition).clearCalls, 1); assert.equal((await f.session(partition).cookies.get({})).length, 0);
  assert.equal(f.disk.activePartition, null); assert.deepEqual(f.registry, { partitions: [], pendingClear: [] }); await f.service.dispose();
});

test('failed logout keeps saved pointer and clear intent until a successful retry', async () => {
  const f = fixture(); await f.service.ready; await flush(); f.clearFailure = true;
  await assert.rejects(f.service.logout(), { code: 'session_clear_failed' });
  assert.equal(f.disk.activePartition, partition); assert.deepEqual(f.registry.pendingClear, [partition]);
  f.clearFailure = false; await f.service.logout();
  assert.equal(f.disk.activePartition, null); assert.deepEqual(f.registry.pendingClear, []); await f.service.dispose();
});

test('startup honors pending logout over the saved active pointer and never restores its authentication', async () => {
  const f = fixture({ registry: { partitions: [partition], pendingClear: [partition] } });
  await f.service.ready; await flush();
  assert.equal(f.session(partition).clearCalls, 1); assert.equal(f.disk.activePartition, null); assert.equal(f.loads, 0); assert.equal(f.service.getStatus().auth, 'disconnected');
  assert.deepEqual(f.registry, { partitions: [], pendingClear: [] }); await f.service.dispose();
});

test('startup reclaims a registered orphan while keeping the active session and cached content', async () => {
  const saved = savedState(); saved.posts = [{ id: '1', author: { name: 'Synthetic', handle: 'thsottiaux' }, createdAt: '2026-10-20T00:00:00.000Z', text: '', complete: true, kind: 'post', media: [] }]; saved.lists.posts = ['1'];
  const f = fixture({ saved, registry: { partitions: [orphan, partition], pendingClear: [] } });
  await f.service.ready; await flush();
  assert.equal(f.session(orphan).clearCalls, 1); assert.equal(f.session(partition).clearCalls, 0);
  assert.deepEqual(f.registry, { partitions: [partition], pendingClear: [] });
  assert.equal((await f.service.listPosts({ tab: 'posts' })).items.length, 1); await f.service.dispose();
});

test('candidate registration precedes opening and cancellation durably cleans that candidate', async () => {
  const f = fixture(); await f.service.ready; await flush();
  await f.service.beginLogin({ method: 'web' }); await flush();
  const opened = f.events.filter(event => event.startsWith('open:')).map(event => event.slice(5)); const candidate = opened.find(id => id !== partition);
  assert.ok(candidate); assert.ok(f.events.indexOf(`register:${candidate}`) < f.events.indexOf(`open:${candidate}`));
  f.service.cancelLogin(); await flush();
  assert.equal(f.session(candidate).clearCalls, 1); assert.deepEqual(f.registry, { partitions: [partition], pendingClear: [] });
  assert.equal(f.disk.activePartition, partition); await f.service.dispose();
});

test('candidate cleanup failure remains visible and shutdown does not swallow its receipt', async () => {
  const f = fixture(); await f.service.ready; await flush();
  await f.service.beginLogin({ method: 'web' }); await flush(); f.clearFailure = true;
  f.service.cancelLogin(); await flush();
  assert.equal(f.service.getStatus().error, 'session_clear_failed'); assert.equal(f.registry.pendingClear.length, 1);
  await assert.rejects(f.service.dispose(), { code: 'session_clear_failed' });
  assert.equal(f.registry.pendingClear.length, 1);
});

test('failed null-pointer persistence leaves explicit cleanup intent and prevents false logout success', async () => {
  const f = fixture(); await f.service.ready; await flush(); f.writeFailure = true;
  await assert.rejects(f.service.logout(), { code: 'session_persist_failed' });
  assert.equal(f.disk.activePartition, partition); assert.deepEqual(f.registry.pendingClear, [partition]);
  assert.equal(f.events.includes(`complete:${partition}`), false); f.writeFailure = false;
  await f.service.logout(); assert.equal(f.disk.activePartition, null); await f.service.dispose();
});

const importedCookies = () => ['auth_token', 'ct0'].map(name => ({ url: 'https://x.com/', domain: '.x.com', name, value: 'synthetic', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'no_restriction' }));

test('cancellation waits for an in-flight checkpoint before final cleanup acknowledgement', async () => {
  const f = fixture(); await f.service.ready; await flush(); f.inspectAuthenticated = true;
  let release; let candidate;
  const checkpoint = f.repository.writeSessionCheckpoint;
  f.repository.writeSessionCheckpoint = async (id, value) => { if (id !== partition) { candidate = id; await new Promise(resolve => { release = resolve; }); } return checkpoint(id, value); };
  await f.service.beginLogin({ method: 'session' }); await f.service.importCookies(importedCookies(), { isCurrent: () => true }); await flush();
  assert.equal(typeof release, 'function'); f.service.cancelLogin(); await flush();
  assert.ok(f.registry.pendingClear.includes(candidate)); assert.equal(f.events.includes(`complete:${candidate}`), false);
  release(); await flush();
  assert.equal(f.checkpoints.has(candidate), false); assert.equal((await f.session(candidate).cookies.get({})).length, 0);
  assert.deepEqual(f.registry, { partitions: [partition], pendingClear: [] }); await f.service.dispose();
});

test('logout waits for a cancelled promotion pointer write and its rollback before committing logout', async () => {
  const f = fixture(); await f.service.ready; await flush(); f.inspectAuthenticated = true;
  let release; const write = f.repository.write;
  f.repository.write = async value => { if (value.activePartition && value.activePartition !== partition) await new Promise(resolve => { release = resolve; }); return write(value); };
  await f.service.beginLogin({ method: 'session' }); await f.service.importCookies(importedCookies(), { isCurrent: () => true }); await flush();
  assert.equal(typeof release, 'function'); const logout = f.service.logout(); await flush(); release(); await logout; await flush();
  assert.equal(f.disk.activePartition, null); assert.equal(f.service.getStatus().auth, 'disconnected'); assert.deepEqual(f.registry, { partitions: [], pendingClear: [] }); await f.service.dispose();
});

test('opening the existing candidate challenge does not mistake its registry entry for an orphan', async () => {
  const f = fixture(); await f.service.ready; await flush(); f.inspectChallenge = true;
  await f.service.beginLogin({ method: 'web' }); await flush();
  const id = f.registry.partitions.find(id => id !== partition); assert.ok(id); assert.equal(f.service.getStatus().auth, 'challenge');
  const count = f.windows.length; const candidateWindow = f.windows.at(-1);
  await f.service.beginLogin({ method: 'web' });
  assert.equal(f.windows.length, count); assert.equal(candidateWindow.isDestroyed(), false); assert.equal(f.session(id).clearCalls, 0);
  f.service.cancelLogin(); await flush(); await f.service.dispose();
});
