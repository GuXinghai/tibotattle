import { isWindowsProtectedStateStore, isWindowsProtectedStateStoreError } from '../../src/platform/index.js';

export const X_DIAGNOSTIC_FILE = 'x-errors-v1.json';
const stages = new Set(['login_web', 'login_bridge', 'login_import', 'login_verify', 'login_timeout', 'session_open', 'session_persist', 'session_clear', 'session_read']);
// Original platform codes are retained, rather than replaced by UI categories.
// Arbitrary strings from authentication pages are not a diagnostic contract.
const code = value => typeof value === 'number' && Number.isSafeInteger(value) ? value
  : typeof value === 'string' && /^(?:ERR_[A-Z_]{1,80}|WINDOWS_[A-Z_]{1,90}|E[A-Z]{1,30}|(?:windows_|session_)[a-z_]{1,90}|x_import_(?:unavailable|build_unavailable|build_failed)|login_timeout|login_failed|import_failed|offline|expired|challenge|cancelled)$/.test(value) ? value : null;
export function projectXError(error, depth = 0, seen = new Set()) {
  if (!error || typeof error !== 'object' || depth >= 4 || seen.has(error)) return null;
  seen.add(error);
  const originalCode = code(error.code);
  const message = typeof error.message === 'string' ? error.message : '';
  // Keep Chromium's precise net error but never the URL appended by loadURL.
  const net = message.match(/^(?:Error: )?(net::ERR_[A-Z_]{1,80})(?:\s|$)/)?.[1];
  const native = message.match(/^(E[A-Z]{1,30}: (?:permission denied|access denied|no such file or directory|operation not permitted|resource busy or locked|broken pipe))(?:,|\s|$)/)?.[1];
  const safeMessage = net ?? native ?? (code(message) !== null ? message : null);
  const frames = typeof error.stack === 'string' ? error.stack.split('\n').slice(1, 25).flatMap(line => {
    // Only reviewed source basenames and line/column numbers; no absolute paths,
    // remote script names, arguments, account names or arbitrary function labels.
    const frame = line.match(/\b(desktop-x-[a-z-]+\.js|windows-(?:filesystem|protected-state-store|browser-profile-store)\.js|node:internal\/[a-z_/-]+):(\d{1,7}):(\d{1,7})\)?$/);
    return frame ? [`${frame[1]}:${frame[2]}:${frame[3]}`] : [];
  }).slice(0, 8) : [];
  return { name: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'WindowsFilesystemError', 'WindowsProtectedStateStoreError', 'WindowsBrowserProfileStoreError'].includes(error.name) ? error.name : 'Error',
    code: originalCode, errno: code(error.errno), message: safeMessage,
    messageOmitted: safeMessage === null, frames, cause: projectXError(error.cause, depth + 1, seen) };
}

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function validError(value, depth = 0) {
  if (value === null) return true;
  if (depth >= 4 || !exact(value, ['name', 'code', 'errno', 'message', 'messageOmitted', 'frames', 'cause'])) return false;
  const projected = projectXError({ ...value, stack: '', cause: null });
  return projected.name === value.name && projected.code === value.code && projected.errno === value.errno
    && projected.message === value.message && value.messageOmitted === (value.message === null)
    && Array.isArray(value.frames) && value.frames.length <= 8
    && value.frames.every(frame => typeof frame === 'string' && /^(?:desktop-x-[a-z-]+\.js|windows-(?:filesystem|protected-state-store|browser-profile-store)\.js|node:internal\/[a-z_/-]+):\d{1,7}:\d{1,7}$/.test(frame))
    && validError(value.cause, depth + 1);
}

/** Owner-only bounded local log. Never sent through IPC or clipboard exports. */
export function createDesktopXDiagnostics({ store, clock = Date.now }) {
  if (!isWindowsProtectedStateStore(store)) throw new TypeError('Protected X diagnostic store required');
  return (stage, error) => {
    if (!stages.has(stage)) return false;
    try {
      const entry = { at: new Date(clock()).toISOString(), stage, error: projectXError(error) };
      let found;
      try { found = store.read(X_DIAGNOSTIC_FILE); }
      catch (failure) { if (!isWindowsProtectedStateStoreError(failure) || failure.code !== 'windows_protected_state_store_missing') throw failure; }
      let entries = [];
      if (found) {
        if (found.data.byteLength > 65536) return false;
        const previous = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(found.data));
        if (!exact(previous, ['version', 'entries']) || previous.version !== 1 || !Array.isArray(previous.entries) || previous.entries.length > 16
          || !previous.entries.every(item => exact(item, ['at', 'stage', 'error']) && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)) && stages.has(item.stage) && validError(item.error))) return false;
        entries = previous.entries;
      }
      const next = [...entries, entry].slice(-16);
      const value = { version: 1, entries: next };
      while (next.length > 1 && Buffer.byteLength(JSON.stringify(value)) > 65536) next.shift();
      if (found) store.replaceJson(X_DIAGNOSTIC_FILE, found.identity, value);
      else store.createJson(X_DIAGNOSTIC_FILE, value);
      return true;
    } catch { return false; } // A diagnostic failure must never break login/quit.
  };
}
