import { isXMediaUrl, isXPageUrl, validateXPost, X_TARGET, xError } from './desktop-x-contract.js';

const unwrap = value => value?.tweet ?? value?.result ?? value;
function userOf(tweet) { const user = tweet?.core?.user_results?.result; return { name: user?.core?.name ?? user?.legacy?.name, handle: user?.core?.screen_name ?? user?.legacy?.screen_name, avatar: user?.avatar?.image_url ?? user?.legacy?.profile_image_url_https }; }
function tweetPost(raw, depth = 0) {
  const tweet = unwrap(raw); const legacy = tweet?.legacy;
  if (!legacy || !tweet.rest_id) return null;
  const retweeted = unwrap(legacy.retweeted_status_result); const source = retweeted?.legacy ? retweeted : tweet;
  const body = source.legacy; const note = source.note_tweet?.note_tweet_results?.result;
  const author = userOf(source); const media = [];
  for (const item of body.extended_entities?.media ?? body.entities?.media ?? []) {
    const type = item.type === 'photo' ? 'image' : item.type === 'animated_gif' ? 'gif' : item.type === 'video' ? 'video' : null;
    if (!type) continue;
    const variants = item.video_info?.variants ?? [];
    const mp4 = variants.filter(v => v.content_type === 'video/mp4' && isXMediaUrl(v.url)).sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    const hls = variants.find(v => /mpegurl/i.test(v.content_type) && isXMediaUrl(v.url));
    const variant = mp4 ?? hls;
    const url = type === 'image' ? item.media_url_https : variant?.url;
    if (!isXMediaUrl(url)) continue;
    const upstreamId = item.id_str ?? item.rest_id;
    const id = typeof upstreamId === 'string' && /^[0-9]{1,24}$/.test(upstreamId) ? `media-${upstreamId}` : String(media.length);
    media.push({ id, type, url, ...(isXMediaUrl(item.media_url_https) ? { poster: item.media_url_https } : {}), mimeType: type === 'image' ? 'image/jpeg' : variant.content_type });
  }
  const result = { id: source.rest_id, author, createdAt: body.created_at, text: note?.text ?? body.full_text ?? '', complete: Boolean(note?.text) || !body.truncated && !source.note_tweet?.is_expandable, kind: retweeted?.legacy ? 'repost' : body.in_reply_to_status_id_str ? 'reply' : 'post', media };
  if (body.in_reply_to_status_id_str) result.replyTo = body.in_reply_to_status_id_str;
  if (depth === 0) { const quote = tweetPost(source.quoted_status_result, 1); if (quote) result.quotedPost = quote.post; }
  try { return { post: validateXPost(result), timelineHandle: userOf(tweet).handle }; } catch { return null; }
}

/** Project only tweet models from a normal timeline/detail response; omit unknown fields. */
export function projectXPageData(data, { detail = false, target = X_TARGET } = {}) {
  const posts = new Map(); let visited = 0; let recognized = false; let cursor; let ended = false;
  const walk = (node, depth = 0) => {
    if (++visited > 60000 || depth > 40 || !node || typeof node !== 'object') return;
    if (node.__typename === 'Tweet' || node.rest_id && node.legacy?.full_text !== undefined) {
      recognized = true;
      const item = tweetPost(node);
      if (item && (detail || item.timelineHandle?.toLowerCase() === target.toLowerCase())) posts.set(item.post.id, item.post);
    }
    if (node.cursorType === 'Bottom' && typeof node.value === 'string' && node.value.length <= 2048) { cursor = node.value; if (!cursor) ended = true; }
    if (node.type === 'TimelineTerminateTimeline' && node.direction === 'Bottom') ended = true;
    if (node.__typename === 'TimelineTimelineModule' || node.__typename === 'TimelineTimelineItem' || node.entryId === `user-${target}` || node.instructions || node.timeline?.instructions) recognized = true;
    for (const value of Object.values(node)) if (value && typeof value === 'object') { if (Array.isArray(value)) { for (const child of value.slice(0, 5000)) walk(child, depth + 1); } else walk(value, depth + 1); }
  };
  walk(data);
  // Missing continuation metadata is unknown, not evidence of the last page.
  return { posts: [...posts.values()], recognized, cursor, exhausted: ended && !cursor };
}

// This function executes in the remote sandbox. It returns only a narrow model,
// never HTML, cookies, storage, authentication responses, or account identifiers.
export function inspectXDocument() {
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 80);
  const posts = [];
  const mediaUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && ['pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com'].includes(url.hostname) && !url.port && !url.username && !url.password; } catch { return false; } };
  // X may reuse an already loaded timeline without another API response, and
  // hidden windows do not mount lazy <img>/<video> children. Read only the
  // public tweet prop of this article's component, never its store or viewer.
  function loadedTweet(article) {
    let fiber = article[Object.keys(article).find(key => key.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 32; depth++, fiber = fiber.return) {
      const tweet = fiber.memoizedProps?.tweet;
      if (tweet && typeof tweet === 'object' && typeof tweet.id_str === 'string' && tweet.user) return tweet;
    }
    return null;
  }
  function projectLoaded(tweet, depth = 0) {
    if (!tweet || depth > 1) return null;
    const source = tweet.retweeted_status ?? tweet; const user = source.user;
    if (!user || !source.id_str) return null;
    const media = [];
    for (const item of source.extended_entities?.media ?? source.entities?.media ?? []) {
      if (media.length >= 16) break;
      const type = item.type === 'photo' ? 'image' : item.type === 'animated_gif' ? 'gif' : item.type === 'video' ? 'video' : null;
      if (!type) continue;
      const variants = item.video_info?.variants ?? [];
      const variant = variants.filter(value => value.content_type === 'video/mp4' && mediaUrl(value.url)).sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? variants.find(value => /mpegurl/i.test(value.content_type) && mediaUrl(value.url));
      const url = type === 'image' ? item.media_url_https : variant?.url;
      if (!mediaUrl(url)) continue;
      const upstreamId = item.id_str ?? item.rest_id;
      const id = typeof upstreamId === 'string' && /^[0-9]{1,24}$/.test(upstreamId) ? `media-${upstreamId}` : String(media.length);
      media.push({ id, type, url, ...(mediaUrl(item.media_url_https) ? { poster: item.media_url_https } : {}), ...(type === 'image' ? { mimeType: 'image/jpeg' } : { mimeType: variant.content_type }) });
    }
    const note = source.note_tweet?.note_tweet_results?.result ?? source.note_tweet;
    const date = new Date(source.created_at);
    if (!Number.isFinite(date.getTime())) return null;
    const post = { id: source.id_str, author: { name: user.name, handle: user.screen_name, ...(mediaUrl(user.profile_image_url_https) ? { avatar: user.profile_image_url_https } : {}) }, createdAt: date.toISOString(), text: note?.text ?? source.full_text ?? source.text ?? '', complete: Boolean(note?.text) || !source.truncated && !source.note_tweet?.is_expandable, kind: tweet.retweeted_status ? 'repost' : source.in_reply_to_status_id_str ? 'reply' : 'post', media };
    if (source.in_reply_to_status_id_str) post.replyTo = source.in_reply_to_status_id_str;
    if (depth === 0) { const quote = projectLoaded(source.quoted_status, 1); if (quote) post.quotedPost = quote; }
    return post;
  }
  for (const article of articles) {
    const loaded = projectLoaded(loadedTweet(article));
    if (loaded) { posts.push(loaded); continue; }
    const time = article.querySelector('time[datetime]'); const href = time?.closest('a')?.getAttribute('href') ?? '';
    const match = /^\/([A-Za-z0-9_]+)\/status\/(\d+)/.exec(href); if (!match) continue;
    const authorNode = article.querySelector('[data-testid="User-Name"]');
    const name = authorNode?.querySelector('a span')?.textContent ?? match[1];
    const text = article.querySelector('[data-testid="tweetText"]')?.innerText ?? '';
    // DOM positions are display-only identities. Recovery must never treat them
    // as evidence that a newly loaded asset is the same media.
    const media = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].slice(0, 16).map((image, index) => ({ id: String(index), type: 'image', url: image.currentSrc || image.src }));
    const avatar = article.querySelector('[data-testid^="UserAvatar-Container"] img')?.src;
    // Action links point to this same post; they are not a reply relationship.
    posts.push({ id: match[2], author: { name, handle: match[1], ...(avatar ? { avatar } : {}) }, text, createdAt: time.dateTime, complete: !article.querySelector('[data-testid="tweet-text-show-more-link"]'), kind: 'post', media });
  }
  const body = document.body?.innerText ?? '';
  const accountMenu = Boolean(document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'));
  const primaryColumn = Boolean(document.querySelector('[data-testid="primaryColumn"]'));
  const controls = [...document.querySelectorAll('button,[role="button"],a')].map(element => (element.textContent ?? '').trim());
  // X can render its static sign-in landing page at a retained profile/status
  // URL. Require explicit login + signup UI and copy, not a missing marker.
  const loginLanding = !accountMenu && !primaryColumn && articles.length === 0 && controls.some(text => /^(Log in|Sign in|登录|登入)$/.test(text)) && controls.some(text => /^(Create account|Sign up|创建账号|创建账户|注册)$/.test(text)) && /Sign in to X|Log in to X|登录 X|登入 X|登录或注册|Sign in with Google|使用 Google 登录|Don.t miss what.s happening|不要错过新鲜事/.test(body);
  return { posts, accountMenu, loginRoute: /^(\/login|\/i\/flow\/login)/.test(location.pathname), loginPrompt: Boolean(document.querySelector('input[autocomplete="username"]')), loginLanding, challenge: /^\/account\/access|^\/i\/flow\/(challenge|verify)/.test(location.pathname), empty: Boolean(document.querySelector('[data-testid="emptyState"]')), failure: Boolean(document.querySelector('[data-testid="error-detail"]')) || /Something went wrong|出了点问题|出错了/.test(body), timeline: Boolean(document.querySelector('[data-testid="primaryColumn"] section[aria-labelledby], [aria-label*="Timeline"], [aria-label*="时间线"]')), postsCount: articles.length };
}

export function createDesktopXPageAdapter({ window: win, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), target = X_TARGET } = {}) {
  const wc = win.webContents; let detached = false; let pending = new Map(); let projected = new Map(); let recognized = false; let exhausted = false; let networkError; let retryAfter; let detailMode = false; let expectedOperation; let disposed = false; let loadGeneration = 0; let activeReads = 0; let revision = 0;
  const networkIds = new Set();
  const merge = (existing, incoming, preferExisting = false) => {
    if (!existing) return incoming;
    const preferred = preferExisting ? existing : incoming; const fallback = preferExisting ? incoming : existing;
    return { ...preferred, author: { ...preferred.author, ...(!preferred.author.avatar && fallback.author.avatar ? { avatar: fallback.author.avatar } : {}) }, media: preferred.media.length ? preferred.media : fallback.media, ...(!preferred.complete && fallback.complete ? { text: fallback.text, complete: true } : {}), ...(!preferred.replyTo && fallback.replyTo && fallback.replyTo !== preferred.id ? { replyTo: fallback.replyTo, kind: fallback.kind } : {}) };
  };
  const fixedNetworkError = (status, headers = {}) => {
    if (status === 429) { networkError = 'rate_limited'; const raw = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]; const parsed = Number(raw); retryAfter = Number.isFinite(parsed) ? Date.now() + Math.max(0, parsed) * 1000 : Date.parse(raw); }
    else if (status === 401) networkError = 'expired';
    else if (status >= 500) networkError = 'offline';
  };
  const network = async (_event, method, params) => {
    if (disposed || detached) return;
    if (method === 'Network.responseReceived') {
      const { response, requestId } = params;
      if (!isXPageUrl(response?.url)) return;
      const path = new URL(response.url).pathname;
      const operation = /^\/i\/api\/graphql\/[^/]+\/(UserTweets|UserOriginalsTimeline|UserTweetsAndReplies|UserMedia|TweetDetail)$/.exec(path)?.[1];
      if (!operation || !expectedOperation?.includes(operation)) return;
      fixedNetworkError(response.status, response.headers);
      if (response.status === 200 && (response.encodedDataLength ?? 0) <= 4000000 && pending.size < 24) pending.set(requestId, loadGeneration);
    }
    if (method === 'Network.loadingFinished' && pending.has(params.requestId) && params.encodedDataLength <= 4000000) {
      const requestGeneration = pending.get(params.requestId); pending.delete(params.requestId); activeReads++;
      try {
        const body = await wc.debugger.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        if (disposed || requestGeneration !== loadGeneration || body.body.length > 6000000) return;
        const json = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body);
        const result = projectXPageData(json, { detail: detailMode, target });
        for (const post of result.posts) { projected.set(post.id, merge(projected.get(post.id), post)); networkIds.add(post.id); }
        revision++;
        recognized ||= result.recognized; exhausted = result.exhausted;
        for (const error of json.errors ?? []) { if ([32, 89, 215].includes(error.code)) networkError = 'expired'; if (error.code === 88) networkError = 'rate_limited'; }
      } catch { /* Unknown response bodies remain unprojected, never logged. */ }
      finally { activeReads--; }
    }
    if (method === 'Network.loadingFailed') pending.delete(params.requestId);
  };
  if (wc.debugger && !wc.debugger.isAttached()) {
    try { wc.debugger.attach('1.3'); wc.debugger.on('message', network); void wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 8000000, maxResourceBufferSize: 4000000 }).catch(() => {}); } catch { detached = true; }
  } else detached = true;
  const assertLive = signal => { if (disposed || signal?.aborted || win.isDestroyed()) throw xError('cancelled'); };
  async function inspect(signal) {
    assertLive(signal);
    if (!isXPageUrl(wc.getURL())) throw xError('offline');
    const result = await wc.executeJavaScript(`(${inspectXDocument.toString()})()`, false);
    assertLive(signal);
    if (result.challenge) throw xError('challenge');
    if (result.loginRoute || result.loginLanding || result.loginPrompt && !result.accountMenu || networkError === 'expired') throw xError('expired');
    if (networkError) { const err = xError(networkError); if (Number.isFinite(retryAfter)) err.retryAt = retryAfter; throw err; }
    return result;
  }
  async function load({ tab = 'posts', id, signal, more = false, after } = {}) {
    assertLive(signal); loadGeneration++; detailMode = Boolean(id); pending.clear(); projected = new Map(); networkIds.clear(); recognized = false; exhausted = false; networkError = undefined; retryAfter = undefined; revision = 0;
    expectedOperation = id ? ['TweetDetail'] : tab === 'replies' ? ['UserTweetsAndReplies'] : tab === 'media' ? ['UserMedia'] : ['UserTweets', 'UserOriginalsTimeline'];
    const suffix = tab === 'replies' ? '/with_replies' : tab === 'media' ? '/media' : '';
    const url = id ? `https://x.com/${target}/status/${id}` : `https://x.com/${target}${suffix}`;
    const abort = () => { if (!win.isDestroyed()) wc.stop(); };
    signal?.addEventListener('abort', abort, { once: true });
    let activeViewport = false;
    try {
      const scroll = () => wc.executeJavaScript('window.scrollTo(0, document.documentElement.scrollHeight)', false);
      const resumeTimeline = more && wc.getURL().split('?')[0] === url;
      // Start navigation before awaiting a DevTools viewport command: a new
      // hidden BrowserWindow has no renderer context until its first load.
      let navigationFailed = false;
      const navigation = resumeTimeline ? null : win.loadURL(url).catch(() => { navigationFailed = true; });
      // Hidden Chromium pages do not deliver the viewport intersections used by
      // X's normal lazy pagination. Keep rendering active only for this read;
      // do not bring the original-site window to the foreground.
      if (!detached) { try { await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); activeViewport = true; } catch { /* DOM fallback remains bounded and must not invent an end. */ } }
      assertLive(signal);
      if (resumeTimeline) await scroll(); else await navigation;
      assertLive(signal); if (navigationFailed) throw xError('offline');
      const selected = () => [...projected.values()].filter(post => id || (tab === 'media' ? post.media.length > 0 : tab === 'reposts' ? post.kind === 'repost' : tab === 'posts' ? post.kind === 'post' : post.kind !== 'repost'));
      // The main card can mount from X's timeline cache before TweetDetail
      // returns. Its full text alone says nothing about whether replies loaded.
      const detailReady = () => networkIds.has(id) || [...projected.values()].some(post => post.replyTo === id);
      const pastAnchor = post => Date.parse(post.createdAt) < Date.parse(after.createdAt) || post.createdAt === after.createdAt && BigInt(post.id) < BigInt(after.id);
      let last; let signature; let stable = 0;
      for (let attempt = 0; attempt < 30; attempt++) {
        await delay(400); assertLive(signal); last = await inspect(signal);
        for (const raw of last.posts ?? []) { try { const post = validateXPost(raw); if (id || post.author.handle.toLowerCase() === target.toLowerCase() || tab === 'reposts' && post.kind === 'repost') projected.set(post.id, merge(projected.get(post.id), post, networkIds.has(post.id))); } catch { /* Reject malformed upstream models. */ } }
        const nextSignature = `${revision}:${projected.size}:${[...projected.values()].reduce((sum, post) => sum + post.media.length + Number(Boolean(post.author.avatar)), 0)}`;
        stable = nextSignature === signature ? stable + 1 : 0; signature = nextSignature;
        const exact = id && projected.get(id);
        const available = id ? exact?.complete && detailReady() : more && after ? selected().some(pastAnchor) || last.empty || exhausted : tab === 'media' ? selected().length > 0 || last.empty || exhausted : projected.size > 0 || last.empty || exhausted;
        if (available && pending.size === 0 && activeReads === 0 && stable >= 2) break;
        // A detail/full-text read may have navigated away from the timeline.
        // Reopen it and advance until the saved page boundary, not just until
        // its first (already cached) screen has settled. Retry stays bounded.
        if (more && !available && pending.size === 0 && activeReads === 0 && stable >= 2) { await scroll(); stable = 0; }
      }
      if (!id && projected.size === 0 && !last?.empty && !recognized) throw xError(last?.failure ? 'offline' : 'parser_changed');
      if (id && (!projected.has(id) || !detailReady())) throw xError('parser_changed');
      return { posts: selected(), exhausted: exhausted || Boolean(last?.empty), authenticated: Boolean(last?.accountMenu) };
    } finally { signal?.removeEventListener('abort', abort); if (activeViewport) { try { await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }); } catch { /* Window may have closed during cancellation. */ } } }
  }
  return { load, inspect, dispose() {
    if (disposed) return;
    disposed = true; pending.clear();
    if (!detached) {
      // Electron can destroy the WebContents before the owner's async cleanup.
      // Accessing its debugger (including removeListener) can then throw.
      try { wc.debugger.removeListener('message', network); wc.debugger.detach(); } catch { /* Window already gone. */ }
      detached = true;
    }
  } };
}
