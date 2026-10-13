import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

// Copy a fixed continuity bundle. This is never an installation/profile selector.
// The old profile remains authoritative until its separate recovery review.
export const WINDOWS_LEGACY_STATE_MIGRATION_CONTRACT = 'windows-legacy-state-copy-v1';
const JOURNAL = '.legacy-state-copy-v1.json';
const DATABASE_LIMIT = 256 * 1024 * 1024;
const TOTAL_LIMIT = 1024 * 1024 * 1024;
export const WINDOWS_LEGACY_STATE_FILES = Object.freeze([
  'local-unified-index-device-salt-v1', 'export-participant-secret',
  'local-index-store-v1.sqlite', 'local-unified-index-v1.sqlite',
  'local-collector-state-v1.sqlite', 'private/contribution-sync-v0.1.sqlite3',
  'private/automatic-contribution-v0.1.json', 'private/incremental-contribution-sync-v1.json',
  'contribution-device-binding-v1.json', 'contribution-device-renewal-v1.json',
  'accountless-installation-credential-v1.bin', '.accountless-installation-credential-v1.journal',
  'desktop-settings/desktop-first-run-v1.json', 'desktop-settings/desktop-settings-v1.json',
  'desktop-settings/accountless-sharing-v1.json',
]);
const errors = new WeakSet();
function fail(category) {
  const error = new Error('Legacy state copy refused');
  error.code = `legacy_state_copy_${category}`;
  errors.add(error);
  throw error;
}
export function classifyWindowsLegacyStateMigrationFailure(error) {
  return errors.has(error) ? error.code : 'legacy_state_copy_unavailable';
}
function absent(error) {
  return error?.code === 'ENOENT' || error?.code === 'WINDOWS_FILESYSTEM_NOT_FOUND';
}
function database(name) { return /\.sqlite(?:3)?$/u.test(name); }
function limit(name) { return database(name) ? DATABASE_LIMIT : 1024 * 1024; }
function identity(value) {
  if (!value || !/^[0-9a-f]{16}$/u.test(value.volumeSerialNumber)
      || !/^[0-9a-f]{32}$/u.test(value.fileId) || value.linkCount !== 1) fail('identity');
  return { volumeSerialNumber: value.volumeSerialNumber, fileId: value.fileId, linkCount: 1 };
}
function sourceIdentity(stat) {
  return identity({ volumeSerialNumber: stat.dev, fileId: stat.ino, linkCount: stat.nlink });
}
function rootPath(value) {
  if (typeof value !== 'string' || !win32.isAbsolute(value) || value.includes('\0')) fail('configuration');
  const resolved = win32.resolve(value);
  if (resolved === win32.parse(resolved).root) fail('configuration');
  return resolved;
}
function readSource(binding, lease, size) {
  const bytes = Buffer.alloc(size);
  for (let offset = 0; offset < size;) {
    const part = binding.readSourceFile(lease, offset, Math.min(65536, size - offset));
    if (!Buffer.isBuffer(part) || !part.length || part.length > Math.min(65536, size - offset)) fail('read');
    part.copy(bytes, offset); offset += part.length;
  }
  return bytes;
}
function sourceHash(binding, lease, size) {
  const digest = createHash('sha256');
  for (let offset = 0; offset < size;) {
    const part = binding.readSourceFile(lease, offset, Math.min(65536, size - offset));
    if (!Buffer.isBuffer(part) || !part.length || part.length > Math.min(65536, size - offset)) fail('read');
    digest.update(part); offset += part.length; part.fill(0);
  }
  return digest.digest('hex');
}
function validateBytes(name, bytes) {
  if (name === 'local-unified-index-device-salt-v1') {
    if (bytes.length < 32 || bytes.length > 256) fail('salt');
  } else if (name === 'export-participant-secret') {
    const text = bytes.toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}\s*$/u.test(text) && bytes.length !== 32
        && text !== 'app-usagemonitor legacy secret retired v1\n'
        && text !== 'app-usagemonitor owner file backend retired v1\n') fail('secret');
  } else if (name === 'accountless-installation-credential-v1.bin') {
    if (bytes.length !== 32) fail('secret');
  } else if (name === '.accountless-installation-credential-v1.journal') {
    if (!/^windows-accountless-installation-credential-v1:(?:normal|active)\n$/u.test(bytes.toString('utf8'))) fail('record');
  } else if (database(name)) {
    if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') fail('database');
    // A WAL database is safe only after its owner has closed/checkpointed it;
    // copying WAL/SHM or hot rollback journals is deliberately unsupported.
    if (![1, 2].includes(bytes[18]) || bytes[18] !== bytes[19]) fail('database');
    const expected = name === 'local-index-store-v1.sqlite' ? 0x554d4932
      : name === 'local-collector-state-v1.sqlite' ? 0x554d4353 : null;
    if (expected !== null && bytes.readUInt32BE(68) !== expected) fail('database');
  } else {
    let value;
    try { value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)); }
    catch { fail('record'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('record');
  }
}

/**
 * Native binding is supplied by loadWindowsLegacyStateReadBinding. Injection is
 * reserved for contract tests. Never fallback to Node filesystem permission bits.
 * Destination must be an independently created owner-private root with none
 * of the planned file names present (unless resuming this exact operation).
 */
export function copyWindowsLegacyState({ sourceRoot, destinationRoot, binding,
  mode = 'dry-run', onCopied = null } = {}) {
  const source = rootPath(sourceRoot), destination = rootPath(destinationRoot);
  const relative = win32.relative(source, destination);
  const reverseRelative = win32.relative(destination, source);
  if (!relative || (!relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative))
      || (!reverseRelative.startsWith('..\\') && reverseRelative !== '..' && !win32.isAbsolute(reverseRelative))
      || !['dry-run', 'copy', 'resume'].includes(mode)) fail('configuration');
  const held = [];
  let guard, sourceGuard;
  try {
    sourceGuard = binding.acquireLegacyStateDirectoryGuard(source);
    // A partial bundle must never silently drop archives or pointer-selected
    // legacy state. These profiles need a separate exact preservation plan.
    for (const name of ['local-contribution-prepared-v0.1', 'local-contribution-reviews-v0.1']) {
      let unsupported;
      try { unsupported = binding.acquireLegacyStateDirectoryGuard(win32.join(source, name)); }
      catch (error) { if (absent(error)) continue; throw error; }
      binding.releaseProtectedDirectoryGuard(unsupported.guard);
      fail('unsupported_state');
    }
    for (const name of ['local-unified-index-v1.sqlite.current', 'activity-markers-v0.1.jsonl',
      'private/codex-speed-baseline-v0.1.json']) {
      let unsupported;
      try { unsupported = binding.openLegacyStateFile(win32.join(source, name)); }
      catch (error) { if (absent(error)) continue; throw error; }
      held.push(unsupported); fail('unsupported_state');
    }
    const records = [];
    let total = 0;
    for (const name of WINDOWS_LEGACY_STATE_FILES) {
      let lease;
      try { lease = binding.openLegacyStateFile(win32.join(source, name)); }
      catch (error) { if (absent(error)) continue; throw error; }
      held.push(lease);
      const stat = binding.statSourceFile(lease);
      if (!Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > limit(name)) fail('size');
      total += stat.size;
      if (total > TOTAL_LIMIT) fail('size');
      records.push({ name, size: stat.size, identity: sourceIdentity(stat), lease });
      if (database(name)) for (const suffix of ['-wal', '-shm', '-journal']) {
        let sidecar;
        try { sidecar = binding.openLegacyStateFile(win32.join(source, name + suffix)); }
        catch (error) { if (absent(error)) continue; throw error; }
        held.push(sidecar);
        if (binding.statSourceFile(sidecar).size !== 0) fail('database_open');
      }
    }
    if (!records.length) fail('empty');
    if (records.some(record => /local-(?:index-store|unified-index)/u.test(record.name))
        && !records.some(record => record.name === 'local-unified-index-device-salt-v1')) fail('salt');
    if (records.some(record => record.name === 'accountless-installation-credential-v1.bin')
        && !records.some(record => record.name === '.accountless-installation-credential-v1.journal')) fail('journal');
    // All present source files are frozen before any content is read.
    for (const record of records) {
      const bytes = readSource(binding, record.lease, database(record.name) ? 100 : record.size);
      try { validateBytes(record.name, bytes); record.sha256 = sourceHash(binding, record.lease, record.size); }
      finally { bytes.fill(0); }
    }
    guard = binding.acquireProtectedDirectoryGuard(destination);
    if (binding.legacyStateRootsDisjoint(sourceGuard.guard, guard.guard) !== true) fail('configuration');
    if (mode === 'dry-run') return Object.freeze({ status: 'planned', files: records.length, bytes: total });
    const rootIdentity = guard.identity;
    const planned = { contract: WINDOWS_LEGACY_STATE_MIGRATION_CONTRACT, rootIdentity,
      sourceRootIdentity: sourceGuard.identity,
      files: records.map(({ name, size, identity: fileIdentity, sha256 }) => ({ name, size, identity: fileIdentity, sha256 })) };
    let journal, completed = false;
    try { journal = binding.readProtectedChild(destination, rootIdentity, JOURNAL, 65536); }
    catch (error) { if (!absent(error)) throw error; }
    if (journal) {
      if (mode !== 'resume') fail('resume_required');
      let receipt;
      try { receipt = JSON.parse(journal.data.toString('utf8')); } catch { fail('journal'); }
      if (!['copying', 'complete'].includes(receipt.status)
          || JSON.stringify(receipt.plan) !== JSON.stringify(planned)
          || Object.keys(receipt).sort().join(',') !== 'plan,status') fail('journal');
      completed = receipt.status === 'complete';
    } else {
      if (mode === 'resume') fail('journal');
      for (const record of records) {
        try { binding.inspectProtectedChild(destination, rootIdentity, record.name); fail('destination_exists'); }
        catch (error) { if (!absent(error)) throw error; }
      }
      const data = Buffer.from(JSON.stringify({ plan: planned, status: 'copying' }));
      const journalIdentity = binding.createProtectedChild(destination, rootIdentity, JOURNAL, data);
      journal = { data, identity: journalIdentity };
    }
    for (const record of records) {
      let targetLease;
      try {
        if (sourceHash(binding, record.lease, record.size) !== record.sha256) fail('source_changed');
        try { targetLease = binding.openLegacyStateFile(win32.join(destination, record.name)); }
        catch (error) { if (!absent(error)) throw error; }
        if (!targetLease) {
          const parent = win32.dirname(record.name);
          if (parent !== '.') binding.ensureDirectory(win32.join(destination, parent));
          binding.copyLegacyStateFile(record.lease, destination, rootIdentity, record.name);
          targetLease = binding.openLegacyStateFile(win32.join(destination, record.name));
        }
        const inspection = binding.inspectProtectedChild(destination, rootIdentity, record.name);
        const stat = binding.statSourceFile(targetLease);
        if (JSON.stringify(sourceIdentity(stat)) !== JSON.stringify(identity(inspection.identity))
            || stat.size !== record.size || sourceHash(binding, targetLease, stat.size) !== record.sha256) fail('destination_changed');
        onCopied?.(record.name);
      } finally { if (targetLease) binding.closeSourceFile(targetLease); }
    }
    if (!completed) binding.replaceProtectedChild(destination, rootIdentity, JOURNAL, journal.identity,
      Buffer.from(JSON.stringify({ plan: planned, status: 'complete' })));
    return Object.freeze({ status: 'copied', files: records.length, bytes: total });
  } catch (error) {
    if (errors.has(error)) throw error;
    fail('unavailable');
  } finally {
    let closeFailed = false;
    for (const lease of held.reverse()) {
      try { binding.closeSourceFile(lease); } catch { closeFailed = true; }
    }
    if (guard) try { binding.releaseProtectedDirectoryGuard(guard.guard); } catch { closeFailed = true; }
    if (sourceGuard) try { binding.releaseProtectedDirectoryGuard(sourceGuard.guard); } catch { closeFailed = true; }
    if (closeFailed) fail('close');
  }
}
