import { createHash, randomUUID } from 'node:crypto';

// Fixed bridge assets only. This has no browser/session/credential access.
export const X_IMPORT_ASSETS = Object.freeze(['manifest.json', 'popup.html', 'popup.js', 'UsageMonitorXImport.exe', 'native-host.json']);
const RECEIPT = 'setup-receipt-v1.json', INTENT = 'setup-intent-v1.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const version = v => typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(v);
const identity = v => exact(v, ['volumeSerialNumber', 'fileId', 'linkCount'])
  && /^[a-f0-9]{16}$/u.test(v.volumeSerialNumber) && /^[a-f0-9]{32}$/u.test(v.fileId) && v.linkCount === 1;
const sameIdentity = (a, b) => identity(a) && identity(b)
  && a.volumeSerialNumber === b.volumeSerialNumber && a.fileId === b.fileId;
const packageHash = (v, files) => sha(JSON.stringify([v, X_IMPORT_ASSETS.map(name => [name, files[name]])]));
function validReceipt(v) {
  return exact(v, ['schemaVersion', 'version', 'files', 'packageHash']) && v.schemaVersion === 'x-import-setup-v1'
    && version(v.version) && exact(v.files, X_IMPORT_ASSETS) && X_IMPORT_ASSETS.every(k => digest(v.files[k]))
    && v.packageHash === packageHash(v.version, v.files);
}
const binding = v => v === null || exact(v, ['identity', 'digest']) && identity(v.identity) && digest(v.digest);
function validIntent(v) {
  return exact(v, ['schemaVersion', 'operationId', 'phase', 'registration', 'target', 'previousReceipt', 'before'])
    && v.schemaVersion === 'x-import-setup-intent-v1' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(v.operationId)
    && ['prepared', 'complete'].includes(v.phase) && ['required', 'unchanged'].includes(v.registration)
    && validReceipt(v.target) && binding(v.previousReceipt) && exact(v.before, X_IMPORT_ASSETS)
    && X_IMPORT_ASSETS.every(k => binding(v.before[k]));
}
const fail = () => { throw Object.assign(new Error('X import setup unavailable'), { code: 'x_import_setup_unavailable' }); };
const newer = (a, b) => {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
};

// The Electron composition root owns the app single-instance lock. Atomic
// protected-store CAS and exact actual-file reconciliation guard every write;
// this helper is not a general multi-writer installer or a profile migration.
export function createXImportSetup({ store, assets, isMissing, registerHost, verifyHost }) {
  if (!exact(assets, X_IMPORT_ASSETS) || X_IMPORT_ASSETS.some(k => !Buffer.isBuffer(assets[k]) || !assets[k].length || assets[k].length > 1048576)
    || typeof isMissing !== 'function' || typeof registerHost !== 'function' || typeof verifyHost !== 'function') fail();
  assets = Object.fromEntries(X_IMPORT_ASSETS.map(k => [k, Buffer.from(assets[k])]));
  let manifest;
  try { manifest = JSON.parse(assets['manifest.json'].toString('utf8')); } catch { fail(); }
  if (!version(manifest?.version)) fail();
  const files = Object.fromEntries(X_IMPORT_ASSETS.map(k => [k, sha(assets[k])]));
  const target = { schemaVersion: 'x-import-setup-v1', version: manifest.version, files, packageHash: packageHash(manifest.version, files) };
  const read = name => { try { return store.read(name); } catch (error) { if (isMissing(error)) return null; throw error; } };
  const json = (name, valid) => {
    const record = read(name); if (!record) return null;
    try { const value = JSON.parse(record.data.toString('utf8')); if (!valid(value)) fail(); return { ...record, value }; } catch { fail(); }
  };
  const bound = r => r ? { identity: r.identity, digest: sha(r.data) } : null;
  const matches = (r, b) => r === null ? b === null : b !== null && sameIdentity(r.identity, b.identity) && sha(r.data) === b.digest;
  const verified = () => X_IMPORT_ASSETS.every(k => { const r = read(k); return r && sha(r.data) === files[k]; });
  let active = null;
  async function apply(explicit, current) {
    const check = () => { if (!current()) fail(); }; check();
    let receipt = json(RECEIPT, validReceipt), intent = json(INTENT, validIntent);
    if (!receipt && !explicit) return { ready: false, code: 'not_configured' };
    if (receipt && newer(receipt.value.version, target.version)) fail();
    if (intent?.value.phase === 'prepared' && intent.value.target.packageHash !== target.packageHash) fail();
    if (!explicit && receipt?.value.packageHash === target.packageHash && verified()) {
      // A missing completion acknowledgement never triggers asset replay.
      if (!await verifyHost()) return { ready: false, code: 'not_configured' };
      if (intent?.value.phase === 'prepared') {
        check(); store.replaceJson(INTENT, intent.identity, { ...intent.value, phase: 'complete' });
      }
      return { ready: true, code: 'bridge_ready' };
    }
    if (intent?.value.phase === 'prepared') {
      if (intent.value.registration === 'required' && !explicit) return { ready: false, code: 'not_configured' };
      if (!matches(receipt, intent.value.previousReceipt)) fail();
    } else {
      const before = Object.fromEntries(X_IMPORT_ASSETS.map(k => [k, bound(read(k))]));
      // Routine updates require intact previously approved assets. Explicit
      // repair may replace only these exact owner-protected managed files.
      if (!explicit && X_IMPORT_ASSETS.some(k => !before[k] || before[k].digest !== receipt.value.files[k])) fail();
      const value = { schemaVersion: 'x-import-setup-intent-v1', operationId: randomUUID(), phase: 'prepared',
        registration: explicit ? 'required' : 'unchanged', target, previousReceipt: bound(receipt), before };
      check();
      const saved = intent ? store.replaceJson(INTENT, intent.identity, value) : store.createJson(INTENT, value);
      intent = { ...saved, value };
    }
    if (!explicit && !await verifyHost()) return { ready: false, code: 'not_configured' };
    for (const name of X_IMPORT_ASSETS) {
      check(); const actual = read(name);
      if (actual && sha(actual.data) === files[name]) continue;
      if (!matches(actual, intent.value.before[name])) fail();
      if (actual) store.replace(name, actual.identity, assets[name]); else store.create(name, assets[name]);
      const saved = read(name); if (!saved || sha(saved.data) !== files[name]) fail();
    }
    check(); if (!verified()) fail();
    if (explicit) { await registerHost(); check(); }
    else if (!await verifyHost()) fail();
    if (!matches(json(RECEIPT, validReceipt), intent.value.previousReceipt)) fail();
    check();
    if (receipt) store.replaceJson(RECEIPT, receipt.identity, target); else store.createJson(RECEIPT, target);
    const actualReceipt = json(RECEIPT, validReceipt);
    if (actualReceipt?.value.packageHash !== target.packageHash || !verified()) fail();
    check(); store.replaceJson(INTENT, intent.identity, { ...intent.value, phase: 'complete' });
    return { ready: true, code: 'bridge_ready' };
  }
  return Object.freeze({
    prepare({ explicit = false, isCurrent = () => true } = {}) {
      // Do not merge an explicit configure with a routine call or a cancelled
      // operation. The composition root serializes the owning user actions.
      if (active) return Promise.reject(Object.assign(new Error('X import setup busy'), { code: 'x_import_setup_busy' }));
      active = apply(explicit, isCurrent).finally(() => { active = null; }); return active;
    },
    verify() { const receipt = json(RECEIPT, validReceipt); return receipt?.value.packageHash === target.packageHash && verified(); },
  });
}
