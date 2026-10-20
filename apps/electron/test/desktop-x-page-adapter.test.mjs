import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopXPageAdapter, inspectXDocument, projectXPageData } from '../desktop-x-page-adapter.js';

const tweet = (id = '123', handle = 'thsottiaux', extra = {}) => ({ __typename: 'Tweet', rest_id: id, core: { user_results: { result: { legacy: { name: 'Example', screen_name: handle, profile_image_url_https: 'https://pbs.twimg.com/profile_images/example.jpg' } } } }, legacy: { full_text: 'Synthetic public post', created_at: 'Mon Oct 19 14:59:00 +0000 2026', ...extra } });
test('X page projection preserves exact UTC, full note text, variants and verified reply relationships', () => {
  const item = tweet(); item.note_tweet = { note_tweet_results: { result: { text: 'Expanded synthetic post' } } }; item.legacy.truncated = true;
  item.legacy.extended_entities = { media: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/media/example.jpg', video_info: { variants: [{ content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/master.m3u8' }, { content_type: 'video/mp4', bitrate: 1000, url: 'https://video.twimg.com/clip.mp4' }] } }] };
  const result = projectXPageData({ timeline: { instructions: [{ entries: [item, tweet('124', 'another', { in_reply_to_status_id_str: '123' })] }] } });
  assert.equal(result.posts.length, 1); assert.equal(result.posts[0].createdAt, '2026-10-19T14:59:00.000Z'); assert.equal(result.posts[0].complete, true); assert.equal(result.posts[0].text, 'Expanded synthetic post'); assert.equal(result.posts[0].media[0].url, 'https://video.twimg.com/clip.mp4');
  const detail = projectXPageData({ item: tweet('124', 'another', { in_reply_to_status_id_str: '123' }) }, { detail: true }); assert.equal(detail.posts[0].replyTo, '123'); assert.equal(detail.posts[0].kind, 'reply');
});
test('X projection recognizes repost ownership, keeps original detail ID, and omits unknown fields', () => {
  const original = tweet('456', 'another'); original.secret = 'must-not-project';
  const wrapper = tweet('789'); wrapper.legacy.retweeted_status_result = { result: original };
  const result = projectXPageData({ entries: [wrapper, tweet('999', 'another')] });
  assert.equal(result.posts.length, 1); assert.equal(result.posts[0].id, '456'); assert.equal(result.posts[0].kind, 'repost'); assert.equal(JSON.stringify(result).includes('must-not-project'), false);
  assert.equal(projectXPageData({ unexpected: true }).recognized, false);
  assert.equal(projectXPageData({ timeline: { instructions: [] } }).recognized, true);
});

test('missing cursor metadata does not prove the end of a timeline', () => {
  assert.equal(projectXPageData({ entries: [tweet()] }).exhausted, false);
  assert.equal(projectXPageData({ timeline: { instructions: [] } }).exhausted, false);
  assert.equal(projectXPageData({ cursorType: 'Bottom', value: 'synthetic-next' }).exhausted, false);
  assert.equal(projectXPageData({ cursorType: 'Bottom', value: '' }).exhausted, true);
  assert.equal(projectXPageData({ type: 'TimelineTerminateTimeline', direction: 'Bottom' }).exhausted, true);
  assert.equal(projectXPageData({ type: 'TimelineTerminateTimeline', direction: 'Top' }).exhausted, false);
});

test('load more reopens a detoured timeline and scrolls beyond the cached boundary', async () => {
  const wc = new EventEmitter(); let url = 'https://x.com/thsottiaux/status/123', scrolls = 0, ticks = 0, navigations = 0;
  const item = id => ({ id, author: { name: 'Example', handle: 'thsottiaux' }, createdAt: '2026-10-19T14:59:00.000Z', text: 'Synthetic', complete: true, kind: 'post', media: [] });
  wc.getURL = () => url; wc.executeJavaScript = async code => {
    if (code.startsWith('window.scrollTo')) { scrolls++; return; }
    return { posts: [item('123'), ...(scrolls >= 2 ? [item('122')] : [])], accountMenu: true };
  };
  const adapter = createDesktopXPageAdapter({ window: { webContents: wc, isDestroyed: () => false, loadURL: async next => { url = next; navigations++; } }, delay: async () => { ticks++; } });
  const result = await adapter.load({ tab: 'posts', more: true, after: { id: '123', createdAt: '2026-10-19T14:59:00.000Z' } });
  assert.equal(navigations, 1); assert.equal(url, 'https://x.com/thsottiaux'); assert.ok(scrolls >= 2); assert.ok(ticks > 3); assert.equal(result.posts.some(post => post.id === '122'), true); assert.equal(result.exhausted, false); adapter.dispose();
});

test('load more without progress is bounded and stays unknown rather than exhausted', async () => {
  const wc = new EventEmitter(); let ticks = 0, scrolls = 0;
  wc.getURL = () => 'https://x.com/thsottiaux'; wc.executeJavaScript = async code => code.startsWith('window.scrollTo') ? ++scrolls : ({ posts: [{ id: '123', author: { name: 'Example', handle: 'thsottiaux' }, createdAt: '2026-10-19T14:59:00.000Z', text: '', complete: true, kind: 'post', media: [] }], accountMenu: true });
  const adapter = createDesktopXPageAdapter({ window: { webContents: wc, isDestroyed: () => false }, delay: async () => { ticks++; } });
  const result = await adapter.load({ more: true, after: { id: '123', createdAt: '2026-10-19T14:59:00.000Z' } });
  assert.equal(ticks, 30); assert.ok(scrolls > 1); assert.equal(result.exhausted, false); adapter.dispose();
});

test('current originals API projects full pages and activates then restores the hidden viewport', async () => {
  const wc = new EventEmitter(),debuggerApi = new EventEmitter(),focus=[];let url='https://x.com/thsottiaux/status/123';
  debuggerApi.isAttached=()=>false;debuggerApi.attach=()=>{};debuggerApi.detach=()=>{};
  debuggerApi.sendCommand=async(method,args)=>{
    if(method==='Emulation.setFocusEmulationEnabled')focus.push(args.enabled);
    if(method==='Network.getResponseBody')return {body:JSON.stringify({entries:[tweet('123'),tweet('122'),{cursorType:'Bottom',value:'synthetic-next'}]}),base64Encoded:false};
  };
  wc.debugger=debuggerApi;wc.getURL=()=>url;wc.executeJavaScript=async code=>code.startsWith('window.scrollTo')?undefined:{posts:[],accountMenu:true};
  const adapter=createDesktopXPageAdapter({window:{webContents:wc,isDestroyed:()=>false,loadURL:async next=>{url=next;
    for(const[operation,requestId]of [['TweetDetail','unrelated'],['UserOriginalsTimeline','originals']]){
      debuggerApi.emit('message',{},'Network.responseReceived',{response:{url:`https://x.com/i/api/graphql/synthetic/${operation}`,status:200,headers:{}},requestId});
      debuggerApi.emit('message',{},'Network.loadingFinished',{requestId,encodedDataLength:100});
    }
  }},delay:async()=>{await Promise.resolve();}});
  const result=await adapter.load({more:true,after:{id:'123',createdAt:'2026-10-19T14:59:00.000Z'}});
  assert.deepEqual(result.posts.map(post=>post.id),['123','122']);assert.equal(result.exhausted,false);assert.deepEqual(focus,[true,false]);adapter.dispose();
});

test('a cold hidden source starts its renderer before awaiting viewport activation', async () => {
  const wc=new EventEmitter(),debuggerApi=new EventEmitter();let started=false,url='',finishNavigation;
  debuggerApi.isAttached=()=>false;debuggerApi.attach=()=>{};debuggerApi.detach=()=>{};
  debuggerApi.sendCommand=async(method,args)=>{if(method==='Emulation.setFocusEmulationEnabled'&&args.enabled){assert.equal(started,true);finishNavigation();}};
  wc.debugger=debuggerApi;wc.getURL=()=>url;wc.executeJavaScript=async()=>({posts:[],empty:true,accountMenu:true});
  const adapter=createDesktopXPageAdapter({window:{webContents:wc,isDestroyed:()=>false,loadURL:next=>{started=true;url=next;return new Promise(resolve=>finishNavigation=resolve);}},delay:async()=>{}});
  assert.equal((await adapter.load()).exhausted,true);adapter.dispose();
});

test('detail waits past a cached complete card for the matching reply response', async () => {
  const wc=new EventEmitter(),debuggerApi=new EventEmitter();let ticks=0;
  debuggerApi.isAttached=()=>false;debuggerApi.attach=()=>{};debuggerApi.detach=()=>{};
  debuggerApi.sendCommand=async method=>method==='Network.getResponseBody'?{body:JSON.stringify({entries:[tweet(),tweet('124','another',{in_reply_to_status_id_str:'123'})]}),base64Encoded:false}:undefined;
  wc.debugger=debuggerApi;wc.getURL=()=> 'https://x.com/thsottiaux/status/123';wc.executeJavaScript=async()=>({posts:[{id:'123',author:{name:'Example',handle:'thsottiaux'},createdAt:'2026-10-19T14:59:00Z',text:'Cached',complete:true,kind:'post',media:[]}],accountMenu:true});
  const adapter=createDesktopXPageAdapter({window:{webContents:wc,isDestroyed:()=>false,loadURL:async()=>{}},delay:async()=>{
    if(++ticks===6){debuggerApi.emit('message',{},'Network.responseReceived',{response:{url:'https://x.com/i/api/graphql/synthetic/TweetDetail',status:200},requestId:'detail'});debuggerApi.emit('message',{},'Network.loadingFinished',{requestId:'detail',encodedDataLength:100});}await Promise.resolve();
  }});
  const result=await adapter.load({id:'123'});assert.ok(ticks>=8);assert.equal(result.posts.filter(post=>post.replyTo==='123').length,1);adapter.dispose();
});

test('a main card without reply readiness fails rather than confirming no comments', async () => {
  const wc=new EventEmitter();let ticks=0;
  wc.getURL=()=> 'https://x.com/thsottiaux/status/123';wc.executeJavaScript=async()=>({posts:[{id:'123',author:{name:'Example',handle:'thsottiaux'},createdAt:'2026-10-19T14:59:00Z',text:'Cached',complete:true,kind:'post',media:[]}],accountMenu:true});
  const adapter=createDesktopXPageAdapter({window:{webContents:wc,isDestroyed:()=>false,loadURL:async()=>{}},delay:async()=>{ticks++;}});
  await assert.rejects(adapter.load({id:'123'}),{code:'parser_changed'});assert.equal(ticks,30);adapter.dispose();
});
test('X adapter distinguishes explicit authentication challenges and ordinary parser failures', async () => {
  const wc = new EventEmitter(); wc.getURL = () => 'https://x.com/thsottiaux'; wc.executeJavaScript = async () => ({ challenge: true, posts: [] });
  const win = { webContents: wc, isDestroyed: () => false, loadURL: async () => {} };
  const adapter = createDesktopXPageAdapter({ window: win, delay: async () => {} });
  await assert.rejects(adapter.load(), { code: 'challenge' });
  wc.executeJavaScript = async () => ({ posts: [], accountMenu: true, empty: false });
  await assert.rejects(adapter.load(), { code: 'parser_changed' });
  wc.executeJavaScript = async () => ({ posts: [], accountMenu: true, empty: true });
  assert.equal((await adapter.load()).exhausted, true); adapter.dispose();
});
test('X loaded public tweet props recover lazy avatar/video without reading viewer or raw HTML', () => {
  const originalDocument = globalThis.document; const originalLocation = globalThis.location;
  const loaded = { id_str: '123', user: { name: 'Example', screen_name: 'thsottiaux', profile_image_url_https: 'https://pbs.twimg.com/profile_images/example.jpg', privateIgnored: 'must-not-project' }, full_text: 'Synthetic public post', created_at: '2026-10-19T14:59:00.000Z', entities: { media: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/media/poster.jpg', video_info: { variants: [{ content_type: 'video/mp4', bitrate: 1000, url: 'https://video.twimg.com/clip.mp4' }] } }] } };
  const article = { __reactFiber$synthetic: { memoizedProps: { tweet: loaded, viewerUser: { privateIgnored: 'must-not-project' } }, return: null } };
  globalThis.document = { querySelectorAll: () => [article], querySelector: () => null, body: { innerText: '' } }; globalThis.location = { pathname: '/thsottiaux/media' };
  try { const result = inspectXDocument(); assert.equal(result.posts.length, 1); assert.equal(result.posts[0].author.avatar, loaded.user.profile_image_url_https); assert.equal(result.posts[0].media[0].type, 'video'); assert.equal(result.posts[0].media[0].url, 'https://video.twimg.com/clip.mp4'); assert.equal(JSON.stringify(result).includes('must-not-project'), false); }
  finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation; }
});
test('X detail waits for in-flight body projection and DOM does not replace network media/avatar/replies', async () => {
  const wc = new EventEmitter(); const debuggerApi = new EventEmitter(); let bodyReady; let ticks = 0;
  debuggerApi.isAttached = () => false; debuggerApi.attach = () => {}; debuggerApi.detach = () => {}; debuggerApi.sendCommand = async method => method === 'Network.getResponseBody' ? new Promise(resolve => { bodyReady = resolve; }) : undefined; wc.debugger = debuggerApi;
  wc.getURL = () => 'https://x.com/thsottiaux/status/123'; wc.executeJavaScript = async () => ({ accountMenu: true, posts: [{ id: '123', author: { name: 'Example', handle: 'thsottiaux' }, text: 'Synthetic public post', createdAt: '2026-10-19T14:59:00.000Z', complete: true, kind: 'post', media: [] }] });
  const root = tweet('123'); root.legacy.extended_entities = { media: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/media/poster.jpg', video_info: { variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/clip.mp4' }] } }] };
  const win = { webContents: wc, isDestroyed: () => false, loadURL: async () => { debuggerApi.emit('message', {}, 'Network.responseReceived', { response: { url: 'https://x.com/i/api/graphql/synthetic/TweetDetail', status: 200, headers: {} }, requestId: 'synthetic' }); debuggerApi.emit('message', {}, 'Network.loadingFinished', { requestId: 'synthetic', encodedDataLength: 123 }); } };
  const adapter = createDesktopXPageAdapter({ window: win, delay: async () => { if (++ticks === 4) bodyReady({ body: JSON.stringify({ entries: [root, tweet('124', 'another', { in_reply_to_status_id_str: '123' })] }), base64Encoded: false }); } });
  const result = await adapter.load({ id: '123' }); assert.ok(ticks >= 6); assert.equal(result.posts.length, 2); const main = result.posts.find(post => post.id === '123'); assert.equal(main.media.length, 1); assert.ok(main.author.avatar); assert.equal(result.posts.find(post => post.id === '124').replyTo, '123'); adapter.dispose();
});
test('X static sign-in landing at a retained status URL is explicit expiry, not a parser failure', async () => {
  const originalDocument = globalThis.document; const originalLocation = globalThis.location;
  globalThis.location = { pathname: '/thsottiaux/status/123' }; let primary = false;
  globalThis.document = { body: { innerText: '使用 Google 登录' }, querySelector: selector => selector === '[data-testid="primaryColumn"]' && primary ? {} : null, querySelectorAll: selector => selector === 'button,[role="button"],a' ? [{ textContent: '登录' }, { textContent: '注册' }] : [] };
  try {
    const result = inspectXDocument(); assert.equal(result.loginRoute, false); assert.equal(result.loginLanding, true);
    const wc = new EventEmitter(); wc.getURL = () => 'https://x.com/thsottiaux/status/123'; wc.executeJavaScript = async () => result;
    const adapter = createDesktopXPageAdapter({ window: { webContents: wc, isDestroyed: () => false, loadURL: async () => {} }, delay: async () => {} });
    await assert.rejects(adapter.load({ id: '123' }), { code: 'expired' }); adapter.dispose();
    primary = true; assert.equal(inspectXDocument().loginLanding, false, 'public timeline login banners do not establish expiry');
  } finally { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument; if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation; }
});

test('X adapter cleanup tolerates an already destroyed Electron debugger and repeated disposal', () => {
  const wc = new EventEmitter(); const debuggerObject = new EventEmitter();
  debuggerObject.isAttached = () => false; debuggerObject.attach = () => {}; debuggerObject.sendCommand = async () => {};
  wc.debugger = debuggerObject;
  const adapter = createDesktopXPageAdapter({ window: { webContents: wc } });
  Object.defineProperty(wc, 'debugger', { get() { throw new Error('Object has been destroyed'); } });
  assert.doesNotThrow(() => adapter.dispose());
  assert.doesNotThrow(() => adapter.dispose());
});
