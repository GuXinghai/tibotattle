import { randomUUID } from 'node:crypto';
import { createDesktopXPageAdapter } from './desktop-x-page-adapter.js';
import { createDesktopXSessionHealth, sessionError } from './desktop-x-session-health.js';
import { isXMediaUrl, isXPageUrl, normalizeXCookieImport, validateXId, validateXPost, validateXQuery, validateXSettings, X_DEFAULT_SETTINGS, X_RESOURCE_SCHEME, X_SESSION_ERRORS, X_TABS, xError } from './desktop-x-contract.js';

const safeErrors = new Set(['offline', 'expired', 'challenge', 'rate_limited', 'parser_changed', 'pagination_pending', 'cancelled', 'invalid_import', 'no_logged_in_session', 'import_failed', 'storage_unavailable', 'proxy_failed', ...X_SESSION_ERRORS]);
const clone = value => structuredClone(value);
const emptyLists = () => Object.fromEntries(X_TABS.map(tab => [tab, []]));
const MAX_TIMEOUT = 2147483647;
const pageSize = 30;

/** Main-process X owner. No auth state or remote content reaches diagnostics. */
export function createDesktopXService({ runtime, repository, importBridge, notify, onUpdate = () => {}, allowedOrigin = () => null, clock = () => Date.now(), timers = { setTimeout, clearTimeout }, adapterFactory = createDesktopXPageAdapter, loginTimeoutMs = 10 * 60 * 1000 } = {}) {
  let disposed = false; let generation = 0; let loginGeneration = 0; let task; let taskKey; let taskGeneration; let taskAbort; let candidate; let active; let loginReturnAuth; let timer; let timerDue; let failures = 0; let saveQueue = Promise.resolve();
  let state = { version: 1, settings: { ...X_DEFAULT_SETTINGS }, activePartition: null, authScope: null, posts: [], lists: emptyLists(), notificationBaseline: { posts: [], replies: [] } };
  let status = { auth: 'disconnected', operation: 'idle', loginMethod: null, lastUpdated: null, error: null, nextRefreshAt: null, notificationsAvailable: typeof notify === 'function' };
  let restorePromise; let settingsQueue = Promise.resolve(); let importGrantGeneration = null;
  let sessionFailure = null;
  const sessionHealth = createDesktopXSessionHealth({ runtime, repository, clock });
  const posts = new Map(); const cursors = new Map(); const resources = new Map(); const resourceKeys = new Map(); const details = new Set(); const exhausted = new Set(); const visitedTabs = new Set();
  const liveTabs = new Set(); const tabUpdatedAt = new Map(); const detailUpdatedAt = new Map();
  const mediaRecovery = new Map();
  const mediaTransfers = new Set();
  const getStatus = () => {
    const bridge = importBridge?.status?.() ?? null;
    // The existing UI polls status. Reconcile only the bridge's definite grant
    // expiry, without a timer, network inference, or recursive observer call.
    if (!disposed && !candidate && status.auth === 'authorizing' && status.loginMethod === 'session' && importGrantGeneration === loginGeneration && bridge?.code === 'import_ready' && bridge.pending === false && bridge.importing === false) {
      loginGeneration++; importGrantGeneration = null;
      status = { ...status, auth: active ? loginReturnAuth ?? 'ready' : state.activePartition ? 'expired' : 'disconnected', operation: 'error', error: 'import_failed', loginMethod: null };
      loginReturnAuth = undefined;
      if (status.auth === 'ready') queueMicrotask(() => { if (!disposed && status.auth === 'ready' && status.loginMethod === null) schedule(); });
    }
    return clone({ ...status, ...(sessionFailure ? { error: sessionFailure, operation: 'error' } : {}), cacheBytes: repository.cacheBytes ?? 0, import: bridge });
  };
  const emit = () => { if (!disposed) { try { onUpdate(getStatus()); } catch { /* UI observer is not a state owner. */ } } };
  const update = patch => {
    if (X_SESSION_ERRORS.includes(patch.error)) sessionFailure = patch.error;
    status = { ...status, ...patch, ...(sessionFailure ? { error: sessionFailure, operation: 'error' } : {}) }; emit();
  };
  const snapshot = () => ({ ...state, posts: [...posts.values()], settings: { ...state.settings }, lists: clone(state.lists), notificationBaseline: clone(state.notificationBaseline) });
  const persist = () => {
    const value = snapshot();
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      try { return await repository.write(value); }
      catch (error) { throw X_SESSION_ERRORS.includes(error?.code) ? error : xError('storage_unavailable'); }
    });
    return saveQueue;
  };
  const current = token => !disposed && token === generation;
  const cancelTimer = () => { if (timer !== undefined) timers.clearTimeout(timer); timer = undefined; timerDue = undefined; status.nextRefreshAt = null; };
  function schedule(retryAt) {
    cancelTimer();
    if (disposed || sessionFailure || status.auth !== 'ready' || state.settings.refreshMinutes === -1) return;
    const interval = state.settings.refreshMinutes * 60000 * Math.min(4, 2 ** failures);
    timerDue = Math.max(clock() + interval, Number.isFinite(retryAt) ? retryAt : 0);
    status.nextRefreshAt = new Date(timerDue).toISOString();
    const tick = () => { if (disposed) return; const remaining = timerDue - clock(); if (remaining > 0) { timer = timers.setTimeout(tick, Math.min(MAX_TIMEOUT, remaining)); timer?.unref?.(); return; } timer = undefined; void refresh({ reason: 'timer' }).catch(() => {}); };
    timer = timers.setTimeout(tick, Math.min(MAX_TIMEOUT, timerDue - clock())); timer?.unref?.(); emit();
  }
  function markFailure(error) {
    const code = safeErrors.has(error?.code) ? error.code : 'offline';
    if (code === 'cancelled') return;
    if (X_SESSION_ERRORS.includes(code)) { cancelTimer(); liveTabs.clear(); update({ operation: 'error', error: code }); return; }
    liveTabs.clear();
    failures = Math.min(2, failures + 1);
    if (code === 'expired' || code === 'challenge') { cancelTimer(); update({ auth: code, operation: 'idle', error: code }); }
    else { update({ operation: code === 'rate_limited' ? 'rate_limited' : code === 'parser_changed' ? 'parser_changed' : code === 'pagination_pending' ? 'error' : 'offline', error: code }); schedule(error?.retryAt); }
  }
  async function configureSession(session, settings = state.settings) {
    await session.setProxy(settings.proxyMode === 'local' ? { mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${settings.proxyPort}` } : { mode: 'system' });
    session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on?.('will-download', event => event.preventDefault());
  }
  async function createContext(partitionId, show = false) {
    let path;
    try { path = await repository.getSessionPath(partitionId); }
    catch (error) { throw sessionError(error, 'session_permission_failed'); }
    if (disposed) throw xError('cancelled');
    let session;
    try { session = runtime.session.fromPath(path, { cache: true }); }
    catch (error) { throw sessionError(error, 'session_read_failed'); }
    await configureSession(session);
    const win = new runtime.BrowserWindow({ width: 1120, height: 840, minWidth: 640, minHeight: 480, show, title: 'X 登录', autoHideMenuBar: true, webPreferences: { session, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false, backgroundThrottling: false } });
    win.setMenu?.(null);
    const wc = win.webContents;
    // Source-page lazy loading may activate its viewport; playback belongs only
    // to the local reader, never to this background original-site window.
    wc.setAudioMuted?.(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const restrict = (event, navigationUrl) => { if (!isXPageUrl(navigationUrl ?? event.url)) event.preventDefault(); };
    wc.on('will-navigate', restrict); wc.on('will-redirect', restrict); wc.on('will-attach-webview', event => event.preventDefault()); wc.on('page-title-updated', event => event.preventDefault());
    const adapter = adapterFactory({ window: win });
    const context = { partitionId, session, win, adapter };
    win.on('close', event => { if (candidate?.context === context) { event.preventDefault(); cancelLogin(); } else if (active === context) { event.preventDefault(); win.hide(); } });
    return context;
  }
  async function destroyContext(context, clear = false) {
    if (!context) return;
    context.adapter.dispose();
    if (!context.win.isDestroyed()) context.win.destroy();
    try { if (clear) await sessionHealth.clear(context.session, context.partitionId); else await sessionHealth.flush(context.session, context.partitionId); }
    catch (error) { const failure = sessionError(error, clear ? 'session_clear_failed' : 'session_persist_failed'); update({ error: failure.code, operation: 'error' }); throw failure; }
  }
  // Cancellation cannot become asynchronous. Cleanup failures remain visible
  // through the same sticky local error instead of an unhandled rejection.
  const discardContext = context => destroyContext(context, true).catch(error => { update({ error: error.code, operation: 'error' }); });
  const stopTask = () => { generation++; taskAbort?.abort(); taskAbort = undefined; for (const controller of mediaTransfers) controller.abort(); mediaTransfers.clear(); if (active && !active.win.isDestroyed()) active.win.webContents.stop(); };
  function registerResource(url, ownerId, role = null, trail = []) {
    if (!isXMediaUrl(url)) return undefined;
    const key = `${state.authScope ?? 'cache'}\n${ownerId}\n${url}\n${JSON.stringify([role, trail])}`;
    if (resourceKeys.has(key)) return `${X_RESOURCE_SCHEME}://resource/${resourceKeys.get(key)}`;
    const id = randomUUID(); resourceKeys.set(key, id); resources.set(id, { url, ownerId, role, trail, scope: state.authScope, recoveryAttempted: false });
    return `${X_RESOURCE_SCHEME}://resource/${id}`;
  }
  function dto(post, ownerId = post?.id) {
    if (!post) return null;
    const author = { name: post.author.name, handle: post.author.handle };
    if (post.author.avatar) author.avatar = registerResource(post.author.avatar, ownerId, { subjectId: post.id, type: 'avatar' });
    const value = { id: post.id, author, createdAt: post.createdAt, text: post.text, complete: post.complete, kind: post.kind, media: post.media.map(item => ({ id: item.id, type: item.type, src: registerResource(item.url, ownerId, { subjectId: post.id, type: 'media', mediaId: item.id, mediaType: item.type }), ...(item.poster ? { poster: registerResource(item.poster, ownerId, { subjectId: post.id, type: 'poster', mediaId: item.id, mediaType: item.type }) } : {}), ...(item.mimeType ? { mimeType: item.mimeType } : {}) })) };
    if (post.replyTo) value.replyTo = post.replyTo;
    if (post.quotedPost) value.quotedPost = dto(post.quotedPost, ownerId);
    return value;
  }
  function cacheResults(result, tab) {
    for (const raw of result.posts) { const post = validateXPost(raw); const before = posts.get(post.id); if (before?.complete && !post.complete) continue; posts.set(post.id, post); }
    if (tab) {
      const ids = new Set(state.lists[tab]);
      for (const post of result.posts) ids.add(post.id);
      state.lists[tab] = [...ids].filter(id => posts.has(id)).sort((a, b) => Date.parse(posts.get(b).createdAt) - Date.parse(posts.get(a).createdAt) || (BigInt(a) > BigInt(b) ? -1 : 1));
      if (result.exhausted) exhausted.add(tab); else exhausted.delete(tab);
      liveTabs.add(tab); tabUpdatedAt.set(tab, new Date(clock()).toISOString());
    }
  }
  async function runTask(work, { scheduleAfter = true, key = 'refresh', silent = false } = {}) {
    if (task) { if (taskKey === key && taskGeneration === generation) return task; await task; if (disposed) return null; return runTask(work, { scheduleAfter, key, silent }); }
    const token = generation; const controller = new AbortController(); taskAbort = controller;
    if (!silent) update({ operation: 'loading', error: null });
    taskKey = key; taskGeneration = token;
    task = (async () => { try {
      const result = await work(controller.signal, token);
      if (!current(token) || controller.signal.aborted) throw xError('cancelled');
      if (!silent && active) { await sessionHealth.verify(active.session, active.partitionId); await sessionHealth.flush(active.session, active.partitionId); }
      if (!current(token) || controller.signal.aborted) throw xError('cancelled');
      if (!silent) { sessionFailure = null; failures = 0; update({ operation: 'idle', lastUpdated: new Date(clock()).toISOString(), error: null }); if (scheduleAfter) schedule(); }
      return result;
    } catch (error) { if (current(token) && (!silent || X_SESSION_ERRORS.includes(error?.code))) { if (status.auth === 'restoring') update({ auth: 'ready' }); markFailure(error); } return null; } finally { if (taskAbort === controller) taskAbort = undefined; task = undefined; taskKey = undefined; } })();
    return task;
  }
  async function notifyNew(result, observedKinds = ['posts', 'replies']) {
    const counts = { posts: 0, replies: 0 }; let latestId = null;
    const observedIds = result.posts.filter(post => post.author.handle.toLowerCase() === 'thsottiaux' && post.kind !== 'repost').map(post => post.id);
    for (const kind of ['posts', 'replies']) {
      if (!observedKinds.includes(kind)) continue;
      const ids = [...new Set(result.posts.filter(post => post.author.handle.toLowerCase() === 'thsottiaux' && post.kind === (kind === 'posts' ? 'post' : 'reply')).map(post => post.id))];
      const prior = new Set(state.notificationBaseline[kind]); const initialized = prior.has('0');
      const watermark = [...prior].reduce((maximum, id) => BigInt(id) > maximum ? BigInt(id) : maximum, 0n);
      if (initialized && state.settings[kind === 'posts' ? 'notifyPosts' : 'notifyReplies']) for (const id of ids) if (!prior.has(id) && BigInt(id) > watermark) { counts[kind]++; if (!latestId || BigInt(id) > BigInt(latestId)) latestId = id; }
      state.notificationBaseline[kind] = [...new Set(['0', ...prior, ...observedIds])];
    }
    // Persist the dedup state before displaying; a failed write cannot generate duplicates.
    await persist();
    if ((counts.posts || counts.replies) && typeof notify === 'function') await Promise.resolve().then(() => notify({ posts: counts.posts, replies: counts.replies, latestId })).catch(() => {});
  }
  async function refresh({ tab, reason = 'manual' } = {}) {
    await ready;
    if (disposed || !active || status.auth !== 'ready') return { status: getStatus() };
    if (tab !== undefined && !X_TABS.includes(tab)) throw xError('invalid_query');
    await runTask(async (signal, token) => {
      const tabs = tab ? [tab] : ['posts', 'replies']; const combined = [];
      for (const targetTab of tabs) {
        const result = await active.adapter.load({ tab: targetTab, signal });
        if (!current(token)) throw xError('cancelled');
        cacheResults(result, targetTab); combined.push(...result.posts);
      }
      if (!tab || ['posts', 'replies'].includes(tab)) await notifyNew({ posts: combined }, tab === 'posts' ? ['posts'] : ['posts', 'replies']); else await persist();
      return true;
    }, { key: `refresh:${tab ?? 'all'}` });
    return { status: getStatus(), reason };
  }
  function cancelLogin() {
    loginGeneration++; importGrantGeneration = null;
    importBridge?.cancel?.();
    const old = candidate; candidate = undefined;
    if (old) { old.cancelled = true; timers.clearTimeout(old.timer); if (old.context !== active) void discardContext(old.context); else old.context.win.hide(); }
    update({ auth: active ? loginReturnAuth ?? 'ready' : state.activePartition ? 'expired' : 'disconnected', loginMethod: null, operation: 'idle', error: null }); loginReturnAuth = undefined;
    if (active) schedule();
    return getStatus();
  }
  async function promote(context, attempt) {
    if (disposed || attempt !== loginGeneration || candidate?.context !== context) throw xError('cancelled');
    await sessionHealth.verify(context.session, context.partitionId);
    await sessionHealth.checkpoint(context.session, context.partitionId);
    if (disposed || attempt !== loginGeneration || candidate?.context !== context) throw xError('cancelled');
    const oldActive = active; const oldState = snapshot();
    state.activePartition = context.partitionId; state.authScope = randomUUID(); state.notificationBaseline = { posts: [], replies: [] };
    posts.clear(); state.posts = []; state.lists = emptyLists();
    const restorePrevious = () => { const settings = state.settings; state = { ...oldState, settings }; posts.clear(); for (const post of oldState.posts) posts.set(post.id, post); };
    try { await persist(); } catch { restorePrevious(); throw xError('storage_unavailable'); }
    if (disposed || attempt !== loginGeneration) { if (state.activePartition === context.partitionId) { restorePrevious(); await persist(); } throw xError('cancelled'); }
    active = context; candidate = undefined; stopTask(); resources.clear(); resourceKeys.clear(); cursors.clear(); details.clear(); liveTabs.clear(); tabUpdatedAt.clear(); detailUpdatedAt.clear();
    loginReturnAuth = undefined;
    context.win.hide(); sessionFailure = null;
    if (oldActive && oldActive !== context) await discardContext(oldActive);
    update({ auth: 'ready', operation: 'idle', loginMethod: null, error: null }); schedule();
    queueMicrotask(() => { void refresh({ reason: 'login' }); });
    return getStatus();
  }
  async function awaitAuthentication(context, attempt, { navigate = true } = {}) {
    if (navigate) {
      try { await context.win.loadURL('https://x.com/home'); }
      catch { throw xError(disposed || attempt !== loginGeneration ? 'cancelled' : 'offline'); }
    }
    const start = clock();
    while (!disposed && attempt === loginGeneration && candidate?.context === context && clock() - start < loginTimeoutMs) {
      try {
        const check = await context.adapter.inspect();
        if (check.accountMenu) return await promote(context, attempt);
      } catch (error) { if (X_SESSION_ERRORS.includes(error?.code) || error?.code === 'storage_unavailable' || error?.code === 'cancelled') throw error; if (error.code === 'challenge') update({ auth: 'challenge', operation: 'idle', error: 'challenge' }); }
      await new Promise(resolve => { const handle = timers.setTimeout(resolve, 1000); handle?.unref?.(); });
    }
    throw xError(attempt === loginGeneration ? 'import_failed' : 'cancelled');
  }
  async function startCandidate(attempt, show) {
    const context = await createContext(randomUUID(), show);
    if (disposed || attempt !== loginGeneration) { await destroyContext(context, true); throw xError('cancelled'); }
    candidate = { attempt, context };
    return context;
  }
  async function beginLogin({ method } = {}) {
    await ready;
    if (!['web', 'session'].includes(method)) throw xError('invalid_login_method');
    if (method === 'web' && status.auth === 'challenge' && candidate?.context) {
      candidate.context.win.show();
      update({ auth: 'authorizing', loginMethod: 'web', operation: 'idle', error: null });
      return getStatus();
    }
    const challengeContext = method === 'web' && status.auth === 'challenge' ? active : undefined;
    const previousAuth = ['expired', 'challenge'].includes(status.auth) ? status.auth : 'ready';
    cancelLogin(); stopTask(); cancelTimer(); const attempt = ++loginGeneration;
    loginReturnAuth = previousAuth;
    update({ auth: 'authorizing', operation: 'idle', loginMethod: method, error: null });
    if (method === 'session') {
      try { const bridge = await importBridge?.begin?.(); if (!bridge) throw xError('import_failed'); if (attempt === loginGeneration && bridge.code === 'import_ready' && bridge.pending === true) importGrantGeneration = attempt; return { ...getStatus(), bridge }; } catch { if (attempt === loginGeneration) update({ auth: active ? 'ready' : 'disconnected', error: 'import_failed', loginMethod: null }); return getStatus(); }
    }
    void (async () => {
      try { const context = challengeContext ?? await startCandidate(attempt, true); if (challengeContext) { candidate = { attempt, context }; context.win.show(); } await awaitAuthentication(context, attempt, { navigate: !challengeContext }); }
      catch (error) { if (attempt === loginGeneration && !disposed) { const old = candidate; candidate = undefined; if (old && old.context !== active) await discardContext(old.context); else old?.context.win.hide(); update({ auth: active ? 'ready' : 'disconnected', operation: 'idle', loginMethod: null, error: safeErrors.has(error.code) ? error.code : 'import_failed' }); if (active) schedule(); } }
    })();
    return getStatus();
  }
  async function importCookies(cookieSetters, permit) {
    await ready;
    if (disposed || status.loginMethod !== 'session' || status.auth !== 'authorizing' || candidate) throw xError('import_not_requested');
    const attempt = loginGeneration;
    // Revalidate trusted bridge output at the session mutation boundary.
    const wire = { version: 1, type: 'x-cookie-import', cookies: cookieSetters.map(cookie => ({ domain: cookie.domain ?? new URL(cookie.url).hostname, hostOnly: !Object.hasOwn(cookie, 'domain'), httpOnly: cookie.httpOnly, name: cookie.name, path: cookie.path, sameSite: cookie.sameSite, secure: cookie.secure, session: !Object.hasOwn(cookie, 'expirationDate'), value: cookie.value, ...(Object.hasOwn(cookie, 'expirationDate') ? { expirationDate: cookie.expirationDate } : {}) })) };
    const cookies = normalizeXCookieImport(wire, clock() / 1000); wire.cookies.length = 0;
    let context;
    try {
      context = await startCandidate(attempt, false);
      for (const cookie of cookies) { if (attempt !== loginGeneration || disposed || permit?.isCurrent?.() === false || permit?.isValid?.() === false) throw xError('cancelled'); try { await context.session.cookies.set(cookie); } catch (error) { throw sessionError(error, 'session_write_failed'); } }
      const actual = await sessionHealth.readCookies(context.session, { domain: 'x.com' });
      if (!cookies.every(cookie => actual.some(item => item.name === cookie.name && item.path === cookie.path && item.value === cookie.value && item.secure === cookie.secure && item.httpOnly === cookie.httpOnly && item.sameSite === cookie.sameSite && item.hostOnly === !Object.hasOwn(cookie, 'domain') && (!Object.hasOwn(cookie, 'expirationDate') || Math.abs(item.expirationDate - cookie.expirationDate) < 2)))) throw xError('session_write_failed');
      cookies.length = 0; actual.length = 0;
      // Acknowledge delivery independently of X's verification time. The native
      // bridge has a short transport timeout; only the UI check can promote.
      const deadline = timers.setTimeout(() => { if (attempt === loginGeneration && candidate?.context === context) context.win.show(); }, 12000); deadline?.unref?.();
      void awaitAuthentication(context, attempt).catch(async error => {
        if (candidate?.context === context) candidate = undefined;
        if (active !== context) await discardContext(context);
        if (attempt === loginGeneration && !disposed) { update({ auth: active ? loginReturnAuth ?? 'ready' : 'disconnected', loginMethod: null, error: safeErrors.has(error.code) ? error.code : 'import_failed' }); loginReturnAuth = undefined; if (active) schedule(); }
      }).finally(() => { timers.clearTimeout(deadline); });
      return { ok: true, code: 'verification_pending' };
    } catch (error) { cookies.length = 0; if (candidate?.context === context) candidate = undefined; if (context && active !== context) await discardContext(context); if (attempt === loginGeneration && !disposed) { update({ auth: active ? 'ready' : 'disconnected', loginMethod: null, error: safeErrors.has(error.code) ? error.code : 'import_failed' }); if (active) schedule(); } throw xError(safeErrors.has(error.code) ? error.code : 'import_failed'); }
  }
  async function listPosts(query = {}) {
    const { tab, cursor } = validateXQuery(query); await ready;
    const firstVisit = !cursor && !visitedTabs.has(tab); if (!cursor) visitedTabs.add(tab);
    let after;
    if (cursor) { const position = cursors.get(cursor); if (!position || position.tab !== tab || position.scope !== state.authScope || !state.lists[tab].includes(position.afterId)) throw xError('invalid_cursor'); after = posts.get(position.afterId); }
    const pageOffset = () => after ? state.lists[tab].indexOf(after.id) + 1 : 0;
    let offset = pageOffset();
    const cached = state.lists[tab].length > offset;
    const visitGeneration = generation; const visitScope = state.authScope;
    if (cached && firstVisit) queueMicrotask(() => { void Promise.resolve(restorePromise).then(() => { if (current(visitGeneration) && state.authScope === visitScope && status.auth === 'ready') return refresh({ tab, reason: 'visit' }); }).catch(() => {}); });
    if (active && status.auth === 'ready' && (!cached || !state.lists[tab].length) && !(cursor && exhausted.has(tab))) await runTask(async (signal, token) => {
      const result = await active.adapter.load({ tab, signal, more: Boolean(cursor), ...(after ? { after: { id: after.id, createdAt: after.createdAt } } : {}) }); if (!current(token)) throw xError('cancelled'); cacheResults(result, tab); await persist();
      if (after && state.lists[tab].length <= pageOffset() && !exhausted.has(tab)) throw xError('pagination_pending');
    }, { key: `list:${tab}:${cursor ?? 'first'}` });
    offset = pageOffset();
    const ids = state.lists[tab].slice(offset, offset + pageSize); const items = ids.map(id => dto(posts.get(id))).filter(Boolean); const hasMore = offset + items.length < state.lists[tab].length || !exhausted.has(tab) && status.auth === 'ready';
    let next = null;
    if (hasMore && items.length) { next = randomUUID(); if (cursors.size > 2000) cursors.delete(cursors.keys().next().value); cursors.set(next, { tab, afterId: items.at(-1).id, scope: state.authScope }); }
    else if (cursor && !items.length && !exhausted.has(tab)) next = cursor;
    const updatedAt = tabUpdatedAt.get(tab) ?? null;
    return { items, nextCursor: next, hasMore: Boolean(next), source: liveTabs.has(tab) ? 'live' : 'cache', status: { ...getStatus(), lastUpdated: updatedAt }, updatedAt };
  }
  async function getPost({ id } = {}) {
    validateXId(id); await ready;
    const detailAge = clock() - Date.parse(detailUpdatedAt.get(id) ?? '');
    if (active && status.auth === 'ready' && (!details.has(id) || !posts.get(id)?.complete || !Number.isFinite(detailAge) || detailAge >= 60000)) await runTask(async (signal, token) => { const result = await active.adapter.load({ id, signal }); if (!current(token)) throw xError('cancelled'); cacheResults(result); details.add(id); detailUpdatedAt.set(id, new Date(clock()).toISOString()); await persist(); }, { key: `detail:${id}` });
    const post = dto(posts.get(id)); const replies = [...posts.values()].filter(value => value.replyTo === id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map(value => dto(value));
    const updatedAt = detailUpdatedAt.get(id) ?? null;
    return { post, replies, source: details.has(id) && status.auth === 'ready' && status.operation === 'idle' ? 'live' : 'cache', status: { ...getStatus(), lastUpdated: updatedAt }, updatedAt };
  }
  async function applySettings(patch) {
    await ready; const next = { ...state.settings, ...validateXSettings(patch, true) }; const previous = state.settings;
    if (disposed) throw xError('cancelled');
    const proxyChanged = next.proxyMode !== previous.proxyMode || next.proxyPort !== previous.proxyPort;
    const previousBaseline = clone(state.notificationBaseline);
    if (proxyChanged) {
      stopTask(); cancelLogin(); cancelTimer();
      if (active) {
        try { await active.session.closeAllConnections(); await configureSession(active.session, next); }
        catch { await configureSession(active.session, previous).catch(() => {}); schedule(); update({ error: 'proxy_failed', operation: 'error' }); throw xError('proxy_failed'); }
      }
    }
    state.settings = next;
    for (const kind of ['Posts', 'Replies']) if (next[`notify${kind}`] !== previous[`notify${kind}`]) state.notificationBaseline[kind.toLowerCase()] = [];
    try { await persist(); }
    catch { state.settings = previous; state.notificationBaseline = previousBaseline; if (proxyChanged && active) await configureSession(active.session, previous).catch(() => {}); schedule(); throw xError('storage_unavailable'); }
    if (proxyChanged && active) queueMicrotask(() => { void refresh({ reason: 'proxy' }); });
    schedule(); emit(); return clone(state.settings);
  }
  function setSettings(patch) { const validated = validateXSettings(patch, true); const work = settingsQueue.catch(() => {}).then(() => applySettings(validated)); settingsQueue = work; return work; }
  async function logout() {
    await ready; cancelLogin(); stopTask(); cancelTimer(); const old = active;
    try { await destroyContext(old, true); }
    catch (error) { markFailure(error); throw error; }
    active = undefined; state.activePartition = null; state.authScope = null; state.notificationBaseline = { posts: [], replies: [] }; resources.clear(); resourceKeys.clear(); cursors.clear(); details.clear(); liveTabs.clear(); tabUpdatedAt.clear(); detailUpdatedAt.clear();
    try { await persist(); } catch (error) { const failure = sessionError(error, 'session_persist_failed'); markFailure(failure); throw failure; }
    sessionFailure = null; update({ auth: 'disconnected', operation: 'idle', error: null, loginMethod: null }); return getStatus();
  }
  async function clearCache() {
    await ready; stopTask(); posts.clear(); state.posts = []; state.lists = emptyLists(); resources.clear(); resourceKeys.clear(); cursors.clear(); details.clear(); exhausted.clear(); liveTabs.clear(); tabUpdatedAt.clear(); detailUpdatedAt.clear();
    await saveQueue.catch(() => {}); await repository.clearCache(); await persist(); update({ ...(status.auth === 'restoring' && active ? { auth: 'ready' } : {}), operation: 'idle', error: null }); schedule(); return getStatus();
  }
  async function readPlaylist(response) {
    if (Number(response.headers.get('content-length') ?? 0) > 2000000 || !response.body) return null;
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2000000) { await reader.cancel(); return null; } chunks.push(part.value); }
    const text = Buffer.concat(chunks).toString('utf8'); return text.startsWith('#EXTM3U') ? text : null;
  }
  async function recoverMedia(reference, token, failedUrl, signal) {
    if (!current(token) || reference.scope !== state.authScope || !active || status.auth !== 'ready') return false;
    if (reference.url !== failedUrl) return true;
    if (reference.recoveryPromise) return reference.recoveryPromise;
    if (reference.recoveryAttempted || !reference.role || reference.trail.length > 3) return false;
    reference.recoveryAttempted = true;
    reference.recoveryPromise = (async () => {
      const key = `${token}:${reference.scope}:${reference.ownerId}`;
      let recovery = mediaRecovery.get(key);
      if (!recovery) {
        recovery = { promise: null, users: 0 };
        recovery.promise = runTask(async (requestSignal, taskToken) => {
          if (!current(token) || taskToken !== token || status.auth !== 'ready' || !posts.has(reference.ownerId)) throw xError('cancelled');
          const result = await active.adapter.load({ id: reference.ownerId, signal: requestSignal });
          if (!current(token) || reference.scope !== state.authScope) throw xError('cancelled');
          const fresh = result.posts.find(post => post.id === reference.ownerId); if (!fresh) return null;
          cacheResults(result); await persist(); return fresh;
        }, { key: `media:${key}`, silent: true, scheduleAfter: false });
        mediaRecovery.set(key, recovery);
      }
      recovery.users++;
      try {
      const fresh = await recovery.promise;
      if (!fresh || !current(token) || reference.scope !== state.authScope || signal?.aborted) return false;
      const subject = fresh.id === reference.role.subjectId ? fresh : fresh.quotedPost?.id === reference.role.subjectId ? fresh.quotedPost : null;
      if (!subject) return false;
      const item = subject.media.find(media => media.id === reference.role.mediaId && media.type === reference.role.mediaType);
      let url = reference.role.type === 'avatar' ? subject.author.avatar : reference.role.type === 'poster' ? item?.poster : item?.url;
      if (!isXMediaUrl(url)) return false;
      // VOD child playlists/segments retain their position in the validated
      // parent playlist; resolve the same position from the refreshed root.
      for (const step of reference.trail) {
        if (!current(token) || signal?.aborted) return false;
        const controller = new AbortController(); let text;
        try {
          const response = await active.session.fetch(url, { signal: AbortSignal.any([signal, controller.signal]), redirect: 'error', credentials: 'omit' });
          if (response.status !== 200) return false;
          text = await readPlaylist(response); if (!text) return false;
        } finally { controller.abort(); }
        const line = text.split(/\r?\n/)[step.line]; if (!line) return false;
        const raw = step.attribute === null ? !line.startsWith('#') && line.trim() : [...line.matchAll(/URI="([^"]+)"/g)][step.attribute]?.[1];
        if (!raw) return false;
        const resolved = new URL(raw, url); if (!isXMediaUrl(resolved.href) || resolved.hostname !== new URL(url).hostname) return false;
        url = resolved.href;
      }
      if (!current(token) || reference.scope !== state.authScope || signal?.aborted) return false;
      reference.url = url; return true;
      } finally { recovery.users--; if (recovery.users === 0 && mediaRecovery.get(key) === recovery) mediaRecovery.delete(key); }
    })().catch(() => false).finally(() => { reference.recoveryPromise = undefined; });
    return reference.recoveryPromise;
  }
  async function resourceHandler(request) {
    let origin;
    try { const supplied = typeof allowedOrigin === 'function' ? allowedOrigin() : allowedOrigin; const parsed = new URL(supplied); if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.origin !== supplied) throw xError('invalid_origin'); origin = parsed.origin; } catch { return new Response(null, { status: 503 }); }
    // Images can omit Origin under the dashboard's no-referrer policy. Their
    // random capability remains required; CORS grants only the trusted origin.
    const requestOrigin = request.headers?.get?.('origin');
    if (requestOrigin && requestOrigin !== origin) return new Response(null, { status: 403 });
    let reference;
    try { const url = new URL(request.url); if (url.protocol !== `${X_RESOURCE_SCHEME}:` || url.hostname !== 'resource' || url.search || url.hash || !/^\/[a-f0-9-]{36}$/.test(url.pathname)) throw xError('invalid_resource'); reference = resources.get(url.pathname.slice(1)); } catch { return new Response(null, { status: 404 }); }
    if (!reference || !posts.has(reference.ownerId) || reference.scope !== state.authScope || !isXMediaUrl(reference.url) || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
    const resourceGeneration = generation;
    const transfer = new AbortController(); mediaTransfers.add(transfer);
    const signal = AbortSignal.any([request.signal, transfer.signal]);
    let upstream; let response; let streaming = false;
    const release = () => { mediaTransfers.delete(transfer); upstream?.abort(); };
    try {
      const fetcher = active?.session?.fetch?.bind(active.session);
      if (!fetcher) return new Response(null, { status: 503 });
      const headers = {}; const range = request.headers?.get?.('range'); if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
      const fetchMedia = async url => { upstream = new AbortController(); return fetcher(url, { method: request.method, headers, signal: AbortSignal.any([signal, upstream.signal]), redirect: 'error', credentials: 'omit' }); };
      const attemptedUrl = reference.url;
      response = await fetchMedia(attemptedUrl);
      if ([403, 404, 410].includes(response.status)) {
        upstream.abort();
        await response.body?.cancel().catch(() => {});
        if (await recoverMedia(reference, resourceGeneration, attemptedUrl, signal)) response = await fetchMedia(reference.url);
      }
      if (!current(resourceGeneration) || reference.scope !== state.authScope) { await response.body?.cancel().catch(() => {}); return new Response(null, { status: 404 }); }
      if (![200, 206].includes(response.status)) return new Response(null, { status: response.status === 416 ? 416 : 502 });
      const type = response.headers.get('content-type') ?? '';
      const outputHeaders = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
      for (const key of ['content-length', 'content-range', 'accept-ranges']) if (response.headers.has(key)) outputHeaders[key] = response.headers.get(key);
      if (request.method === 'HEAD') return new Response(null, { status: response.status, headers: outputHeaders });
      if (/mpegurl/i.test(type) || new URL(reference.url).pathname.endsWith('.m3u8')) {
        const text = await readPlaylist(response); if (!text) return new Response(null, { status: 502 });
        const convert = (raw, line, attribute) => { const url = new URL(raw, reference.url); if (!isXMediaUrl(url.href) || url.hostname !== new URL(reference.url).hostname || reference.trail.length >= 3) throw xError('invalid_resource'); return registerResource(url.href, reference.ownerId, reference.role, [...reference.trail, { line, attribute }]); };
        const rewritten = text.split(/\r?\n/).map((line, index) => { let attribute = 0; return line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_all, raw) => `URI="${convert(raw, index, attribute++)}"`) : line.trim() ? convert(line.trim(), index, null) : line; }).join('\n');
        delete outputHeaders['content-length']; outputHeaders['Content-Type'] = 'application/vnd.apple.mpegurl'; return new Response(rewritten, { status: 200, headers: outputHeaders });
      }
      if (!/^(image\/(jpeg|png|webp|gif|avif)|video\/mp4|audio\/|application\/octet-stream|video\/mp2t)/i.test(type)) return new Response(null, { status: 502 });
      if (!response.body) return new Response(null, { status: response.status, headers: outputHeaders });
      const reader = response.body.getReader();
      // Electron 43 does not abort protocol Request.signal when a video seeks
      // or is removed. Cancelling net.fetch's body alone also leaves its native
      // request open, so explicitly abort it when the protocol stream is closed.
      const body = new ReadableStream({
        async pull(controller) {
          try { const part = await reader.read(); if (part.done) { release(); controller.close(); } else controller.enqueue(part.value); }
          catch (error) { release(); controller.error(error); }
        },
        cancel(reason) { release(); return reader.cancel(reason).catch(() => {}); },
      });
      const result = new Response(body, { status: response.status, headers: outputHeaders }); streaming = true; return result;
    } catch { return new Response(null, { status: 502 }); }
    finally { if (!streaming) { release(); await response?.body?.cancel().catch(() => {}); } }
  }
  const resume = () => { if (status.auth === 'ready' && state.settings.refreshMinutes !== -1 && (!timerDue || timerDue <= clock())) { cancelTimer(); void refresh({ reason: 'resume' }); } };
  runtime.powerMonitor?.on?.('resume', resume);
  async function restore() {
    if (!state.activePartition || disposed) return;
    const token = generation;
    update({ auth: 'restoring' });
    let context;
    try {
      context = await createContext(state.activePartition);
      if (!current(token)) { await destroyContext(context); return; }
      const hasCheckpoint = await sessionHealth.verify(context.session, context.partitionId);
      if (!current(token)) { await destroyContext(context); return; }
      if (!hasCheckpoint) await sessionHealth.checkpoint(context.session, context.partitionId);
      if (!current(token)) { await destroyContext(context); return; }
      active = context;
      sessionFailure = null;
      if (state.settings.refreshMinutes === -1) { update({ auth: 'ready', operation: 'idle', error: null }); return; }
      await runTask(async signal => {
        const result = await context.adapter.load({ tab: 'replies', signal });
        if (!current(token)) throw xError('cancelled');
        // Absence of a DOM marker is not proof of logout. Only the adapter's
        // explicit login route / authenticated API rejection can expire state.
        if (!result.authenticated) throw xError('parser_changed');
        cacheResults(result, 'replies'); update({ auth: 'ready' }); await notifyNew(result);
      }, { key: 'restore' });
      if (current(token) && status.auth === 'restoring') { update({ auth: 'ready' }); schedule(); }
    } catch (error) {
      if (context && active !== context) { context.adapter.dispose(); if (!context.win.isDestroyed()) context.win.destroy(); }
      if (current(token)) { update({ auth: active ? 'ready' : 'disconnected' }); markFailure(error); }
    }
  }
  const ready = (async () => {
    try {
      const saved = await repository.read(); if (disposed) return;
      if (saved) { state = { ...state, ...saved, settings: { ...X_DEFAULT_SETTINGS, ...validateXSettings(saved.settings) } }; for (const raw of saved.posts ?? []) { const post = validateXPost(raw); posts.set(post.id, post); } }
      if (state.activePartition) queueMicrotask(() => { restorePromise = restore(); });
      emit();
    } catch { update({ auth: 'disconnected', operation: 'error', error: 'storage_unavailable' }); }
  })();
  return { ready, getStatus, status: getStatus, settings: () => clone(state.settings), getSettings: async () => { await ready; return { settings: clone(state.settings), cacheBytes: repository.cacheBytes ?? 0 }; }, setSettings, listPosts, getPost, refresh, beginLogin, cancelLogin, importCookies, logout, clearCache, resourceHandler, resume,
    inspectRuntime: () => ({ activeWebContentsId: active?.win.webContents.id ?? null, candidateWebContentsId: candidate?.context.win.webContents.id ?? null, status: getStatus() }),
    async dispose() {
      if (disposed) return; disposed = true; cancelTimer(); stopTask(); loginGeneration++; importBridge?.cancel?.(); runtime.powerMonitor?.removeListener?.('resume', resume);
      const a = active; const c = candidate?.context; active = undefined; candidate = undefined;
      const results = await Promise.allSettled([destroyContext(a), c === a ? Promise.resolve() : destroyContext(c, true), saveQueue]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) { const error = sessionError(failure.reason, 'session_persist_failed'); update({ error: error.code, operation: 'error' }); disposed = true; throw error; }
      disposed = true;
    },
  };
}
