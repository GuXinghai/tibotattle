import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopXService } from '../desktop-x-service.js';
import { X_DEFAULT_SETTINGS } from '../desktop-x-contract.js';

const partition = '26d7264f-3422-4a24-985e-940ef42782ac';
const scope = 'b8ea1e27-7bcf-4b38-bd10-2fbde8bf6e74';
const post = (id = '123', kind = 'post') => ({ id, author: { name: 'Example', handle: 'thsottiaux', avatar: 'https://pbs.twimg.com/profile_images/example.jpg' }, createdAt: '2026-10-19T14:59:00.000Z', text: 'Synthetic public post', complete: true, kind, media: [{ id: '0', type: 'video', url: 'https://video.twimg.com/master.m3u8', mimeType: 'application/x-mpegURL' }] });
const initial = (extra = {}) => ({ version: 1, settings: { ...X_DEFAULT_SETTINGS }, activePartition: partition, authScope: scope, posts: [], lists: { posts: [], replies: [], reposts: [], media: [] }, notificationBaseline: { posts: [], replies: [] }, ...extra });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(saved = initial(), overrides = {}) {
  let disk = structuredClone(saved); let time = 1000000; const scheduled = new Map(); let sequence = 0; const windows = []; const notifications = []; const loads = []; let adapterLoad = async () => ({ authenticated: true, posts: [post()], exhausted: true });
  function makeSession(existing = false) {
    const cookies = existing ? ['auth_token', 'ct0'].map(name => ({ name, value: 'synthetic', domain: '.x.com', path: '/', secure: true })) : [];
    return { setProxy: async () => {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, closeAllConnections: async () => {}, clearStorageData: async () => { cookies.length = 0; }, cookies: { set: async value => { const index = cookies.findIndex(cookie => cookie.name === value.name && cookie.domain === value.domain); const cookie = { ...value, hostOnly: !value.domain }; if (index < 0) cookies.push(cookie); else cookies[index] = cookie; }, get: async filter => cookies.filter(cookie => filter?.domain ? cookie.domain?.replace(/^\./, '') === filter.domain : filter?.url ? cookie.url === filter.url : true).map(cookie => ({ ...cookie })), flushStore: async () => {} }, fetch: async () => new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }) };
  }
  const session = makeSession(true); const sessions = new Map([[`C:\\synthetic\\${partition}`, session]]); const checkpoints = new Map();
  class Window extends EventEmitter { constructor() { super(); this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.stop = () => {}; this.webContents.id = windows.length + 1; windows.push(this); } setMenu() {} hide() {} show() {} isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; } async loadURL() {} }
  const runtime = { BrowserWindow: Window, safeStorage: { isEncryptionAvailable: () => true }, session: { fromPath: path => { if (!sessions.has(path)) sessions.set(path, makeSession()); return sessions.get(path); } }, powerMonitor: new EventEmitter() };
  const repository = { read: async () => disk, write: async value => { disk = structuredClone(value); }, clearCache: async () => { disk.posts = []; disk.lists = { posts: [], replies: [], reposts: [], media: [] }; }, getSessionPath: async id => `C:\\synthetic\\${id}`, checkSessionHealth: async () => ({ cookieDatabasePresent: true, cookieDatabaseBytes: 20480 }), readSessionCheckpoint: async id => checkpoints.get(id) ?? null, writeSessionCheckpoint: async (id, proof) => { checkpoints.set(id, structuredClone(proof)); }, cacheBytes: 0 };
  const timers = { setTimeout(callback, ms) { const id = ++sequence; scheduled.set(id, { callback, ms }); return id; }, clearTimeout(id) { scheduled.delete(id); } };
  const bridge = { begin: async () => ({ extensionDirectory: 'C:\\synthetic-extension' }), cancel() {}, status: () => ({ connectionStatus: 'ready' }) };
  const service = createDesktopXService({ runtime, repository, clock: () => time, timers, allowedOrigin: () => 'http://127.0.0.1:12345', importBridge: bridge, notify: value => notifications.push(value), adapterFactory: () => ({ load: async args => { loads.push(args); return adapterLoad(args); }, inspect: async () => ({ accountMenu: true }), dispose() {} }), ...overrides });
  return { service, runtime, session, repository, scheduled, notifications, loads, windows, disk: () => disk, setLoad: fn => { adapterLoad = fn; }, advance: delta => { time += delta; } };
}

test('saved cookies missing locally blocks remote restore without expiring or deleting cached posts', async () => {
  const f = fixture(initial({ posts: [post()], lists: { posts: ['123'], replies: [], reposts: [], media: [] } }));
  f.session.cookies.get = async () => [];
  await f.service.ready; await flush();
  assert.equal(f.loads.length, 0); assert.equal(f.service.getStatus().error, 'session_restore_failed'); assert.equal(f.service.getStatus().operation, 'error');
  assert.notEqual(f.service.getStatus().auth, 'expired'); assert.equal(f.disk().activePartition, partition);
  assert.equal((await f.service.listPosts({ tab: 'posts' })).items.length, 1);
  await f.service.dispose();
});

test('failed candidate cookie flush cannot publish or replace an existing active session', async () => {
  const f = fixture(); await f.service.ready; await flush();
  const fromPath = f.runtime.session.fromPath;
  f.runtime.session.fromPath = path => { const session = fromPath(path); if (!path.endsWith(partition)) session.cookies.flushStore = async () => { throw new Error('private'); }; return session; };
  await f.service.beginLogin({ method: 'session' });
  const cookie = name => ({ url: 'https://x.com/', domain: '.x.com', name, value: 'synthetic', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'no_restriction' });
  await f.service.importCookies([cookie('auth_token'), cookie('ct0')], { isCurrent: () => true }); await flush();
  assert.equal(f.disk().activePartition, partition); assert.equal(f.disk().authScope, scope);
  assert.equal(f.service.getStatus().error, 'session_persist_failed'); assert.equal(f.service.getStatus().operation, 'error');
  await f.service.dispose();
});

test('local session error is sticky across settings/cache success, and clears only after healthy retry', async () => {
  const f = fixture(); await f.service.ready; await flush(); const flushStore = f.session.cookies.flushStore;
  f.session.cookies.flushStore = async () => { throw new Error('private'); }; await f.service.refresh();
  assert.equal(f.service.getStatus().error, 'session_persist_failed'); assert.equal(f.scheduled.size, 0);
  f.session.cookies.flushStore = flushStore; await f.service.setSettings({ refreshMinutes: 7 }); await f.service.clearCache();
  assert.equal(f.service.getStatus().error, 'session_persist_failed'); assert.equal(f.service.getStatus().operation, 'error');
  await f.service.refresh(); assert.equal(f.service.getStatus().error, null); assert.equal(f.service.getStatus().operation, 'idle');
  await f.service.dispose();
});

test('cookie flush at shutdown is awaited and rejected with an observable fixed error', async () => {
  const f = fixture(); await f.service.ready; await flush(); f.session.cookies.flushStore = async () => { throw new Error('private'); };
  await assert.rejects(f.service.dispose(), { code: 'session_persist_failed', message: 'session_persist_failed' });
  assert.equal(f.service.getStatus().error, 'session_persist_failed');
});

test('cancellation during candidate checkpoint cannot publish the late session', async () => {
  const f = fixture(); await f.service.ready; await flush();
  let release; const writeCheckpoint = f.repository.writeSessionCheckpoint;
  f.repository.writeSessionCheckpoint = async (id, proof) => { if (id !== partition) await new Promise(resolve => { release = resolve; }); return writeCheckpoint(id, proof); };
  await f.service.beginLogin({ method: 'session' });
  const cookie = name => ({ url: 'https://x.com/', domain: '.x.com', name, value: 'synthetic', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'no_restriction' });
  await f.service.importCookies([cookie('auth_token'), cookie('ct0')], { isCurrent: () => true }); await flush(); assert.equal(typeof release, 'function');
  f.service.cancelLogin(); release(); await flush();
  assert.equal(f.disk().activePartition, partition); assert.equal(f.disk().authScope, scope); assert.equal(f.service.getStatus().auth, 'ready'); assert.equal(f.service.getStatus().error, null);
  await f.service.dispose();
});

test('local cookie read rejection and explicit decryption failure stay distinct before remote requests', async () => {
  for (const code of ['session_read_failed', 'session_decrypt_failed']) {
    const f = fixture(); f.session.cookies.get = async () => { throw Object.assign(new Error('private'), { code }); };
    await f.service.ready; await flush(); assert.equal(f.loads.length, 0); assert.equal(f.service.getStatus().error, code); assert.notEqual(f.service.getStatus().auth, 'expired'); await f.service.dispose();
  }
});
test('X hydration exposes cached rows before slow restoration; controls do not await X', async () => {
  const f = fixture(initial({ posts: [post()], lists: { posts: ['123'], replies: [], reposts: [], media: [] } }));
  let resolve; f.setLoad(() => new Promise(done => { resolve = done; }));
  await f.service.ready; const rows = await f.service.listPosts({ tab: 'posts' }); assert.equal(rows.items.length, 1); assert.equal(rows.source, 'cache'); assert.equal(f.service.getStatus().auth, 'restoring');
  assert.match(rows.items[0].media[0].src, /^tibotattle-x-media:\/\/resource\//); assert.equal(JSON.stringify(rows).includes('video.twimg.com'), false);
  await flush(); resolve({ authenticated: true, posts: [post()], exhausted: true }); await flush(); await f.service.dispose();
});
test('X baseline avoids historical notifications, deduplicates rounds, disables cadence, and retains manual refresh', async () => {
  const f = fixture(initial({ settings: { ...X_DEFAULT_SETTINGS, notifyPosts: true } })); await f.service.ready; await flush(); assert.equal(f.notifications.length, 0);
  f.setLoad(async () => ({ authenticated: true, posts: [post('124'), post('124')], exhausted: true }));
  await f.service.refresh(); assert.deepEqual(f.notifications, [{ posts: 1, replies: 0, latestId: '124' }]); await f.service.refresh(); assert.equal(f.notifications.length, 1);
  f.setLoad(async () => ({ authenticated: true, posts: [post('100')], exhausted: true })); await f.service.refresh(); assert.equal(f.notifications.length, 1, 'older newly discovered history must not notify');
  await f.service.setSettings({ refreshMinutes: -1 }); assert.equal(f.scheduled.size, 0); const before = f.loads.length; await f.service.refresh(); assert.ok(f.loads.length > before); assert.equal(f.scheduled.size, 0);
  await f.service.dispose();
});
test('X rate limit does not expire login, and stale fetch cannot overwrite logout', async () => {
  const f = fixture(); await f.service.ready; await flush();
  f.setLoad(async () => { throw Object.assign(new Error('synthetic'), { code: 'rate_limited', retryAt: 9000000 }); }); await f.service.refresh(); assert.equal(f.service.getStatus().auth, 'ready'); assert.equal(f.service.getStatus().operation, 'rate_limited'); assert.equal(Date.parse(f.service.getStatus().nextRefreshAt), 9000000);
  let resolve; f.setLoad(() => new Promise(done => { resolve = done; })); const fetching = f.service.refresh(); await flush(); await f.service.logout(); resolve({ authenticated: true, posts: [post('999')], exhausted: true }); await fetching;
  assert.equal(f.service.getStatus().auth, 'disconnected'); assert.equal(f.disk().activePartition, null); assert.equal(f.disk().posts.some(item => item.id === '999'), false); await f.service.dispose();
});

test('successful detail cache is revalidated on opening after one minute; failures remain retryable', async () => {
  const f=fixture();await f.service.ready;await flush();let count=0;
  f.setLoad(async()=>{count++;return {authenticated:true,posts:[post()],exhausted:true};});
  assert.equal((await f.service.getPost({id:'123'})).source,'live');assert.equal(count,1);
  await f.service.getPost({id:'123'});assert.equal(count,1);
  f.advance(60000);f.setLoad(async()=>{count++;throw Object.assign(new Error('Synthetic'),{code:'offline'});});
  const failed=await f.service.getPost({id:'123'});assert.equal(failed.source,'cache');assert.equal(failed.status.operation,'offline');assert.equal(count,2);
  f.setLoad(async()=>{count++;return {authenticated:true,posts:[post(),{...post('124','reply'),replyTo:'123'}],exhausted:true};});
  const retried=await f.service.getPost({id:'123'});assert.equal(retried.replies.length,1);assert.equal(retried.source,'live');assert.equal(count,3);await f.service.dispose();
});
test('X import cancellation does not replace a working session; successful isolated import establishes fresh baseline', async () => {
  const f = fixture(); await f.service.ready; await flush();
  await f.service.beginLogin({ method: 'session' }); f.service.cancelLogin(); assert.equal(f.disk().activePartition, partition); assert.equal(f.service.getStatus().auth, 'ready');
  await f.service.beginLogin({ method: 'session' });
  const value = name => ({ url: 'https://x.com/', domain: '.x.com', name, value: 'synthetic', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'no_restriction' });
  const delivered = await f.service.importCookies([value('auth_token'), value('ct0')], { isCurrent: () => true }); assert.equal(delivered.code, 'verification_pending'); await flush(); assert.equal(f.service.getStatus().auth, 'ready'); assert.notEqual(f.disk().activePartition, partition); assert.notEqual(f.disk().authScope, scope); await f.service.dispose();
});
test('X media rejects arbitrary references and rewrites HLS references into scoped capabilities', async () => {
  const f = fixture(); await f.service.ready; await flush(); const rows = await f.service.listPosts({ tab: 'replies' }); const src = rows.items[0].media[0].src;
  const response = await f.service.resourceHandler(new Request(src)); assert.equal(response.status, 200); const body = await response.text(); assert.match(body, /tibotattle-x-media:\/\/resource\//); assert.equal(body.includes('video.twimg.com'), false);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:12345');
  assert.equal((await f.service.resourceHandler(new Request(src, { headers: { Origin: 'https://x.com' } }))).status, 403);
  assert.equal((await f.service.resourceHandler(new Request('tibotattle-x-media://resource/https://evil.test'))).status, 404);
  await f.service.logout(); assert.equal((await f.service.resourceHandler(new Request(src))).status, 404); await f.service.dispose();
});
test('X disabled cadence restores no remote page, permits first visit, and resume does not refresh', async () => {
  const f = fixture(initial({ settings: { ...X_DEFAULT_SETTINGS, refreshMinutes: -1 }, posts: [post()], lists: { posts: ['123'], replies: [], reposts: [], media: [] } }));
  await f.service.ready; await flush(); assert.equal(f.loads.length, 0); assert.equal(f.scheduled.size, 0);
  f.service.resume(); await flush(); assert.equal(f.loads.length, 0);
  assert.equal((await f.service.listPosts({ tab: 'posts' })).source, 'cache'); await flush(); assert.equal(f.loads.length, 1); assert.equal(f.scheduled.size, 0); await f.service.dispose();
});
test('X candidate timeout and cancellation of late authentication preserve the existing session', async () => {
  const timed = fixture(initial(), { loginTimeoutMs: 0 }); await timed.service.ready; await flush(); await timed.service.beginLogin({ method: 'web' }); await flush(); assert.equal(timed.disk().activePartition, partition); assert.equal(timed.service.getStatus().auth, 'ready'); await timed.service.dispose();
  let complete;
  const f = fixture(initial(), { adapterFactory: () => ({ load: async () => ({ authenticated: true, posts: [post()], exhausted: true }), inspect: () => new Promise(resolve => { complete = resolve; }), dispose() {} }) });
  await f.service.ready; await flush(); await f.service.beginLogin({ method: 'session' });
  const value = name => ({ url: 'https://x.com/', domain: '.x.com', name, value: 'synthetic', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'no_restriction' });
  await f.service.importCookies([value('auth_token'), value('ct0')], { isCurrent: () => true }); await flush(); f.service.cancelLogin(); complete({ accountMenu: true }); await flush(); assert.equal(f.disk().activePartition, partition); assert.equal(f.disk().authScope, scope); assert.equal(f.service.getStatus().auth, 'ready'); await f.service.dispose();
});

test('X candidate navigation failure closes the blank window promptly and keeps the saved session', async () => {
  const f = fixture(); await f.service.ready; await flush();
  const Window = f.runtime.BrowserWindow;
  f.runtime.BrowserWindow = class extends Window { async loadURL() { throw new Error('ERR_CONNECTION_CLOSED'); } };
  await f.service.beginLogin({ method: 'web' }); await flush();
  assert.equal(f.windows.at(-1).isDestroyed(), true);
  assert.equal(f.service.getStatus().auth, 'ready');
  assert.equal(f.service.getStatus().loginMethod, null);
  assert.equal(f.service.getStatus().error, 'offline');
  assert.equal(f.disk().activePartition, partition);
  await f.service.dispose();
});
test('X list freshness reflects real successful retrieval and failure fallback, not memory presence', async () => {
  const f = fixture(); await f.service.ready; await flush();
  const live = await f.service.listPosts({ tab: 'replies' }); assert.equal(live.source, 'live'); assert.ok(live.updatedAt);
  await flush(); f.setLoad(async () => { throw Object.assign(new Error('synthetic'), { code: 'offline' }); }); await f.service.refresh({ tab: 'replies' });
  const fallback = await f.service.listPosts({ tab: 'replies' }); assert.equal(fallback.source, 'cache'); assert.equal(fallback.items.length, 1); await f.service.dispose();
});

test('pagination retries no progress, forwards its boundary, and stops only at an explicit end', async () => {
  const f = fixture(); f.setLoad(async () => ({ posts: [post('123')], exhausted: false })); await f.service.ready; await flush();
  const first = await f.service.listPosts({ tab: 'posts' }); await flush(); assert.ok(first.nextCursor);
  const stalled = await f.service.listPosts({ tab: 'posts', cursor: first.nextCursor });
  assert.equal(stalled.items.length, 0); assert.equal(stalled.hasMore, true); assert.equal(stalled.nextCursor, first.nextCursor); assert.equal(stalled.status.error, 'pagination_pending');
  assert.deepEqual(f.loads.at(-1).after, { id: '123', createdAt: post().createdAt }); assert.equal(f.loads.at(-1).more, true);
  f.setLoad(async () => ({ posts: [post('124'), post('123'), post('122')], exhausted: false }));
  const next = await f.service.listPosts({ tab: 'posts', cursor: first.nextCursor }); assert.deepEqual(next.items.map(item => item.id), ['122']); assert.ok(next.nextCursor);
  f.setLoad(async () => ({ posts: [], exhausted: true }));
  const end = await f.service.listPosts({ tab: 'posts', cursor: next.nextCursor }); assert.deepEqual(end.items, []); assert.equal(end.hasMore, false); assert.equal(end.nextCursor, null); await f.service.dispose();
});

test('pagination keeps the continuation on network failure and on authentication expiry', async () => {
  for (const code of ['offline', 'expired']) {
    const f = fixture(); f.setLoad(async () => ({ posts: [post()], exhausted: false })); await f.service.ready; await flush();
    const first = await f.service.listPosts({ tab: 'posts' }); await flush(); f.setLoad(async () => { throw Object.assign(new Error('Synthetic'), { code }); });
    const next = await f.service.listPosts({ tab: 'posts', cursor: first.nextCursor }); assert.equal(next.nextCursor, first.nextCursor); assert.equal(next.hasMore, true); assert.equal(next.status.error, code); await f.service.dispose();
  }
});

test('pagination anchors to the last returned post when newer head posts arrive', async () => {
  const items = Array.from({ length: 60 }, (_, index) => post(String(100 - index))); const f = fixture();
  f.setLoad(async () => ({ posts: items, exhausted: false })); await f.service.ready; await flush();
  const first = await f.service.listPosts({ tab: 'posts' }); await flush(); assert.equal(first.items.at(-1).id, '71');
  f.setLoad(async () => ({ posts: [post('101')], exhausted: false })); await f.service.refresh({ tab: 'posts' });
  const next = await f.service.listPosts({ tab: 'posts', cursor: first.nextCursor }); assert.equal(next.items[0].id, '70'); assert.equal(next.items.at(-1).id, '41'); assert.equal(next.items.length, 30); await f.service.dispose();
});
test('X first-visit deferred retrieval cannot refill cache after explicit clear', async () => {
  const f = fixture(initial({ posts: [post()], lists: { posts: ['123'], replies: [], reposts: [], media: [] } })); let resolve;
  f.setLoad(() => new Promise(done => { resolve = done; })); await f.service.ready; await flush(); await f.service.listPosts({ tab: 'posts' });
  await f.service.clearCache(); resolve({ authenticated: true, posts: [post('999')], exhausted: true }); await flush(); assert.equal(f.loads.length, 1); assert.deepEqual(f.disk().posts, []); assert.equal(f.service.getStatus().auth, 'ready'); await f.service.dispose();
});
test('X proxy apply failure keeps previous saved settings and attempts runtime rollback', async () => {
  const f = fixture(); await f.service.ready; await flush(); const calls = [];
  f.session.setProxy = async value => { calls.push(value); if (value.mode === 'fixed_servers') throw new Error('synthetic'); };
  await assert.rejects(f.service.setSettings({ proxyMode: 'local', proxyPort: 12345 }), { code: 'proxy_failed' }); assert.equal(f.disk().settings.proxyMode, 'system'); assert.equal((await f.service.getSettings()).settings.proxyMode, 'system'); assert.equal(calls.at(-1).mode, 'system'); await f.service.dispose();
});
test('X candidate challenge opens its existing verification window without replacing the pending session', async () => {
  const f = fixture(initial(), { adapterFactory: () => ({ load: async () => ({ authenticated: true, posts: [post()], exhausted: true }), inspect: async () => { throw Object.assign(new Error('synthetic'), { code: 'challenge' }); }, dispose() {} }) });
  await f.service.ready; await flush(); await f.service.beginLogin({ method: 'session' });
  const value = name => ({ url: 'https://x.com/', domain: '.x.com', name, value: 'synthetic', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'no_restriction' });
  await f.service.importCookies([value('auth_token'), value('ct0')], { isCurrent: () => true }); await flush(); assert.equal(f.service.getStatus().auth, 'challenge'); const candidateId = f.service.inspectRuntime().candidateWebContentsId; const count = f.windows.length; let shown = false; f.windows.at(-1).show = () => { shown = true; };
  await f.service.beginLogin({ method: 'web' }); assert.equal(shown, true); assert.equal(f.windows.length, count); assert.equal(f.service.inspectRuntime().candidateWebContentsId, candidateId); assert.equal(f.disk().activePartition, partition); f.service.cancelLogin(); await f.service.dispose();
});
test('X media expiration refreshes the associated post once for concurrent media roles and retries only once', async () => {
  const original = post(); original.media[0].poster = 'https://pbs.twimg.com/media/old.jpg';
  const f = fixture(); f.setLoad(async () => ({ authenticated: true, posts: [original], exhausted: true })); await f.service.ready; await flush(); const rows = await f.service.listPosts({ tab: 'replies' }); await flush();
  const before = f.loads.length; const fresh = structuredClone(original); fresh.media[0].url = 'https://video.twimg.com/fresh.mp4'; fresh.media[0].poster = 'https://pbs.twimg.com/media/fresh.jpg';
  f.setLoad(async () => { await new Promise(resolve => setImmediate(resolve)); return { posts: [fresh], exhausted: true }; }); const fetched = [];
  f.session.fetch = async url => { fetched.push(url); return url.includes('fresh') ? new Response('synthetic', { headers: { 'content-type': url.endsWith('.jpg') ? 'image/jpeg' : 'video/mp4' } }) : new Response(null, { status: 403 }); };
  const status = f.service.getStatus(); const responses = await Promise.all([f.service.resourceHandler(new Request(rows.items[0].media[0].src)), f.service.resourceHandler(new Request(rows.items[0].media[0].src)), f.service.resourceHandler(new Request(rows.items[0].media[0].poster))]);
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]); assert.equal(f.loads.length - before, 1); assert.equal(f.service.getStatus().operation, status.operation); assert.equal(f.service.getStatus().error, status.error); assert.equal(fetched.filter(url => url.includes('fresh')).length, 3);
  f.session.fetch = async () => new Response(null, { status: 410 }); const count = f.loads.length; assert.equal((await f.service.resourceHandler(new Request(rows.items[0].media[0].src))).status, 502); assert.equal(f.loads.length, count); await f.service.dispose();
});
test('X media expiration resolves HLS segment roles through the refreshed controlled playlist', async () => {
  const f = fixture(); await f.service.ready; await flush(); const rows = await f.service.listPosts({ tab: 'replies' }); await flush();
  f.session.fetch = async url => url.endsWith('master.m3u8') ? new Response('#EXTM3U\nold.ts', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }) : new Response(null, { status: 410 });
  const playlist = await f.service.resourceHandler(new Request(rows.items[0].media[0].src)); const segment = (await playlist.text()).split('\n')[1]; const fresh = post(); fresh.media[0].url = 'https://video.twimg.com/new-master.m3u8'; f.setLoad(async () => ({ posts: [fresh], exhausted: true }));
  f.session.fetch = async url => url.endsWith('new-master.m3u8') ? new Response('#EXTM3U\nnew.ts', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }) : url.endsWith('new.ts') ? new Response('synthetic', { headers: { 'content-type': 'video/mp2t' } }) : new Response(null, { status: 410 });
  assert.equal((await f.service.resourceHandler(new Request(segment))).status, 200); await f.service.dispose();
});
test('X media expiration ignores late replacement after logout and leaves content status intact on ordinary failures', async () => {
  const f = fixture(); await f.service.ready; await flush(); const rows = await f.service.listPosts({ tab: 'replies' }); await flush(); const src = rows.items[0].media[0].src;
  const status = f.service.getStatus(); const count = f.loads.length; f.session.fetch = async () => new Response(null, { status: 503 }); assert.equal((await f.service.resourceHandler(new Request(src))).status, 502); assert.equal(f.loads.length, count); assert.equal(f.service.getStatus().operation, status.operation);
  let complete; f.setLoad(() => new Promise(resolve => { complete = resolve; })); f.session.fetch = async () => new Response(null, { status: 404 }); const request = f.service.resourceHandler(new Request(src)); await flush(); await f.service.logout(); const fresh = post(); fresh.media[0].url = 'https://video.twimg.com/fresh.mp4'; complete({ posts: [fresh], exhausted: true }); assert.equal((await request).status, 404); assert.equal(f.disk().activePartition, null); assert.equal(f.disk().posts[0].media[0].url.includes('fresh'), false); await f.service.dispose();
});
test('X expired Session grant returns to login selection without touching an existing session or inventing network failure', async () => {
  for (const existing of [true, false]) {
    let gate = { code: 'bridge_ready', pending: false, importing: false };
    const bridge = { status: () => gate, begin: async () => { gate = { code: 'import_ready', pending: true, importing: false }; return gate; }, cancel() { gate = { code: 'bridge_ready', pending: false, importing: false }; } };
    const f = fixture(initial({ activePartition: existing ? partition : null, authScope: existing ? scope : null }), { importBridge: bridge });
    await f.service.ready; await flush(); await f.service.beginLogin({ method: 'session' }); assert.equal(f.service.getStatus().auth, 'authorizing');
    gate = { code: 'import_ready', pending: false, importing: false }; const expired = f.service.getStatus(); assert.equal(expired.auth, existing ? 'ready' : 'disconnected'); assert.equal(expired.operation, 'error'); assert.equal(expired.error, 'import_failed'); assert.equal(expired.loginMethod, null); assert.equal(f.disk().activePartition, existing ? partition : null);
    assert.equal((await f.service.beginLogin({ method: 'session' })).auth, 'authorizing'); assert.equal(f.service.getStatus().auth, 'authorizing'); f.service.cancelLogin(); await f.service.dispose();
  }
});

test('X cancelling protocol streams releases upstream requests instead of exhausting connection slots', async () => {
  const f = fixture(); const media = post(); media.media[0].url = 'https://video.twimg.com/synthetic.mp4'; f.setLoad(async () => ({ posts: [media], exhausted: true })); await f.service.ready; await flush();
  const src = (await f.service.listPosts({ tab: 'replies' })).items[0].media[0].src;
  let open = 0; let cancelled = 0; const ranges = [];
  f.session.fetch = async (_url, options) => {
    assert.ok(open < 6, 'cancelled media must free the per-origin connection slot'); open++; ranges.push(options.headers.Range);
    options.signal.addEventListener('abort', () => { open--; }, { once: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled++; } }), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2/100', 'accept-ranges': 'bytes' } });
  };
  for (let i = 0; i < 8; i++) {
    const request = new Request(src, { headers: { Range: 'bytes=0-' } }); const response = await f.service.resourceHandler(request);
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 0-2/100');
    const reader = response.body.getReader(); assert.deepEqual([...(await reader.read()).value], [1, 2, 3]); await reader.cancel();
    assert.equal(request.signal.aborted, false, 'protocol cancellation need not abort its Request.signal'); assert.equal(open, 0);
  }
  assert.equal(cancelled, 8); assert.deepEqual(ranges, Array(8).fill('bytes=0-')); await f.service.dispose();
});

test('X rejected responses and oversized playlists abort unused upstream bodies', async () => {
  const f = fixture(); const media = post(); media.media[0].url = 'https://video.twimg.com/synthetic.mp4'; f.setLoad(async () => ({ posts: [media], exhausted: true })); await f.service.ready; await flush(); const src = (await f.service.listPosts({ tab: 'replies' })).items[0].media[0].src;
  for (const reply of [{ status: 503, type: 'video/mp4' }, { status: 200, type: 'text/html' }, { status: 200, type: 'application/vnd.apple.mpegurl', length: '2000001' }]) {
    let signal; let cancelled = false;
    f.session.fetch = async (_url, options) => { signal = options.signal; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: reply.status, headers: { 'content-type': reply.type, ...(reply.length ? { 'content-length': reply.length } : {}) } }); };
    assert.equal((await f.service.resourceHandler(new Request(src))).status, 502); assert.equal(signal.aborted, true); assert.equal(cancelled, true);
  }
  await f.service.dispose();
});

test('X proxy changes, logout, and disposal abort in-flight media without waiting for renderer cleanup', async () => {
  for (const action of ['proxy', 'logout', 'dispose']) {
    const f = fixture(); const media = post(); media.media[0].url = 'https://video.twimg.com/synthetic.mp4'; f.setLoad(async () => ({ posts: [media], exhausted: true })); await f.service.ready; await flush(); const src = (await f.service.listPosts({ tab: 'replies' })).items[0].media[0].src;
    let signal; f.session.fetch = async (_url, options) => { signal = options.signal; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } }), { headers: { 'content-type': 'video/mp4' } }); };
    const response = await f.service.resourceHandler(new Request(src)); const reader = response.body.getReader(); await reader.read(); assert.equal(signal.aborted, false);
    if (action === 'proxy') await f.service.setSettings({ proxyMode: 'local', proxyPort: 10808 }); else await f.service[action]();
    assert.equal(signal.aborted, true, action); await reader.cancel(); await f.service.dispose();
  }
});
