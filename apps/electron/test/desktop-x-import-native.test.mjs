import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildDesktopXImportNative, createDesktopXImportForTest } from '../desktop-x-import.js';
import { X_IMPORT_ORIGIN, encodeXImportFrame, createXImportFrameReader } from '../x-import/contract.js';
import { createWindowsFilesystemAdapter, createWindowsProtectedStateStore, loadWindowsLegacyStateReadBinding } from '../../../src/platform/index.js';

test('native synthetic bridge setup, framed import and cancellation need no registry or real browser session',
  { skip: process.platform !== 'win32' || process.arch !== 'x64', timeout: 30000 }, async t => {
    const native = loadWindowsLegacyStateReadBinding({ bindingPath: resolve('native/windows-filesystem/build/Release/windows_filesystem.node') });
    const root = resolve('.release-build', 'x-native-' + randomUUID().replaceAll('-', '')), source = join(root, 's'), target = join(root, 't');
    for (const path of [root, source, target]) native.ensureDirectory(path);
    for (const name of ['manifest.json', 'popup.js', 'popup.html']) await copyFile(new URL('../x-import/' + name, import.meta.url), join(source, name));
    // An installed app may already own the production per-user pipe. Compile
    // the same relay with a fixture-only namespace; never connect to that app.
    const relay = await readFile(new URL('../x-import/NativeHost.cs', import.meta.url), 'utf8');
    assert.equal(relay.split('"UsageMonitor.XImport."').length, 2);
    await writeFile(join(source, 'NativeHost.cs'), relay.replace('"UsageMonitor.XImport."', '"UsageMonitor.XFixture.' + randomUUID().replaceAll('-', '') + '."'));
    await buildDesktopXImportNative({ sourceDirectory: source, outputPath: join(source, 'UsageMonitorXImport.exe') });
    const store = createWindowsProtectedStateStore({ adapter: createWindowsFilesystemAdapter(), rootPath: target });
    let registrations = 0, calls = 0, revealed = null, configured = false;
    const importer = createDesktopXImportForTest({ protectedStore: store, sourceDirectory: source,
      revealFolder: path => { revealed = path; },
      onImport: async cookies => { calls++; assert.equal(cookies.length, 2); return { ok: true, code: 'verification_pending' }; },
    }, { register: async () => { registrations++; configured = true; }, verify: async () => configured });
    t.after(() => importer.dispose());
    assert.equal((await importer.begin()).code, 'not_configured');
    assert.equal((await importer.configure()).configured, true); assert.equal(registrations, 1);
    await importer.reveal(); assert.equal(revealed, join(target, 'manifest.json'));
    const executable = join(target, 'UsageMonitorXImport.exe');
    async function message(value, origin = X_IMPORT_ORIGIN) {
      return new Promise((resolveResult, reject) => {
        const child = spawn(executable, [origin], { windowsHide: true, env: { SystemRoot: process.env.SystemRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { child.kill(); reject(Error('synthetic_native_timeout')); }, 8000);
        let response = null, failed = false;
        child.stdout.on('data', createXImportFrameReader(v => { response = v; }, () => { failed = true; }));
        child.stderr.resume(); child.once('error', () => { clearTimeout(timer); reject(Error('synthetic_native_launch_failed')); });
        child.once('close', code => { clearTimeout(timer); if (failed) reject(Error('synthetic_frame_failed')); else resolveResult({ code, response }); });
        child.stdin.on('error', () => {}); child.stdin.end(encodeXImportFrame(value));
      });
    }
    assert.deepEqual(await message({ version: 1, type: 'bridge-check' }), { code: 0, response: { ok: true, code: 'bridge_ready' } });
    assert.equal(calls, 0);
    assert.equal((await importer.begin()).pending, true); assert.equal(registrations, 1);
    const permit = (await message({ version: 1, type: 'import-preflight' })).response.permit;
    const cookies = ['auth_token', 'ct0'].map(name => ({ name, value: 'synthetic-not-a-real-session', domain: '.x.com', path: '/', secure: true,
      hostOnly: false, httpOnly: name === 'auth_token', sameSite: 'lax', session: true }));
    assert.deepEqual((await message({ version: 1, type: 'x-cookie-import', permit, cookies })).response, { ok: true, code: 'verification_pending' });
    assert.equal(calls, 1);
    await importer.begin(); const cancelled = (await message({ version: 1, type: 'import-preflight' })).response.permit; importer.cancel();
    assert.equal((await message({ version: 1, type: 'x-cookie-import', permit: cancelled, cookies })).response.code, 'import_expired'); assert.equal(calls, 1);
    assert.equal((await message({ version: 1, type: 'bridge-check' }, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/')).code, 2);
    assert.equal(registrations, 1);
    assert.ok(JSON.parse(await readFile(join(target, 'setup-receipt-v1.json'), 'utf8')).packageHash);
  });
