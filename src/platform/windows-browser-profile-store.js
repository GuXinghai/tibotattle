import { win32 } from 'node:path';
import { isWindowsFilesystemAdapter, WINDOWS_BROWSER_PROFILE_CONTRACT } from './windows-filesystem.js';

const STORES = new WeakSet();
const ERRORS = new WeakSet();
const CODES = new Set(['invalid_configuration', 'unavailable', 'security_policy', 'bound_exceeded', 'cache_cleanup_pending', 'prepare_failed', 'read_failed', 'write_failed']);

export class WindowsBrowserProfileStoreError extends Error {
  constructor(code) {
    if (!CODES.has(code)) throw new TypeError('Unknown browser profile error');
    super('Windows browser profile operation failed');
    this.name = 'WindowsBrowserProfileStoreError';
    this.code = `windows_browser_profile_${code}`;
    ERRORS.add(this);
  }
}
export function isWindowsBrowserProfileStore(value) { return Boolean(value && STORES.has(value)); }
export function isWindowsBrowserProfileStoreError(value) { return Boolean(value && ERRORS.has(value)); }

function mapFailure(error, fallback) {
  if (error?.windowsFilesystemStage === 'browser_profile_cookie_write') return new WindowsBrowserProfileStoreError('write_failed');
  if (error?.code === 'WINDOWS_FILESYSTEM_BROWSER_PROFILE_BOUND_EXCEEDED') return new WindowsBrowserProfileStoreError('bound_exceeded');
  if (error?.code === 'WINDOWS_FILESYSTEM_BROWSER_PROFILE_CACHE_CLEANUP_PENDING') return new WindowsBrowserProfileStoreError('cache_cleanup_pending');
  if (['SECURITY_POLICY', 'REPARSE_POINT', 'HARD_LINK', 'IDENTITY_MISMATCH', 'INVALID_PATH', 'NOT_DIRECTORY', 'NOT_REGULAR_FILE']
    .some(code => error?.code === `WINDOWS_FILESYSTEM_${code}`)) return new WindowsBrowserProfileStoreError('security_policy');
  return new WindowsBrowserProfileStoreError(fallback);
}
function health(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'cookieDatabaseBusy,cookieDatabaseBytes,cookieDatabasePresent,entries'
      || !Number.isSafeInteger(value.entries) || value.entries < 1 || value.entries > 4096
      || typeof value.cookieDatabasePresent !== 'boolean'
      || typeof value.cookieDatabaseBusy !== 'boolean'
      || !Number.isSafeInteger(value.cookieDatabaseBytes) || value.cookieDatabaseBytes < 0) {
    throw new WindowsBrowserProfileStoreError('unavailable');
  }
  return Object.freeze({ ...value });
}

// A separate branded capability: protected record stores intentionally keep
// their non-inheriting policy. Only Chromium profile trees use this adapter.
export function createWindowsBrowserProfileStore({ adapter, rootPath } = {}) {
  if (!isWindowsFilesystemAdapter(adapter)
      || adapter.browserProfileContractVersion !== WINDOWS_BROWSER_PROFILE_CONTRACT
      || typeof adapter.prepareBrowserProfile !== 'function' || typeof adapter.inspectBrowserProfile !== 'function') {
    throw new WindowsBrowserProfileStoreError('unavailable');
  }
  if (typeof rootPath !== 'string' || !win32.isAbsolute(rootPath)
      || rootPath.includes('\0') || win32.parse(rootPath).root === win32.normalize(rootPath)) {
    throw new WindowsBrowserProfileStoreError('invalid_configuration');
  }
  const store = Object.freeze({
    rootPath,
    ensureReady() {
      try { health(adapter.prepareBrowserProfile(rootPath)); return rootPath; }
      catch (error) { throw mapFailure(error, 'prepare_failed'); }
    },
    inspectHealth() {
      try { return health(adapter.inspectBrowserProfile(rootPath)); }
      catch (error) { throw mapFailure(error, 'read_failed'); }
    },
  });
  STORES.add(store);
  return store;
}
