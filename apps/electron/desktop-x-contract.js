/** Closed, content-free control contracts for the isolated X reader. */
export const X_TARGET = 'thsottiaux';
export const X_TABS = Object.freeze(['posts', 'replies', 'reposts', 'media']);
export const X_LOGIN_STAGES = Object.freeze(['checking_bridge', 'waiting_import', 'validating', 'preparing', 'writing', 'connecting', 'verifying', 'challenge', 'saving', 'complete']);
export const X_DEFAULT_SETTINGS = Object.freeze({ refreshMinutes: 5, proxyMode: 'system', proxyPort: 10809, notifyPosts: false, notifyReplies: false });
export const X_RESOURCE_SCHEME = 'usagemonitor-x-media';
// Closed local failures: never carry a filesystem path, cookie or native message.
export const X_SESSION_ERRORS = Object.freeze(['session_write_failed', 'session_persist_failed', 'session_read_failed', 'session_decrypt_failed', 'session_restore_failed', 'session_permission_failed', 'session_profile_limit', 'session_clear_failed']);
export const X_NOTIFICATION_SEEN_LIMIT = 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function xError(code) { const error = new Error(code); error.code = code; return error; }
export function validateXSettings(value, partial = false) {
  if (!plain(value) || Object.keys(value).some(key => !Object.hasOwn(X_DEFAULT_SETTINGS, key)) || (!partial && Object.keys(X_DEFAULT_SETTINGS).some(key => !Object.hasOwn(value, key)))) throw xError('invalid_settings');
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'refreshMinutes' && !(val === -1 || Number.isSafeInteger(val) && val > 0 && val <= 2147483647)) throw xError('invalid_settings');
    if (key === 'proxyMode' && !['system', 'local'].includes(val)) throw xError('invalid_settings');
    if (key === 'proxyPort' && !(Number.isInteger(val) && val >= 1 && val <= 65535)) throw xError('invalid_settings');
    if (['notifyPosts', 'notifyReplies'].includes(key) && typeof val !== 'boolean') throw xError('invalid_settings');
    out[key] = val;
  }
  return out;
}
export function validateXId(id) { if (typeof id !== 'string' || !/^[0-9]{1,24}$/.test(id)) throw xError('invalid_post_id'); return id; }
/** Version-one arrays are migrated conservatively: no historical notifications. */
export function validateXNotificationBaseline(value, version = 2) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'posts,replies') throw xError('invalid_x_state');
  const result = {};
  for (const kind of ['posts', 'replies']) {
    const raw = value[kind];
    if (version === 1) {
      if (!Array.isArray(raw) || new Set(raw).size !== raw.length) throw xError('invalid_x_state');
      for (const id of raw) validateXId(id);
      result[kind] = { floor: raw.length ? raw.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b) : null, seen: [] };
    } else {
      if (version !== 2 || !plain(raw) || Object.keys(raw).sort().join(',') !== 'floor,seen' || !Array.isArray(raw.seen) || raw.seen.length > X_NOTIFICATION_SEEN_LIMIT || new Set(raw.seen).size !== raw.seen.length) throw xError('invalid_x_state');
      if (raw.floor !== null) validateXId(raw.floor);
      if (raw.floor === null && raw.seen.length) throw xError('invalid_x_state');
      let prior = raw.floor;
      for (const id of raw.seen) { validateXId(id); if (prior === null || BigInt(id) <= BigInt(prior)) throw xError('invalid_x_state'); prior = id; }
      result[kind] = { floor: raw.floor, seen: [...raw.seen] };
    }
  }
  return result;
}
export function validateXQuery(query = {}) {
  if (!plain(query) || Object.keys(query).some(key => !['tab', 'cursor'].includes(key)) || !X_TABS.includes(query.tab ?? 'posts') || query.cursor !== undefined && (typeof query.cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(query.cursor))) throw xError('invalid_query');
  return { tab: query.tab ?? 'posts', cursor: query.cursor };
}
export function validateXDetailQuery(query = {}) {
  if (!plain(query) || Object.keys(query).some(key => !['id', 'cursor', 'force'].includes(key)) || query.cursor !== undefined && (typeof query.cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(query.cursor)) || Object.hasOwn(query, 'force') && typeof query.force !== 'boolean' || query.force !== undefined && query.cursor !== undefined) throw xError('invalid_query');
  return { id: validateXId(query.id), cursor: query.cursor, force: query.force === true };
}
export function isXPageUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'x.com' && !url.port && !url.username && !url.password; } catch { return false; }
}
export function isXMediaUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && ['pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com'].includes(url.hostname) && !url.port && !url.username && !url.password && url.href.length <= 8192; } catch { return false; }
}
/** Convert an explicitly supplied browser export; never inspect a browser database. */
export function normalizeXCookieImport(message, nowSeconds = Date.now() / 1000) {
  if (!plain(message) || Object.keys(message).sort().join(',') !== 'cookies,type,version' || message.version !== 1 || message.type !== 'x-cookie-import' || !Array.isArray(message.cookies) || message.cookies.length < 1 || message.cookies.length > 256 || Buffer.byteLength(JSON.stringify(message)) > 524288) throw xError('invalid_import');
  const required = ['domain', 'hostOnly', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'session', 'value'];
  const seen = new Set(); const cookies = []; let auth = false; let csrf = false;
  for (const cookie of message.cookies) {
    if (!plain(cookie) || required.some(key => !Object.hasOwn(cookie, key)) || Object.keys(cookie).some(key => !required.includes(key) && key !== 'expirationDate')) throw xError('invalid_import');
    if (typeof cookie.domain !== 'string' || !/^\.?([a-z0-9-]+\.)*x\.com$/.test(cookie.domain) || cookie.domain.length > 253 || typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(cookie.name) || typeof cookie.value !== 'string' || cookie.value.length > 16384 || /[\x00-\x20\x7f;]/.test(cookie.value)) throw xError('invalid_import');
    if (typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 2048 || /[\x00-\x20\x7f?#]/.test(cookie.path) || ['hostOnly', 'httpOnly', 'secure', 'session'].some(key => typeof cookie[key] !== 'boolean') || !['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)) throw xError('invalid_import');
    if (cookie.hostOnly && cookie.domain.startsWith('.') || cookie.sameSite === 'no_restriction' && !cookie.secure || cookie.name.startsWith('__Secure-') && !cookie.secure || cookie.name.startsWith('__Host-') && (!cookie.secure || !cookie.hostOnly || cookie.path !== '/')) throw xError('invalid_import');
    if (cookie.session && Object.hasOwn(cookie, 'expirationDate') || !cookie.session && (!Number.isFinite(cookie.expirationDate) || cookie.expirationDate <= nowSeconds)) throw xError('invalid_import');
    const key = `${cookie.domain}\n${cookie.path}\n${cookie.name}`; if (seen.has(key)) throw xError('invalid_import'); seen.add(key);
    const out = { url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`, name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite };
    if (!cookie.hostOnly) out.domain = cookie.domain;
    if (!cookie.session) out.expirationDate = cookie.expirationDate;
    cookies.push(out);
    if (['x.com', '.x.com'].includes(cookie.domain) && cookie.path === '/') { if (cookie.name === 'auth_token' && cookie.value) auth = true; if (cookie.name === 'ct0' && cookie.value) csrf = true; }
  }
  if (!auth || !csrf) throw xError('no_logged_in_session');
  return cookies;
}

/** Cache validation is deliberately independent of upstream object shapes. */
export function validateXPost(value, depth = 0) {
  if (!plain(value) || depth > 1 || typeof value.id !== 'string' || !/^[0-9]{1,24}$/.test(value.id) || !plain(value.author) || typeof value.author.name !== 'string' || value.author.name.length > 160 || typeof value.author.handle !== 'string' || !/^[a-zA-Z0-9_]{1,30}$/.test(value.author.handle) || typeof value.text !== 'string' || value.text.length > 100000 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.complete !== 'boolean' || !['post', 'reply', 'repost'].includes(value.kind) || !Array.isArray(value.media) || value.media.length > 16) throw xError('invalid_post');
  const author = { name: value.author.name, handle: value.author.handle };
  if (value.author.avatar && isXMediaUrl(value.author.avatar)) author.avatar = value.author.avatar;
  const media = value.media.map((item, index) => {
    if (!plain(item) || !['image', 'video', 'gif'].includes(item.type) || !isXMediaUrl(item.url)) throw xError('invalid_post');
    const id = item.id === undefined ? String(index) : item.id;
    if (typeof id !== 'string' || !/^(?:[0-9]{1,24}|media-[0-9]{1,24})$/.test(id)) throw xError('invalid_post');
    const result = { id, type: item.type, url: item.url };
    if (item.poster && isXMediaUrl(item.poster)) result.poster = item.poster;
    if (['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'application/x-mpegURL', 'application/vnd.apple.mpegurl'].includes(item.mimeType)) result.mimeType = item.mimeType;
    return result;
  });
  if (new Set(media.map(item => item.id)).size !== media.length) throw xError('invalid_post');
  const result = { id: value.id, author, createdAt: new Date(value.createdAt).toISOString(), text: value.text, complete: value.complete, kind: value.kind, media };
  if (value.replyTo && /^[0-9]{1,24}$/.test(value.replyTo)) result.replyTo = value.replyTo;
  if (value.quotedPost && depth === 0) result.quotedPost = validateXPost(value.quotedPost, 1);
  return result;
}
