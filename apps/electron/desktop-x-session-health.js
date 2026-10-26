import { createHash, randomBytes } from 'node:crypto';
import { X_SESSION_ERRORS, xError } from './desktop-x-contract.js';

const probeUrl = 'https://session-check.invalid/';
const probeName = '__Host-UsageMonitorPersistence';
const digest = value => createHash('sha256').update(value).digest('hex');
export function sessionError(error, fallback) {
  const failure = xError(X_SESSION_ERRORS.includes(error?.code) ? error.code : fallback);
  if (error && typeof error === 'object') Object.defineProperty(failure, 'cause', { value: error });
  return failure;
}

/** A synthetic, non-authentication cookie detects Chromium's otherwise silent
 * restore failure. Only its digest is stored outside the encrypted cookie DB.
 * A missing marker cannot distinguish SQLite/read/decrypt failure; never label
 * that case as proven decryption failure or upstream session expiry. */
export function createDesktopXSessionHealth({ runtime, repository, clock = Date.now }) {
  const encryption = () => {
    try { if (typeof runtime.safeStorage?.isEncryptionAvailable !== 'function' || runtime.safeStorage.isEncryptionAvailable() !== true) throw xError('session_decrypt_failed'); }
    catch { throw xError('session_decrypt_failed'); }
  };
  async function access(id) {
    try { return await repository.checkSessionHealth(id); }
    catch (error) { throw sessionError(error, 'session_permission_failed'); }
  }
  async function readCookies(session, filter) {
    encryption();
    try { return await session.cookies.get(filter); }
    catch (error) { throw sessionError(error, 'session_read_failed'); }
  }
  async function flush(session, id) {
    encryption();
    try { await session.cookies.flushStore(); }
    catch (error) { throw sessionError(error, 'session_persist_failed'); }
    const disk = await access(id);
    if (!disk?.cookieDatabasePresent || !Number.isSafeInteger(disk.cookieDatabaseBytes) || disk.cookieDatabaseBytes <= 0) throw xError('session_persist_failed');
  }
  async function verify(session, id) {
    await access(id);
    encryption();
    let checkpoint;
    try { checkpoint = await repository.readSessionCheckpoint(id); }
    catch (error) { throw sessionError(error, 'session_read_failed'); }
    if (checkpoint) {
      const cookies = await readCookies(session, { url: probeUrl });
      if (!cookies.some(cookie => cookie.name === probeName && typeof cookie.value === 'string' && digest(cookie.value) === checkpoint.digest)) throw xError('session_restore_failed');
    }
    // Legacy profiles have no marker. Do not turn a silently empty database
    // into an upstream "expired" result or create a marker over missing auth.
    const auth = await readCookies(session, { domain: 'x.com' });
    if (!['auth_token', 'ct0'].every(name => auth.some(cookie => cookie.name === name && cookie.value))) throw xError('session_restore_failed');
    return Boolean(checkpoint);
  }
  async function checkpoint(session, id) {
    await access(id); encryption();
    const value = randomBytes(32).toString('hex');
    try { await session.cookies.set({ url: probeUrl, name: probeName, value, path: '/', secure: true, httpOnly: true, sameSite: 'strict', expirationDate: clock() / 1000 + 10 * 365 * 86400 }); }
    catch (error) { throw sessionError(error, 'session_write_failed'); }
    const actual = await readCookies(session, { url: probeUrl });
    if (!actual.some(cookie => cookie.name === probeName && cookie.value === value)) throw xError('session_write_failed');
    await flush(session, id);
    try { await repository.writeSessionCheckpoint(id, { version: 1, digest: digest(value) }); }
    catch (error) { throw sessionError(error, 'session_persist_failed'); }
  }
  async function clear(session, id) {
    try {
      await session.clearStorageData(); await session.flushStorageData?.(); await session.cookies.flushStore();
      if ((await session.cookies.get({})).length) throw xError('session_clear_failed');
    }
    catch (error) { throw sessionError(error, 'session_clear_failed'); }
    await access(id);
  }
  return { access, readCookies, flush, verify, checkpoint, clear };
}
