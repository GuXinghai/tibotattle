import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopXService } from '../desktop-x-service.js';
import { X_DEFAULT_SETTINGS } from '../desktop-x-contract.js';

const partition = '26d7264f-3422-4a24-985e-940ef42782ac';
const scope = 'b8ea1e27-7bcf-4b38-bd10-2fbde8bf6e74';
const post = (id = '123', kind = 'post') => ({ id, author: { name: 'Example', handle: 'thsottiaux', avatar: 'https://pbs.twimg.com/profile_images/example.jpg' }, createdAt: '2026-10-19T14:59:00.000Z', text: 'Synthetic public post', complete: true, kind, media: [{ id: 'media-1', type: 'video', url: 'https://video.twimg.com/master.m3u8', mimeType: 'application/x-mpegURL' }] });
const initial = (extra = {}) => ({ version: 1, settings: { ...X_DEFAULT_SETTINGS }, activePartition: partition, authScope: scope, posts: [], lists: { posts: [], replies: [], reposts: [], media: [] }, notificationBaseline: { posts: [], replies: [] }, ...extra });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const importCookies = () => ['auth_token','ct0'].map(name => ({url:'https://x.com/',domain:'.x.com',name,value:'synthetic',path:'/',secure:true,httpOnly:name==='auth_token',sameSite:'no_restriction'}));

test('initial login status stays checking until saved state is read, including read failures',async()=>{
  for(const failed of [false,true]){
    let finishRead,rejectRead;
    const f=fixture(undefined,{repository:{read:()=>new Promise((resolve,reject)=>{finishRead=resolve;rejectRead=reject;}),listSessionCleanup:async()=>({partitions:[],pendingClear:[]})}});
    assert.equal(f.service.getStatus().auth,'restoring');
    if(failed)rejectRead(new Error('synthetic'));else finishRead(null);
    await f.service.ready;
    assert.equal(f.service.getStatus().auth,'disconnected');assert.equal(f.service.getStatus().operation,failed?'error':'idle');
    assert.equal(f.service.getStatus().error,failed?'storage_unavailable':null);await f.service.dispose();
  }
});

test('initial saved-session recovery never reports a disconnected intermediate state',async()=>{
  const observed=[];const f=fixture(initial(),{onUpdate:value=>observed.push(value.auth)});
  assert.equal(f.service.getStatus().auth,'restoring');await f.service.ready;await flush();
  assert.equal(f.service.getStatus().auth,'ready');assert.equal(observed.includes('disconnected'),false);await f.service.dispose();
});

test('reply continuation deduplicates pages, retries no progress and separates branch exhaustion',async()=>{
  const f=fixture();await f.service.ready;await flush();
  const reply=(id,parent='123')=>({...post(id,'reply'),replyTo:parent});
  f.setLoad(async()=>({posts:[post(),reply('124')],exhausted:false}));
  const first=await f.service.getPost({id:'123'});assert.equal(first.hasMore,true);assert.equal(first.repliesExhausted,false);
  await assert.rejects(f.service.getPost({id:'124',cursor:first.nextCursor}),{code:'invalid_cursor'});
  const retry=await f.service.getPost({id:'123',cursor:first.nextCursor});assert.equal(retry.outcome,'failed');assert.equal(retry.error,'pagination_pending');assert.equal(retry.nextCursor,first.nextCursor);
  f.setLoad(async args=>{if(args.id==='124')return{posts:[reply('124'),reply('126','124')],exhausted:true};assert.equal(args.more,true);assert.ok(args.knownReplies.includes('124'));return{posts:[reply('124'),reply('125'),reply('126','124')],exhausted:true};});
  const last=await f.service.getPost({id:'123',cursor:first.nextCursor});assert.deepEqual(last.replies.map(post=>post.id),['124','125']);assert.equal(last.nextCursor,null);assert.equal(last.repliesExhausted,true);
  const reads=f.loads.length;assert.equal((await f.service.getPost({id:'123',cursor:first.nextCursor})).repliesExhausted,true);assert.equal(f.loads.length,reads,'replay returns the completed page rather than fetching twice');
  const branch=await f.service.getPost({id:'124'});assert.deepEqual(branch.replies.map(post=>post.id),['126']);assert.equal(branch.repliesExhausted,true);
  assert.equal((await f.service.getPost({id:'123'})).repliesExhausted,true);await f.service.dispose();
});

test('clearing cache rejects late reply pages and invalidates their handles',async()=>{
  const f=fixture();await f.service.ready;await flush();f.setLoad(async()=>({posts:[post()],exhausted:false}));const first=await f.service.getPost({id:'123'});
  let release;f.setLoad(()=>new Promise(resolve=>{release=resolve;}));const pending=f.service.getPost({id:'123',cursor:first.nextCursor});await flush();
  await f.service.clearCache();release({posts:[{...post('124','reply'),replyTo:'123'}],exhausted:true});await pending;
  assert.deepEqual(f.disk().posts,[]);await assert.rejects(f.service.getPost({id:'123',cursor:first.nextCursor}),{code:'invalid_cursor'});await f.service.dispose();
});

test('discussion order follows returned pages, forced refresh replaces it and retains archived posts',async()=>{
  const f=fixture();await f.service.ready;await flush();
  const reply=id=>({...post(id,'reply'),replyTo:'123',createdAt:`2026-10-19T${id==='124'?'12':'11'}:00:00.000Z`});
  f.setLoad(async()=>({posts:[post(),reply('124'),reply('125')],exhausted:false}));
  const first=await f.service.getPost({id:'123'});assert.deepEqual(first.replies.map(p=>p.id),['124','125']);
  const scheduled=f.service.getStatus().nextRefreshAt;const count=f.loads.length;
  await f.service.getPost({id:'123'});assert.equal(f.loads.length,count,'ordinary entry still reuses 60-second cache');
  f.setLoad(async()=>({posts:[reply('125'),reply('126'),reply('124')],exhausted:true}));
  const page=await f.service.getPost({id:'123',cursor:first.nextCursor});assert.deepEqual(page.replies.map(p=>p.id),['124','125','126']);
  f.setLoad(async()=>({posts:[post(),reply('126'),reply('125')],exhausted:false}));
  const fresh=await f.service.getPost({id:'123',force:true});assert.deepEqual(fresh.replies.map(p=>p.id),['126','125']);
  assert.ok(f.disk().posts.some(p=>p.id==='124'));assert.deepEqual(f.disk().replyLists['123'],['126','125']);
  await assert.rejects(f.service.getPost({id:'123',cursor:first.nextCursor}),{code:'invalid_cursor'});
  assert.equal(f.service.getStatus().nextRefreshAt,scheduled,'manual detail does not postpone timer');
  f.setLoad(async args=>{assert.deepEqual(args.knownReplies,['126','125']);return{posts:[reply('124')],exhausted:true};});
  assert.deepEqual((await f.service.getPost({id:'123',cursor:fresh.nextCursor})).replies.map(p=>p.id),['126','125','124']);
  f.setLoad(async()=>{throw Object.assign(new Error('synthetic'),{code:'offline'});});
  const failed=await f.service.getPost({id:'123',force:true});assert.equal(failed.outcome,'failed');assert.deepEqual(failed.replies.map(p=>p.id),['126','125','124']);
  await f.service.dispose();
  const reopened=fixture({...f.disk(),activePartition:null});await reopened.service.ready;
  const offline=await reopened.service.getPost({id:'123'});assert.equal(offline.source,'cache');assert.deepEqual(offline.replies.map(p=>p.id),['126','125','124']);assert.equal(reopened.loads.length,0);await reopened.service.dispose();
});

test('manual list refresh fetches only its tab and keeps the background timer deadline',async()=>{
  const f=fixture();await f.service.ready;await flush();const start=f.loads.length,deadline=f.service.getStatus().nextRefreshAt;
  f.advance(1000);await f.service.refresh({tab:'media',reason:'manual'});
  assert.deepEqual(f.loads.slice(start).map(q=>q.tab),['media']);assert.equal(f.service.getStatus().nextRefreshAt,deadline);
  await f.service.dispose();
});

test('Session progress follows actual preparation, verification and persistence boundaries',async()=>{
  const observed=[];const f=fixture(initial(),{onUpdate:status=>{if(status.loginStage&&observed.at(-1)!==status.loginStage)observed.push(status.loginStage);}});
  await f.service.ready;await flush();await f.service.beginLogin({method:'session'});
  await f.service.importCookies(importCookies(),{isCurrent:()=>true});await flush();
  assert.deepEqual(observed,['checking_bridge','waiting_import','validating','preparing','writing','connecting','verifying','saving','complete']);
  assert.equal(f.service.getStatus().auth,'ready');assert.equal(f.service.getStatus().loginFailureStage,null);await f.service.dispose();
});

test('Session failures retain the failed step and cancellation clears it',async()=>{
  for(const step of ['validating','writing','connecting','saving']){
    const f=fixture();await f.service.ready;await flush();
    if(step==='writing'||step==='saving'){
      const open=f.runtime.session.fromPath;f.runtime.session.fromPath=path=>{const session=open(path);if(!path.endsWith(partition)){if(step==='writing')session.cookies.set=async()=>{throw new Error('synthetic');};else session.cookies.flushStore=async()=>{throw new Error('synthetic');};}return session;};
    }
    if(step==='connecting'){const Window=f.runtime.BrowserWindow;f.runtime.BrowserWindow=class extends Window{async loadURL(){throw new Error('net::ERR_PROXY_CONNECTION_FAILED');}};}
    await f.service.beginLogin({method:'session'});
    await f.service.importCookies(step==='validating'?[]:importCookies(),{isCurrent:()=>true}).catch(()=>{});await flush();
    assert.equal(f.service.getStatus().loginFailureStage,step,step);assert.equal(f.service.getStatus().operation,'error',step);
    f.service.cancelLogin();assert.equal(f.service.getStatus().loginStage,null);assert.equal(f.service.getStatus().loginFailureStage,null);
    await f.service.dispose().catch(()=>{});
  }
});

test('Session challenge can reopen its existing candidate without switching login method',async()=>{
  const f=fixture(initial(),{adapterFactory:()=>({load:async()=>({authenticated:true,posts:[],exhausted:true}),inspect:async()=>{throw Object.assign(new Error('challenge'),{code:'challenge'});},dispose(){}})});
  await f.service.ready;await flush();await f.service.beginLogin({method:'session'});await f.service.importCookies(importCookies(),{isCurrent:()=>true});await flush();
  assert.equal(f.service.getStatus().loginStage,'challenge');const count=f.windows.length;
  await f.service.beginLogin({method:'web'});assert.equal(f.windows.length,count);assert.equal(f.service.getStatus().loginMethod,'session');assert.equal(f.service.getStatus().loginStage,'challenge');
  f.service.cancelLogin();await f.service.dispose();
});
function fixture(saved = initial(), overrides = {}) {
  let disk = structuredClone(saved); let time = 1000000; const scheduled = new Map(); let sequence = 0; const windows = []; const notifications = []; const loads = []; let adapterLoad = async () => ({ authenticated: true, posts: [post()], exhausted: true });
  function makeSession(existing = false) {
    const cookies = existing ? ['auth_token', 'ct0'].map(name => ({ name, value: 'synthetic', domain: '.x.com', path: '/', secure: true })) : [];
    return { setProxy: async () => {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, closeAllConnections: async () => {}, clearStorageData: async () => { cookies.length = 0; }, cookies: { set: async value => { const index = cookies.findIndex(cookie => cookie.name === value.name && cookie.domain === value.domain); const cookie = { ...value, hostOnly: !value.domain }; if (index < 0) cookies.push(cookie); else cookies[index] = cookie; }, get: async filter => cookies.filter(cookie => filter?.domain ? cookie.domain?.replace(/^\./, '') === filter.domain : filter?.url ? cookie.url === filter.url : true).map(cookie => ({ ...cookie })), flushStore: async () => {} }, fetch: async () => new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }) };
  }
  const session = makeSession(true); const sessions = new Map([[`C:\\synthetic\\${partition}`, session]]); const checkpoints = new Map(); const partitions = new Set(); const pendingClear = new Set();
  class Window extends EventEmitter { constructor() { super(); this.destroyed = false; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.stop = () => {}; this.webContents.id = windows.length + 1; windows.push(this); } setMenu() {} hide() {} show() {} isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; } async loadURL() {} }
  const runtime = { BrowserWindow: Window, safeStorage: { isEncryptionAvailable: () => true }, session: { fromPath: path => { if (!sessions.has(path)) sessions.set(path, makeSession()); return sessions.get(path); } }, powerMonitor: new EventEmitter() };
  const repository = { read: async () => disk, write: async value => { disk = structuredClone(value); }, clearCache: async () => { disk.posts = []; disk.lists = { posts: [], replies: [], reposts: [], media: [] }; }, getSessionPath: async id => `C:\\synthetic\\${id}`, checkSessionHealth: async () => ({ cookieDatabasePresent: true, cookieDatabaseBytes: 20480 }), readSessionCheckpoint: async id => checkpoints.get(id) ?? null, writeSessionCheckpoint: async (id, proof) => { checkpoints.set(id, structuredClone(proof)); }, registerSession: async id => { partitions.add(id); }, listSessionCleanup: async () => ({ partitions: [...partitions], pendingClear: [...pendingClear] }), queueSessionCleanup: async id => { partitions.add(id); pendingClear.add(id); }, retainSession: async id => { pendingClear.delete(id); }, completeSessionCleanup: async id => { checkpoints.delete(id); partitions.delete(id); pendingClear.delete(id); }, cacheBytes: 0 };
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
  await assert.rejects(f.service.dispose(), { code: 'session_clear_failed' });
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
  assert.match(rows.items[0].media[0].src, /^usagemonitor-x-media:\/\/resource\//); assert.equal(JSON.stringify(rows).includes('video.twimg.com'), false);
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
  const response = await f.service.resourceHandler(new Request(src)); assert.equal(response.status, 200); const body = await response.text(); assert.match(body, /usagemonitor-x-media:\/\/resource\//); assert.equal(body.includes('video.twimg.com'), false);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:12345');
  assert.equal((await f.service.resourceHandler(new Request(src, { headers: { Origin: 'https://x.com' } }))).status, 403);
  assert.equal((await f.service.resourceHandler(new Request('usagemonitor-x-media://resource/https://evil.test'))).status, 404);
  await f.service.logout(); assert.equal((await f.service.resourceHandler(new Request(src))).status, 404); await f.service.dispose();
});
test('X disabled cadence restores no remote page, permits first visit, and resume does not refresh', async () => {
  const f = fixture(initial({ settings: { ...X_DEFAULT_SETTINGS, refreshMinutes: -1 }, posts: [post()], lists: { posts: ['123'], replies: [], reposts: [], media: [] } }));
  await f.service.ready; await flush(); assert.equal(f.loads.length, 0); assert.equal(f.scheduled.size, 0);
  f.service.resume(); await flush(); assert.equal(f.loads.length, 0);
  assert.equal((await f.service.listPosts({ tab: 'posts' })).source, 'cache'); await flush(); assert.equal(f.loads.length, 1); assert.equal(f.scheduled.size, 0); await f.service.dispose();
});
test('X candidate timeout and cancellation of late authentication preserve the existing session', async () => {
  const timed = fixture(initial(), { loginTimeoutMs: 0 }); await timed.service.ready; await flush(); await timed.service.beginLogin({ method: 'web' }); await flush(); assert.equal(timed.disk().activePartition, partition); assert.equal(timed.service.getStatus().auth, 'ready'); assert.equal(timed.service.getStatus().error, 'login_timeout'); assert.equal(timed.service.getStatus().operation, 'error'); await timed.service.dispose();
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
  assert.equal(f.service.getStatus().operation, 'error');
  assert.equal(f.disk().activePartition, partition);
  await f.service.dispose();
});

test('failed X relogin preserves expired or challenged authentication instead of reporting connected', async () => {
  for (const auth of ['expired', 'challenge']) for (const method of ['web', 'session']) {
    const bridge = { begin: async () => { throw new Error('synthetic bridge failure'); }, cancel() {}, status: () => null };
    const f = fixture(initial(), { importBridge: bridge }); await f.service.ready; await flush();
    f.setLoad(async () => { throw Object.assign(new Error('synthetic'), { code: auth }); });
    await f.service.refresh(); assert.equal(f.service.getStatus().auth, auth);
    if (method === 'web') {
      const Window = f.runtime.BrowserWindow;
      f.runtime.BrowserWindow = class extends Window { async loadURL() { throw new Error('synthetic navigation failure'); } };
      // A challenged active window is reused without navigation. Reject its
      // verification to exercise the same failure recovery for that route.
      if (auth === 'challenge') f.session.cookies.get = async () => { throw Object.assign(new Error('synthetic read failure'), { code: 'session_read_failed' }); };
    }
    await f.service.beginLogin({ method }); await flush();
    assert.equal(f.service.getStatus().auth, auth); assert.equal(f.service.getStatus().operation, 'error');
    assert.equal(f.service.getStatus().error, method === 'session' ? 'import_failed' : auth === 'challenge' ? 'session_read_failed' : 'offline'); assert.equal(f.scheduled.size, 0);
    if (method === 'web' && auth === 'challenge') await assert.rejects(f.service.dispose(), { code: 'session_read_failed' });
    else await f.service.dispose();
  }
});

test('cancelled X login cannot publish its ordinary failure after asynchronous cleanup', async () => {
  const f = fixture(initial({ activePartition: null, authScope: null })); await f.service.ready; await flush();
  let release;
  const fromPath = f.runtime.session.fromPath;
  f.runtime.session.fromPath = path => { const session = fromPath(path); session.clearStorageData = () => new Promise(resolve => { release = resolve; }); return session; };
  const Window = f.runtime.BrowserWindow;
  f.runtime.BrowserWindow = class extends Window { async loadURL() { throw new Error('synthetic navigation failure'); } };
  await f.service.beginLogin({ method: 'web' }); await flush(); assert.equal(typeof release, 'function');
  f.service.cancelLogin(); assert.equal(f.service.getStatus().error, null);
  release(); await flush();
  assert.equal(f.service.getStatus().auth, 'disconnected'); assert.equal(f.service.getStatus().operation, 'idle'); assert.equal(f.service.getStatus().error, null);
  await f.service.dispose();
});

test('X web setup failures stay distinct from import failures and diagnostic observers cannot alter login state', async () => {
  const diagnostics = []; const failure = new Error('synthetic window failure');
  const f = fixture(initial({ activePartition: null, authScope: null }), { onDiagnostic(stage, error) { diagnostics.push({ stage, error }); throw new Error('synthetic observer failure'); } });
  await f.service.ready; await flush();
  f.runtime.BrowserWindow = class { constructor() { throw failure; } };
  await f.service.beginLogin({ method: 'web' }); await flush();
  assert.equal(f.service.getStatus().auth, 'disconnected'); assert.equal(f.service.getStatus().operation, 'error'); assert.equal(f.service.getStatus().error, 'login_failed');
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].stage, 'login_web'); assert.equal(diagnostics[0].error, failure);
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
  f.session.fetch = async () => new Response(null, { status: 410 }); const count = f.loads.length; for (let i = 0; i < 4; i++) assert.equal((await f.service.resourceHandler(new Request(rows.items[0].media[0].src))).status, 502); assert.equal(f.loads.length - count, 2, 'three attempts total per minute, including the successful recovery'); await f.service.dispose();
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
    gate = { code: 'import_ready', pending: false, importing: false }; const expired = f.service.getStatus(); assert.equal(expired.auth, existing ? 'ready' : 'disconnected'); assert.equal(expired.operation, 'error'); assert.equal(expired.error, 'import_expired'); assert.equal(expired.loginFailureStage, 'waiting_import'); assert.equal(expired.loginMethod, null); assert.equal(f.disk().activePartition, existing ? partition : null);
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


test('partial content refresh retains full text while updating stable media, avatar and quote', async () => {
  const f = fixture(); await f.service.ready; await flush();
  const partial = { ...post(), text: 'Short', complete: false, author: { ...post().author, avatar: 'https://pbs.twimg.com/profile_images/fresh.jpg' }, media: [{ id: 'media-2', type: 'image', url: 'https://pbs.twimg.com/media/fresh.jpg' }] };
  f.setLoad(async () => ({ authenticated: true, posts: [partial], exhausted: true })); await f.service.refresh();
  const saved = f.disk().posts.find(p => p.id === '123'); assert.equal(saved.text, post().text); assert.equal(saved.complete, true); assert.equal(saved.media[0].id, 'media-2'); assert.equal(saved.author.avatar, partial.author.avatar);
  await f.service.dispose();
});

test('detail result is independent of unrelated list failure, and offline cache is readable', async () => {
  const f = fixture(); await f.service.ready; await flush(); assert.equal((await f.service.getPost({ id: '123' })).outcome, 'live');
  f.setLoad(async () => { throw Object.assign(new Error('Synthetic'), { code: 'offline' }); }); await f.service.refresh();
  assert.equal((await f.service.getPost({ id: '123' })).outcome, 'live');
  await f.service.logout(); const cached = await f.service.getPost({ id: '123' }); assert.equal(cached.outcome, 'cache'); assert.equal(cached.error, null); await f.service.dispose();
});

test('media retries transient recovery, matches stable identity after reorder, refuses legacy positional rebinding', async () => {
  for (const stable of [true, false]) {
    const f = fixture(); const old = post(); old.media[0].id = stable ? 'media-1' : '0';
    f.setLoad(async () => ({ authenticated: true, posts: [old], exhausted: true })); await f.service.ready; await flush();
    const src = (await f.service.listPosts({ tab: 'replies' })).items[0].media[0].src; await flush();
    let attempts = 0; f.setLoad(async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('Synthetic'), { code: 'offline' });
      const fresh = post(); fresh.media = [{ id: 'media-2', type: 'video', url: 'https://video.twimg.com/wrong.mp4' }, { id: 'media-1', type: 'video', url: 'https://video.twimg.com/right.mp4' }]; return { posts: [fresh], exhausted: true }; });
    const fetched = []; f.session.fetch = async url => { fetched.push(url); return url.endsWith('right.mp4') ? new Response('ok', { headers: { 'content-type': 'video/mp4' } }) : new Response(null, { status: 403 }); };
    assert.equal((await f.service.resourceHandler(new Request(src))).status, 502);
    const recovered = await f.service.resourceHandler(new Request(src)); assert.equal(recovered.status, stable ? 200 : 502); await recovered.body?.cancel();
    assert.equal(attempts, stable ? 2 : 0); assert.equal(fetched.some(url => url.endsWith('wrong.mp4')), false); await f.service.dispose();
  }
});

test('HEAD validates media type and 416 preserves only a valid unsatisfied range', async () => {
  const f = fixture(); await f.service.ready; await flush(); const src = (await f.service.listPosts({ tab: 'replies' })).items[0].media[0].src; await flush();
  for (const type of ['text/html', 'image/png-malicious', 'application/x-mpegurl-evil']) { f.session.fetch = async () => new Response(null, { headers: { 'content-type': type } }); assert.equal((await f.service.resourceHandler(new Request(src, { method: 'HEAD' }))).status, 502); }
  for (const range of ['bytes */1024', 'invalid']) {
    f.session.fetch = async () => new Response(null, { status: 416, headers: { 'content-range': range } });
    const response = await f.service.resourceHandler(new Request(src)); assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), range === 'invalid' ? null : range); assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:12345');
  }
  await f.service.dispose();
});

test('notifications keep independent bounded categories and accept late arrivals above the initial baseline', async () => {
  const f = fixture(initial({ settings: { ...X_DEFAULT_SETTINGS, notifyPosts: true, notifyReplies: true } })); await f.service.ready; await flush();
  f.setLoad(async ({ tab }) => ({ authenticated: true, posts: tab === 'posts' ? [post('200')] : [post('150', 'reply')], exhausted: true })); await f.service.refresh();
  assert.deepEqual(f.notifications.at(-1), { posts: 1, replies: 1, latestId: '200' });
  f.setLoad(async () => ({ authenticated: true, posts: [post('140', 'reply')], exhausted: true })); await f.service.refresh();
  assert.equal(f.notifications.at(-1).latestId, '140'); const count = f.notifications.length; await f.service.refresh(); assert.equal(f.notifications.length, count);
  f.setLoad(async () => ({ authenticated: true, posts: Array.from({ length: 1100 }, (_, i) => post(String(1000+i))), exhausted: true })); await f.service.refresh();
  assert.equal(f.disk().version, 3); assert.equal(f.disk().notificationBaseline.posts.seen.length, 1024); assert.equal(f.disk().notificationBaseline.replies.seen.length, 2);
  await f.service.dispose();
});
