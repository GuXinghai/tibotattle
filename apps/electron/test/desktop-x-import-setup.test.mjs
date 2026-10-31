import test from 'node:test';
import assert from 'node:assert/strict';
import { createXImportSetup, X_IMPORT_ASSETS } from '../x-import/setup.js';
import { createXImportRegistration } from '../x-import/registration.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

function fixture() {
  let serial = 0; const records = new Map(), writes = []; let hook = () => {};
  const missing = Object.assign(new Error('synthetic missing'), { missing: true });
  const store = {
    read(name) { const r = records.get(name); if (!r) throw missing; return { data: Buffer.from(r.data), identity: { ...r.identity } }; },
    create(name, data) { if (records.has(name)) throw Error('exists'); return save(name, data); },
    replace(name, id, data) { assert.deepEqual(store.read(name).identity, id); return save(name, data); },
    createJson(name, value) { return store.create(name, Buffer.from(JSON.stringify(value))); },
    replaceJson(name, id, value) { return store.replace(name, id, Buffer.from(JSON.stringify(value))); },
  };
  function save(name, bytes) {
    const record = { data: Buffer.from(bytes), identity: { volumeSerialNumber: '0'.repeat(16), fileId: (++serial).toString(16).padStart(32, '0'), linkCount: 1 } };
    records.set(name, record); writes.push(name); hook(name); return { identity: { ...record.identity } };
  }
  let registrations = 0, registered = false;
  const assets = (version = '1.0.0') => Object.fromEntries(X_IMPORT_ASSETS.map(name => [name,
    Buffer.from(name === 'manifest.json' ? JSON.stringify({ version }) : `synthetic ${version} ${name}`)]));
  const make = (version, extra = {}) => createXImportSetup({ store, assets: assets(version), isMissing: error => error === missing,
    registerHost: async () => { registrations++; registered = true; }, verifyHost: async () => registered, ...extra });
  return { store, records, writes, make, assets, hook: value => { hook = value; }, registrations: () => registrations,
    registered: value => { registered = value; } };
}

test('explicit setup writes durable intent first; routine checks read no sessions and do not register or rewrite', async () => {
  const f = fixture(), setup = f.make();
  assert.deepEqual(await setup.prepare(), { ready: false, code: 'not_configured' }); assert.equal(f.writes.length, 0);
  assert.equal((await setup.prepare({ explicit: true })).ready, true);
  assert.equal(f.writes[0], 'setup-intent-v1.json'); assert.equal(f.registrations(), 1);
  const before = f.writes.length;
  assert.equal((await f.make().prepare()).ready, true); assert.equal(f.writes.length, before); assert.equal(f.registrations(), 1);
  assert.ok(setup.verify());
});

test('approved asset upgrade uses actual reconciliation and preserves unrelated files without registry writes', async () => {
  const f = fixture(); await f.make().prepare({ explicit: true });
  f.store.create('unrelated.bin', Buffer.from('untouched synthetic state'));
  const unrelated = f.store.read('unrelated.bin');
  await f.make('1.0.1').prepare(); assert.equal(f.registrations(), 1);
  assert.deepEqual(f.store.read('unrelated.bin'), unrelated);
  assert.equal(JSON.parse(f.store.read('setup-receipt-v1.json').data).version, '1.0.1');
  for (const name of X_IMPORT_ASSETS) assert.deepEqual(f.store.read(name).data, f.assets('1.0.1')[name]);
});

for (const upgrade of [false, true]) test(`interrupted writes resume only exact old/new resources, upgrade=${upgrade}`, async () => {
  const f = fixture(); if (upgrade) await f.make().prepare({ explicit: true });
  const version = upgrade ? '1.0.1' : '1.0.0';
  f.hook(name => { if (name === 'popup.js') throw Error('synthetic lost write acknowledgement'); });
  await assert.rejects(f.make(version).prepare({ explicit: !upgrade })); f.hook(() => {});
  const delivered = f.store.read('popup.js'), writes = f.writes.filter(x => x === 'popup.js').length;
  if (!upgrade) assert.equal((await f.make(version).prepare()).ready, false);
  await f.make(version).prepare({ explicit: !upgrade });
  assert.deepEqual(f.store.read('popup.js'), delivered); assert.equal(f.writes.filter(x => x === 'popup.js').length, writes);
  assert.equal(f.registrations(), 1);
});

test('lost receipt acknowledgement is reconciled without replaying assets or registry', async () => {
  const f = fixture(); f.hook(name => { if (name === 'setup-receipt-v1.json') throw Error('synthetic uncertain receipt'); });
  await assert.rejects(f.make().prepare({ explicit: true })); f.hook(() => {});
  const assetWrites = f.writes.filter(x => X_IMPORT_ASSETS.includes(x)).length;
  assert.equal((await f.make().prepare()).ready, true);
  assert.equal(f.writes.filter(x => X_IMPORT_ASSETS.includes(x)).length, assetWrites); assert.equal(f.registrations(), 1);
  assert.equal(JSON.parse(f.store.read('setup-intent-v1.json').data).phase, 'complete');
});

test('cancel between writes preserves an explicit recoverable intent and does not register', async () => {
  const f = fixture(); let current = true;
  f.hook(name => { if (name === 'popup.html') current = false; });
  await assert.rejects(f.make().prepare({ explicit: true, isCurrent: () => current }));
  assert.equal(f.registrations(), 0); assert.equal(f.records.has('setup-receipt-v1.json'), false);
  f.hook(() => {}); await f.make().prepare({ explicit: true }); assert.equal(f.registrations(), 1);
});

test('cancel after registry write never acknowledges setup and only explicit repair retries registration', async () => {
  const f = fixture(); let current = true;
  await assert.rejects(f.make(undefined, { registerHost: async () => { current = false; } })
    .prepare({ explicit: true, isCurrent: () => current }));
  assert.equal(f.records.has('setup-receipt-v1.json'), false);
  assert.equal((await f.make().prepare()).ready, false);
  await f.make().prepare({ explicit: true }); assert.equal(f.registrations(), 1);
});

test('missing or modified approved assets block automatic upgrade; explicit fixed-file repair remains available', async () => {
  for (const remove of [false, true]) {
    const f = fixture(); await f.make().prepare({ explicit: true });
    if (remove) f.records.delete('popup.js'); else f.store.replace('popup.js', f.store.read('popup.js').identity, Buffer.from('synthetic modified'));
    const before = f.writes.length;
    await assert.rejects(f.make('1.0.1').prepare()); assert.equal(f.writes.length, before);
    await f.make('1.0.1').prepare({ explicit: true }); assert.equal(f.registrations(), 2);
  }
});

test('changed previously recorded resource or a different interrupted target refuses without overwrite', async () => {
  for (const different of [false, true]) {
    const f = fixture(); f.hook(name => { if (name === 'popup.html') throw Error('synthetic interruption'); });
    await assert.rejects(f.make().prepare({ explicit: true })); f.hook(() => {});
    if (!different) f.store.replace('popup.html', f.store.read('popup.html').identity, Buffer.from('synthetic foreign replacement'));
    const before = f.writes.length;
    await assert.rejects(f.make(different ? '1.0.1' : '1.0.0').prepare({ explicit: true })); assert.equal(f.writes.length, before);
  }
});

test('downgrades, corrupt receipts and malformed intents fail closed', async () => {
  for (const kind of ['downgrade', 'receipt', 'intent']) {
    const f = fixture(); await f.make('1.0.1').prepare({ explicit: true });
    if (kind !== 'downgrade') {
      const name = kind === 'receipt' ? 'setup-receipt-v1.json' : 'setup-intent-v1.json';
      const old = f.store.read(name), value = JSON.parse(old.data); value.extra = 'synthetic unknown'; f.store.replaceJson(name, old.identity, value);
    }
    const before = f.writes.length;
    await assert.rejects(f.make(kind === 'downgrade' ? '1.0.0' : '1.0.1').prepare({ explicit: true })); assert.equal(f.writes.length, before);
  }
});

test('concurrent setup calls cannot merge separate authorization or cancellation lifetimes', async () => {
  const f = fixture(); let release;
  const setup = f.make(undefined, { registerHost: () => new Promise(resolve => { release = resolve; }) });
  const first = setup.prepare({ explicit: true }); await Promise.resolve();
  await assert.rejects(setup.prepare(), { code: 'x_import_setup_busy' }); release(); await first;
});

test('lost registry binding blocks routine use and is repaired only by an explicit configure', async () => {
  const f = fixture(); await f.make().prepare({ explicit: true }); f.registered(false);
  const before = f.writes.length;
  assert.equal((await f.make().prepare()).ready, false); assert.equal(f.writes.length, before); assert.equal(f.registrations(), 1);
  await f.make().prepare({ explicit: true }); assert.equal(f.registrations(), 2);
});

test('repair of already matching assets persists a fresh intent before registry mutation', async () => {
  const f = fixture(); await f.make().prepare({ explicit: true });
  const previous = JSON.parse(f.store.read('setup-intent-v1.json').data).operationId;
  let called = false;
  await f.make(undefined, { registerHost: async () => {
    const intent = JSON.parse(f.store.read('setup-intent-v1.json').data);
    assert.equal(intent.phase, 'prepared'); assert.equal(intent.registration, 'required');
    assert.notEqual(intent.operationId, previous); called = true;
  } }).prepare({ explicit: true });
  assert.equal(called, true);
});

test('registration verifies both exact user views, checks readback and never writes during verify', async () => {
  const calls = [], values = new Map(); let fail64 = false;
  const registration = createXImportRegistration({ rootPath: 'C:\\synthetic\\x-import', windowsDirectory: 'C:\\Windows',
    run: async (exe, args, options) => {
      calls.push(args); assert.equal(exe, 'C:\\Windows\\System32\\reg.exe'); assert.equal(options.windowsHide, true);
      assert.ok(args[1].startsWith('HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\'));
      const view = args.at(-1);
      if (args[0] === 'ADD') { if (fail64 && view === '/reg:64') throw Error('synthetic write failure'); values.set(view, args[args.indexOf('/d') + 1]); return {}; }
      return { stdout: values.has(view) ? `\r\n    (Default)    REG_SZ    ${values.get(view)}\r\n` : '' };
    } });
  assert.equal(await registration.verify(), false); assert.ok(calls.every(x => x[0] === 'QUERY'));
  await registration.register(); assert.equal(await registration.verify(), true);
  values.set('/reg:64', 'C:\\synthetic\\foreign.json'); assert.equal(await registration.verify(), false);
  fail64 = true; await assert.rejects(registration.register());
});

for (const interrupted of [false, true]) test(`native protected setup reopens and readbacks approved assets without real registration; interrupted=${interrupted}`,
  { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async () => {
    const { createWindowsFilesystemAdapter, createWindowsProtectedStateStore, loadWindowsLegacyStateReadBinding, isWindowsProtectedStateStoreError } = await import('../../../src/platform/index.js');
    const native = loadWindowsLegacyStateReadBinding({ bindingPath: resolve('native/windows-filesystem/build/Release/windows_filesystem.node') });
    const root = resolve('.release-build', 'x-setup-' + randomUUID().replaceAll('-', '')); native.ensureDirectory(root);
    const store = createWindowsProtectedStateStore({ adapter: createWindowsFilesystemAdapter(), rootPath: root });
    let registrations = 0, fail = interrupted;
    const make = (v, selectedStore = store) => createXImportSetup({ store: selectedStore, assets: fixture().assets(v),
      isMissing: error => isWindowsProtectedStateStoreError(error) && error.code === 'windows_protected_state_store_missing',
      registerHost: async () => { registrations++; }, verifyHost: async () => true });
    await make().prepare({ explicit: true });
    const fault = { ...store, replace(name, id, data) {
      const saved = store.replace(name, id, data);
      if (fail && name === 'popup.js') { fail = false; throw Error('synthetic acknowledgement loss'); } return saved;
    } };
    if (interrupted) await assert.rejects(make('1.0.1', fault).prepare());
    const reopened = createWindowsProtectedStateStore({ adapter: createWindowsFilesystemAdapter(), rootPath: root });
    assert.equal((await make('1.0.1', reopened).prepare()).ready, true); assert.equal(registrations, 1);
    for (const name of X_IMPORT_ASSETS) {
      assert.deepEqual(reopened.read(name).data, fixture().assets('1.0.1')[name]);
      const metadata = native.inspectPath(resolve(root, name)); assert.equal(metadata.ownerMatches, true); assert.equal(metadata.nonOwnerAllow, false);
    }
    assert.equal(JSON.parse(reopened.read('setup-intent-v1.json').data).phase, 'complete');
  });
