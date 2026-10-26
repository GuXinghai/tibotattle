import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm, link, symlink, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createWindowsFilesystemAdapter, WINDOWS_BROWSER_PROFILE_CONTRACT,
} from '../src/platform/windows-filesystem.js';
import {
  createWindowsBrowserProfileStore, isWindowsBrowserProfileStore,
} from '../src/platform/windows-browser-profile-store.js';

const nativeOnly = process.platform === 'win32' && process.arch === 'x64' ? false : 'native Windows x64 only';
const runAcl = (...args) => execFileSync('icacls.exe', args, { stdio: 'pipe', windowsHide: true });
const syntheticCapability = '*S-1-15-3-1024-1-2-3-4-5-6-7-8';
const userSid = () => execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  .match(/S-1-5-21-[\d-]+/u)[0];
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'usagemonitor-browser-profile-'));
  const adapter = createWindowsFilesystemAdapter();
  const root = join(directory, 'profile');
  adapter.ensureDirectory(root);
  try { await run({ adapter, root }); }
  finally {
    // Only the exact freshly-created synthetic tree is removed. Browser policy
    // ensures current-owner access before the fixture exits normally.
    const cache = join(root, 'Cache');
    try { runAcl(cache, '/grant:r', `*${userSid()}:(OI)(CI)(F)`); } catch {}
    for (const file of [join(root, 'Network', 'Cookies'), join(cache, 'synthetic.bin')]) {
      try { runAcl(file, '/grant:r', `*${userSid()}:(F)`); } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('browser profile capability refuses unbranded or generic adapters', () => {
  assert.throws(() => createWindowsBrowserProfileStore({ rootPath: 'C:\\synthetic', adapter: {
    browserProfileContractVersion: WINDOWS_BROWSER_PROFILE_CONTRACT,
    prepareBrowserProfile() {}, inspectBrowserProfile() {},
  } }), { code: 'windows_browser_profile_unavailable' });
});

test('native browser policy creates a missing private profile without leaking its cleanup handle', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const selected = join(root, 'new-profile');
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: selected });
  assert.equal(profile.ensureReady(), selected);
  assert.deepEqual(profile.inspectHealth(), { entries: 1, cookieDatabasePresent: false,
    cookieDatabaseBusy: false, cookieDatabaseBytes: 0 });
}));

test('native browser policy repairs capability-only encrypted-storage descendants without touching bytes', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const network = join(root, 'Network');
  const cache = join(root, 'Cache');
  adapter.ensureDirectory(network);
  adapter.ensureDirectory(cache);
  const cookie = join(network, 'Cookies');
  const cached = join(cache, 'synthetic.bin');
  const bytes = Buffer.from('synthetic encrypted storage bytes - not credentials');
  adapter.createFile(cookie, bytes);
  adapter.createFile(cached, bytes);
  const sid = userSid();
  // Emulate Chromium's observed old non-inheriting network capability ACL.
  runAcl(cookie, '/grant:r', `${syntheticCapability}:(M)`);
  runAcl(cookie, '/remove:g', `*${sid}`);
  runAcl(cache, '/grant:r', `${syntheticCapability}:(OI)(CI)(M)`);
  runAcl(cache, '/remove:g', `*${sid}`);
  await assert.rejects(readFile(cookie));
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  assert.equal(isWindowsBrowserProfileStore(profile), true);
  adapter.prepareBrowserProfile(root);
  assert.equal(profile.ensureReady(), root);
  assert.deepEqual(await readFile(cookie), bytes);
  assert.deepEqual(await readFile(cached), bytes);
  const facts = profile.inspectHealth();
  assert.equal(facts.cookieDatabasePresent, true);
  assert.equal(facts.cookieDatabaseBytes, bytes.length);
  // New browser-created objects inherit actual owner access, unlike records.
  await writeFile(join(network, 'Cookies-journal'), bytes);
  await mkdir(join(cache, 'new-directory'));
  await writeFile(join(cache, 'new-directory', 'new-file'), bytes);
  assert.doesNotThrow(() => profile.inspectHealth());
  assert.equal(profile.ensureReady(), root);
  assert.deepEqual(await readFile(cookie), bytes);
  const record = join(root, 'generic-record');
  adapter.ensureDirectory(record);
  assert.equal(adapter.inspectPath(record).daclProtected, true);
  const acl = execFileSync('icacls.exe', [record], { encoding: 'utf8', windowsHide: true });
  assert.doesNotMatch(acl, /\(OI\)|\(CI\)/u);
}));

test('native browser migration rejects broad grants and hard links', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  const file = join(root, 'synthetic.bin');
  adapter.createFile(file, Buffer.from('synthetic'));
  runAcl(file, '/grant:r', '*S-1-1-0:(R)');
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_security_policy' });
  runAcl(file, '/remove:g', '*S-1-1-0');
  runAcl(file, '/grant:r', '*S-1-15-3-1:(R)');
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_security_policy' });
  runAcl(file, '/remove:g', '*S-1-15-3-1');
  await link(file, join(root, 'hard-linked.bin'));
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_security_policy' });
}));

test('native browser migration rejects reparse descendants', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const target = join(root, 'target');
  adapter.ensureDirectory(target);
  await symlink(target, join(root, 'junction'), 'junction');
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_security_policy' });
}));

test('native browser health detects unreadable Cookie rather than treating it as empty', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  profile.ensureReady();
  const network = join(root, 'Network');
  await mkdir(network);
  const cookie = join(network, 'Cookies');
  await writeFile(cookie, 'synthetic');
  const sid = userSid();
  runAcl(cookie, '/inheritance:r', '/grant:r', `${syntheticCapability}:(M)`);
  runAcl(cookie, '/remove:g', `*${sid}`);
  try { assert.throws(() => profile.inspectHealth(), { code: 'windows_browser_profile_read_failed' }); }
  finally { runAcl(cookie, '/grant:r', `*${sid}:(F)`); }
}));

test('native browser health separates write denial and ignores mutable cache files', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  profile.ensureReady();
  const network = join(root, 'Network');
  await mkdir(network);
  const cookie = join(network, 'Cookies');
  await writeFile(cookie, 'synthetic');
  const cache = join(root, 'Cache');
  await mkdir(cache);
  const cacheFile = join(cache, 'synthetic.bin');
  await writeFile(cacheFile, 'synthetic');
  const active = await open(cacheFile, 'r+');
  try {
    assert.doesNotThrow(() => profile.inspectHealth());
  } finally { await active.close(); }
  execFileSync('attrib.exe', ['+R', cookie], { stdio: 'pipe', windowsHide: true });
  try { assert.throws(() => profile.inspectHealth(), { code: 'windows_browser_profile_write_failed' }); }
  finally { execFileSync('attrib.exe', ['-R', cookie], { stdio: 'pipe', windowsHide: true }); }
}));

test('native browser migration bounds descendant depth', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  profile.ensureReady();
  let directory = root;
  for (let depth = 0; depth < 33; depth += 1) { directory = join(directory, 'd'); await mkdir(directory); }
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_bound_exceeded' });
}));

test('legacy traversal repair does not propagate permissions to an unvalidated unsafe descendant', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const cache = join(root, 'Cache');
  adapter.ensureDirectory(cache);
  const unsafe = join(cache, 'synthetic.bin');
  adapter.createFile(unsafe, Buffer.from('synthetic'));
  runAcl(unsafe, '/grant:r', '*S-1-1-0:(R)', '/inheritance:e');
  runAcl(cache, '/grant:r', `${syntheticCapability}:(OI)(CI)(M)`);
  runAcl(cache, '/remove:g', `*${userSid()}`);
  const before = execFileSync('icacls.exe', [unsafe], { encoding: 'utf8', windowsHide: true });
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_security_policy' });
  const after = execFileSync('icacls.exe', [unsafe], { encoding: 'utf8', windowsHide: true });
  assert.equal(after, before);
}));

async function fill(directory, count) {
  await mkdir(directory, { recursive: true });
  for (let start = 0; start < count; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, count - start) }, (_, index) =>
      writeFile(join(directory, `cache-${String(start + index).padStart(5, '0')}`), 'synthetic disposable cache')));
  }
}
async function prepareUntilTerminal(profile) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try { return { ready: profile.ensureReady(), error: null }; }
    catch (error) {
      if (error.code !== 'windows_browser_profile_cache_cleanup_pending') return { error };
    }
  }
  assert.fail('bounded cache cleanup did not make retryable progress');
}

test('overflow cache cleanup is resumable and preserves browser durable state', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  profile.ensureReady();
  await mkdir(join(root, 'Network'));
  await mkdir(join(root, 'Service Worker', 'Database'), { recursive: true });
  await writeFile(join(root, 'Network', 'Cookies'), 'synthetic durable cookie database');
  await writeFile(join(root, 'Service Worker', 'Database', 'registration'), 'synthetic durable registration');
  await writeFile(join(root, 'retained-history'), 'synthetic durable history');
  await fill(join(root, 'Cache'), 8000);
  const before = (await readdir(join(root, 'Cache'))).length;
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_cache_cleanup_pending' });
  const after = (await readdir(join(root, 'Cache'))).length;
  assert.ok(after > 4096 && after < before, 'one bounded pass retains progress');
  const terminal = await prepareUntilTerminal(profile);
  assert.equal(terminal.error, null);
  assert.equal(terminal.ready, root);
  assert.equal(await readFile(join(root, 'Network', 'Cookies'), 'utf8'), 'synthetic durable cookie database');
  assert.equal(await readFile(join(root, 'Service Worker', 'Database', 'registration'), 'utf8'), 'synthetic durable registration');
  assert.equal(await readFile(join(root, 'retained-history'), 'utf8'), 'synthetic durable history');
}));

test('only fixed disposable cache roots are pruned on overflow', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  profile.ensureReady();
  for (const relative of ['Cache', 'Code Cache', 'Service Worker/CacheStorage']) {
    await fill(join(root, relative), 1500);
  }
  await mkdir(join(root, 'durable-cache-lookalike'));
  await writeFile(join(root, 'durable-cache-lookalike', 'keep'), 'synthetic durable sibling');
  assert.equal((await prepareUntilTerminal(profile)).error, null);
  assert.equal(await readFile(join(root, 'durable-cache-lookalike', 'keep'), 'utf8'), 'synthetic durable sibling');
}));

for (const unsafe of ['junction', 'hardlink', 'foreign-acl']) {
  test(`overflow cleanup refuses ${unsafe} descendants without changing linked or durable files`, { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
    const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
    profile.ensureReady();
    const durable = join(root, 'durable');
    await mkdir(durable);
    const sentinel = join(durable, 'keep');
    await writeFile(sentinel, 'synthetic durable sentinel');
    await fill(join(root, 'Cache'), 4200);
    const nested = join(root, 'Cache', 'unsafe-container');
    await mkdir(nested);
    const unsafeFile = join(nested, 'unsafe');
    if (unsafe === 'junction') await symlink(durable, unsafeFile, 'junction');
    if (unsafe === 'hardlink') await link(sentinel, unsafeFile);
    if (unsafe === 'foreign-acl') {
      await writeFile(unsafeFile, 'synthetic foreign ACL sentinel');
      runAcl(unsafeFile, '/grant:r', '*S-1-1-0:(R)');
    }
    try {
      const terminal = await prepareUntilTerminal(profile);
      assert.equal(terminal.error?.code, 'windows_browser_profile_security_policy');
      assert.equal(await readFile(sentinel, 'utf8'), 'synthetic durable sentinel');
      if (unsafe === 'foreign-acl') assert.equal(await readFile(unsafeFile, 'utf8'), 'synthetic foreign ACL sentinel');
    } finally {
      if (unsafe === 'foreign-acl') runAcl(unsafeFile, '/remove:g', '*S-1-1-0');
    }
  }));
}

test('overflow outside disposable cache still fails the durable tree bound', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  profile.ensureReady();
  await fill(join(root, 'retained-state'), 4100);
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_bound_exceeded' });
  assert.equal((await readdir(join(root, 'retained-state'))).length, 4100);
}));

test('overflow cleanup refuses malicious siblings without following their target', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  profile.ensureReady();
  await fill(join(root, 'Cache'), 4100);
  await mkdir(join(root, 'durable'));
  await writeFile(join(root, 'durable', 'keep'), 'synthetic durable sentinel');
  await symlink(join(root, 'durable'), join(root, 'unsafe-sibling'), 'junction');
  assert.throws(() => profile.ensureReady(), { code: 'windows_browser_profile_security_policy' });
  assert.equal(await readFile(join(root, 'durable', 'keep'), 'utf8'), 'synthetic durable sentinel');
  assert.equal((await readdir(join(root, 'Cache'))).length, 4100);
}));

test('overflow cleanup repairs only validated legacy cache handles before deletion', { skip: nativeOnly }, async () => fixture(async ({ adapter, root }) => {
  const profile = createWindowsBrowserProfileStore({ adapter, rootPath: root });
  profile.ensureReady();
  await fill(join(root, 'Cache'), 4200);
  const directory = join(root, 'Cache', '000-legacy');
  const file = join(directory, 'legacy');
  await mkdir(directory);
  await writeFile(file, 'synthetic legacy disposable cache');
  runAcl(file, '/inheritance:r', '/grant:r', `${syntheticCapability}:(M)`);
  runAcl(file, '/remove:g', `*${userSid()}`);
  runAcl(directory, '/inheritance:r', '/grant:r', `${syntheticCapability}:(OI)(CI)(M)`);
  runAcl(directory, '/remove:g', `*${userSid()}`);
  try {
    assert.equal((await prepareUntilTerminal(profile)).error, null);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally {
    try { runAcl(directory, '/grant:r', `*${userSid()}:(OI)(CI)(F)`); } catch {}
    try { runAcl(file, '/grant:r', `*${userSid()}:(F)`); } catch {}
  }
}));
