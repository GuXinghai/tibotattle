import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { copyWindowsLegacyState, classifyWindowsLegacyStateMigrationFailure } from '../src/platform/index.js';

const sourceRoot = 'C:\\synthetic\\old', destinationRoot = 'C:\\synthetic\\new';
const saltName = 'local-unified-index-device-salt-v1';
const optOutName = 'desktop-settings/accountless-sharing-v1.json';
const fixedId = sequence => ({ volumeSerialNumber: '0000000000000001',
  fileId: sequence.toString(16).padStart(32, '0'), linkCount: 1 });
function fixture() {
  let sequence = 4, writes = 0;
  const source = new Map(), target = new Map(), held = new Set();
  const normalize = name => name.replaceAll('\\', '/');
  function missing() { const error = new Error('synthetic sensitive text'); error.code = 'ENOENT'; throw error; }
  function sourceFile(name, data) { source.set(normalize(name), { data: Buffer.from(data), identity: fixedId(sequence++) }); }
  function targetFile(name, data) { const record = { data: Buffer.from(data), identity: fixedId(sequence++) }; target.set(normalize(name), record); return record.identity; }
  sourceFile(saltName, Buffer.alloc(32, 17));
  sourceFile('export-participant-secret', Buffer.alloc(32, 23).toString('base64url'));
  sourceFile(optOutName, JSON.stringify({ schemaVersion: 1, enabled: false, state: 'disabled', basis: 'user_choice' }));
  const binding = {
    acquireLegacyStateDirectoryGuard(path) { if (path !== sourceRoot) missing(); return { guard: 'source-root', identity: fixedId(1) }; },
    acquireProtectedDirectoryGuard() { return { guard: 'target-root', identity: fixedId(2) }; },
    releaseProtectedDirectoryGuard() {},
    legacyStateRootsDisjoint() { return true; },
    openLegacyStateFile(path) {
      const fromSource = path.startsWith(sourceRoot + '\\');
      const name = normalize(win32.relative(fromSource ? sourceRoot : destinationRoot, path));
      const file = (fromSource ? source : target).get(name); if (!file) missing();
      const lease = { name, file, fromSource }; held.add(lease); return lease;
    },
    statSourceFile(lease) { return { dev: lease.file.identity.volumeSerialNumber,
      ino: lease.file.identity.fileId, nlink: 1, size: lease.file.data.length }; },
    readSourceFile(lease, offset, length) { assert.equal([...held].filter(item => item.fromSource).length, source.size, 'all sources frozen before reading'); return Buffer.from(lease.file.data.subarray(offset, offset + length)); },
    closeSourceFile(lease) { held.delete(lease); },
    inspectProtectedChild(root, id, name) { return target.get(normalize(name)) ?? missing(); },
    readProtectedChild(root, id, name) { const record = target.get(normalize(name)) ?? missing(); return { ...record, data: Buffer.from(record.data) }; },
    createProtectedChild(root, id, name, bytes) { assert.equal(target.has(normalize(name)), false); writes += 1; return targetFile(name, bytes); },
    copyLegacyStateFile(lease, root, id, name) { return binding.createProtectedChild(root, id, name, lease.file.data); },
    replaceProtectedChild(root, id, name, expected, bytes) { assert.deepEqual(target.get(normalize(name)).identity, expected); writes += 1; return targetFile(name, bytes); },
    ensureDirectory() {},
  };
  return { binding, source, target, held, sourceFile, targetFile, writes: () => writes };
}
function run(context, extra = {}) { return copyWindowsLegacyState({ sourceRoot, destinationRoot, binding: context.binding, ...extra }); }
function category(expected) { return error => classifyWindowsLegacyStateMigrationFailure(error) === `legacy_state_copy_${expected}`; }

test('copy and interrupted resume preserve exact salt, identity and explicit opt-out without source mutation', () => {
  const context = fixture();
  const originals = [...context.source].map(([name, record]) => [name, Buffer.from(record.data), { ...record.identity }]);
  assert.equal(run(context).status, 'planned'); assert.equal(context.writes(), 0);
  let copies = 0;
  assert.throws(() => run(context, { mode: 'copy', onCopied() { if (++copies === 2) throw new Error('private contents'); } }), category('unavailable'));
  assert.equal(context.held.size, 0);
  assert.throws(() => run(context, { mode: 'copy' }), category('resume_required'));
  assert.equal(run(context, { mode: 'resume' }).status, 'copied');
  assert.equal(run(context, { mode: 'resume' }).status, 'copied');
  for (const [name, bytes, identity] of originals) {
    assert.deepEqual(context.source.get(name).data, bytes);
    assert.deepEqual(context.source.get(name).identity, identity);
    assert.deepEqual(context.target.get(name).data, bytes);
  }
  assert.equal(JSON.parse(context.target.get(optOutName).data).enabled, false);
});

test('native root aliases or containment refuse before any destination write', () => {
  const context = fixture(); context.binding.legacyStateRootsDisjoint = () => false;
  assert.throws(() => run(context, { mode: 'copy' }), category('configuration'));
  assert.equal(context.writes(), 0);
  assert.equal(context.held.size, 0);
});

test('copy refuses existing target, stale source identity, missing salt and malformed journal', () => {
  let context = fixture(); context.targetFile(saltName, Buffer.alloc(32));
  assert.throws(() => run(context, { mode: 'copy' }), category('destination_exists'));
  assert.equal(context.writes(), 0);
  context = fixture();
  assert.throws(() => run(context, { mode: 'copy', onCopied() { throw new Error(); } }), category('unavailable'));
  context.source.get(saltName).identity = fixedId(999);
  assert.throws(() => run(context, { mode: 'resume' }), category('journal'));
  context = fixture(); context.source.delete(saltName);
  const header = Buffer.alloc(100); header.write('SQLite format 3\0', 'binary'); header[18] = header[19] = 1; header.writeUInt32BE(0x554d4932, 68);
  context.sourceFile('local-index-store-v1.sqlite', header);
  assert.throws(() => run(context), category('salt'));
  context = fixture(); context.targetFile('.legacy-state-copy-v1.json', Buffer.from('garbage'));
  assert.throws(() => run(context, { mode: 'resume' }), category('journal'));
});

test('database sidecars, unsafe source and size limits refuse before destination mutation with fixed errors', () => {
  const context = fixture();
  context.sourceFile('local-index-store-v1.sqlite', Buffer.alloc(100));
  context.sourceFile('local-index-store-v1.sqlite-wal', Buffer.from('uncommitted'));
  assert.throws(() => run(context, { mode: 'copy' }), category('database_open'));
  assert.equal(context.writes(), 0); assert.equal(context.held.size, 0);
  context.binding.openLegacyStateFile = () => { throw new Error('private path and SID'); };
  assert.throws(() => run(context), error => error.message === 'Legacy state copy refused'
    && category('unavailable')(error));
  const large = fixture(); large.binding.statSourceFile = () => ({ dev: fixedId(1).volumeSerialNumber, ino: fixedId(1).fileId, nlink: 1, size: 1024 * 1024 + 1 });
  assert.throws(() => run(large), category('size'));
});

test('resume refuses target changed after interrupted copy and overlapping roots', () => {
  const context = fixture();
  assert.throws(() => run(context, { mode: 'copy', onCopied() { throw new Error(); } }), category('unavailable'));
  context.target.get(saltName).data[0] ^= 1;
  assert.throws(() => run(context, { mode: 'resume' }), category('destination_changed'));
  for (const destination of [sourceRoot, win32.join(sourceRoot, 'child'), 'C:\\synthetic']) {
    assert.throws(() => run(context, { destinationRoot: destination }), category('configuration'));
  }
});

test('accountless active recovery journal and participant retirement tombstone are copied without resetting identity', () => {
  const context = fixture();
  context.sourceFile('accountless-installation-credential-v1.bin', Buffer.alloc(32, 19));
  context.sourceFile('.accountless-installation-credential-v1.journal', 'windows-accountless-installation-credential-v1:active\n');
  context.sourceFile('export-participant-secret', 'app-usagemonitor owner file backend retired v1\n');
  assert.equal(run(context, { mode: 'copy' }).status, 'copied');
  assert.equal(context.target.get('.accountless-installation-credential-v1.journal').data.toString(),
    'windows-accountless-installation-credential-v1:active\n');
  const count = context.writes();
  run(context, { mode: 'resume' }); assert.equal(context.writes(), count);
  const missing = fixture(); missing.sourceFile('accountless-installation-credential-v1.bin', Buffer.alloc(32));
  assert.throws(() => run(missing), category('journal'));
});

test('unsupported retained state and malformed SQLite family refuse rather than silently omit evidence', () => {
  const context = fixture(); context.sourceFile('local-unified-index-v1.sqlite.current', '{"format":"synthetic"}');
  assert.throws(() => run(context, { mode: 'copy' }), category('unsupported_state'));
  assert.equal(context.writes(), 0);
  const archive = fixture();
  archive.binding.acquireLegacyStateDirectoryGuard = path => ({ guard: path, identity: fixedId(1) });
  assert.throws(() => run(archive), category('unsupported_state'));
  const malformed = fixture();
  const header = Buffer.alloc(100); header.write('SQLite format 3\0', 'binary'); header[18] = header[19] = 1;
  malformed.sourceFile('local-index-store-v1.sqlite', header);
  assert.throws(() => run(malformed), category('database'));
  assert.equal(malformed.writes(), 0);
});
