export const X_IMPORT_MAX_BYTES = 524288;
export const X_IMPORT_HOST = 'com.tibotattle.x_session_import';
export const X_IMPORT_EXTENSION_ID = 'ididcmbpmekkeindgjimhcdffbnliejo';
export const X_IMPORT_ORIGIN = `chrome-extension://${X_IMPORT_EXTENSION_ID}/`;
const invalid = () => { throw new Error('invalid_import'); };
export function normalizeXImportCookies(cookies, now = Date.now() / 1000) {
  if (!Array.isArray(cookies) || cookies.length < 1 || cookies.length > 256) invalid();
  const seen = new Set(); let auth = false, csrf = false;
  const required = ['domain', 'hostOnly', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'session', 'value'];
  const result = cookies.map(c => {
    if (!c || typeof c !== 'object' || Array.isArray(c) || required.some(k => !Object.hasOwn(c, k)) || Object.keys(c).some(k => !required.includes(k) && k !== 'expirationDate')) invalid();
    if (typeof c.domain !== 'string' || !/^\.?([a-z0-9-]+\.)*x\.com$/.test(c.domain) || c.domain.length > 253) invalid();
    if (typeof c.name !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(c.name) || typeof c.value !== 'string' || c.value.length > 16384 || /[\x00-\x20\x7f;]/.test(c.value)) invalid();
    if (typeof c.path !== 'string' || !c.path.startsWith('/') || c.path.length > 2048 || /[\x00-\x20\x7f?#]/.test(c.path) || ['hostOnly', 'httpOnly', 'secure', 'session'].some(k => typeof c[k] !== 'boolean') || !['unspecified', 'no_restriction', 'lax', 'strict'].includes(c.sameSite)) invalid();
    if ((c.hostOnly && c.domain.startsWith('.')) || (c.sameSite === 'no_restriction' && !c.secure) || (c.name.startsWith('__Secure-') && !c.secure) || (c.name.startsWith('__Host-') && (!c.secure || !c.hostOnly || c.path !== '/'))) invalid();
    if ((c.session && Object.hasOwn(c, 'expirationDate')) || (!c.session && (!Number.isFinite(c.expirationDate) || c.expirationDate <= now))) invalid();
    const key = `${c.domain}\n${c.path}\n${c.name}`; if (seen.has(key)) invalid(); seen.add(key);
    const value = { url: `https://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
    if (!c.hostOnly) value.domain = c.domain;
    if (!c.session) value.expirationDate = c.expirationDate;
    if (['x.com', '.x.com'].includes(c.domain) && c.path === '/' && c.secure && c.value) {
      if (c.name === 'auth_token') auth = true;
      if (c.name === 'ct0') csrf = true;
    }
    return value;
  });
  if (!auth || !csrf) throw new Error('no_logged_in_session');
  return result;
}
export function encodeXImportFrame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length < 2 || bytes.length > X_IMPORT_MAX_BYTES) invalid();
  const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
  return Buffer.concat([header, bytes]);
}
export function createXImportFrameReader(onValue, onFailure) {
  let pending = Buffer.alloc(0), failed = false;
  return bytes => {
    if (failed) return;
    try {
      pending = Buffer.concat([pending, bytes]);
      if (pending.length > X_IMPORT_MAX_BYTES + 4) invalid();
      while (pending.length >= 4) {
        const size = pending.readUInt32LE(0);
        if (size < 2 || size > X_IMPORT_MAX_BYTES) invalid();
        if (pending.length < size + 4) break;
        const body = pending.subarray(4, size + 4);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
        const value = JSON.parse(text);
        pending = pending.subarray(size + 4); body.fill(0);
        onValue(value);
      }
    } catch { failed = true; pending.fill(0); pending = Buffer.alloc(0); onFailure(); }
  };
}
