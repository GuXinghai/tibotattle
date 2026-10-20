import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createXImportRequestGate } from '../desktop-x-import.js';
import { normalizeXImportCookies, createXImportFrameReader, encodeXImportFrame, X_IMPORT_EXTENSION_ID, X_IMPORT_MAX_BYTES } from '../x-import/contract.js';

const cookie = (name, extra = {}) => ({ domain: '.x.com', hostOnly: false, httpOnly: name === 'auth_token', name, value: 'synthetic-only', path: '/', sameSite: 'lax', secure: true, session: true, ...extra });
const cookies = () => [cookie('auth_token'), cookie('ct0')];
const preflight = gate => gate.handle({ version: 1, type: 'import-preflight' });
const request = (permit, value = cookies()) => ({ version: 1, type: 'x-cookie-import', permit, cookies: value });

test('preflight never imports; only an active short-lived one-use permit can deliver cookies', async () => {
  let at = 0, calls = 0;
  const gate = createXImportRequestGate({ now: () => at, token: () => 'a'.repeat(64), onImport: async value => { calls++; assert.equal(value[0].httpOnly, true); } });
  assert.equal((await preflight(gate)).code, 'import_not_pending');
  assert.equal((await gate.handle({ version: 1, type: 'bridge-check' })).code, 'bridge_ready');
  assert.equal(calls, 0);
  gate.begin(); const permit = (await preflight(gate)).permit;
  assert.equal((await gate.handle(request('b'.repeat(64)))).code, 'import_expired');
  assert.equal((await gate.handle(request(permit))).code, 'imported');
  assert.equal((await gate.handle(request(permit))).code, 'import_expired');
  assert.equal(calls, 1);
  gate.begin(); const expired = (await preflight(gate)).permit; at = 120001;
  assert.equal((await gate.handle(request(expired))).code, 'import_expired');
});

test('cancel and replacement invalidate an in-flight candidate and late result', async () => {
  let release, candidate;
  const gate = createXImportRequestGate({ onImport: async (_cookies, permit) => { candidate = permit; await new Promise(resolve => { release = resolve; }); } });
  gate.begin(); const old = (await preflight(gate)).permit;
  const result = gate.handle(request(old));
  assert.equal(candidate.isCurrent(), true); gate.cancel(); assert.equal(candidate.isCurrent(), false);
  gate.begin(); release(); assert.equal((await result).code, 'import_expired');
  assert.equal(gate.status().pending, true);
  gate.dispose(); assert.equal((await preflight(gate)).code, 'invalid_import');
});

test('delivery acknowledgement does not falsely claim X authentication succeeded', async () => {
  const gate = createXImportRequestGate({ onImport: async () => ({ ok: true, code: 'verification_pending' }) });
  gate.begin(); const permit = (await preflight(gate)).permit;
  assert.deepEqual(await gate.handle(request(permit)), { ok: true, code: 'verification_pending' });
  assert.equal(gate.status().pending, false);
});

test('closed cookie attributes preserve host-only, HttpOnly, secure, SameSite and expiration', () => {
  const expires = Date.now() / 1000 + 300;
  const result = normalizeXImportCookies([...cookies(), cookie('__Host-extra', { domain: 'x.com', hostOnly: true, sameSite: 'strict', session: false, expirationDate: expires })]);
  assert.equal(Object.hasOwn(result[2], 'domain'), false);
  assert.equal(result[2].expirationDate, expires);
  assert.equal(result[2].sameSite, 'strict');
  for (const change of [{ domain: '.evilx.com' }, { domain: '.x.com.evil.test' }, { value: 'bad\r\nvalue' }, { partitionKey: {} }, { extra: true }, { secure: false }, { expirationDate: expires }]) {
    assert.throws(() => normalizeXImportCookies([cookie('auth_token', change), cookie('ct0')]));
  }
  assert.throws(() => normalizeXImportCookies([...cookies(), cookie('ct0')]));
  assert.throws(() => normalizeXImportCookies([cookie('ct0')]));
});

test('binary transport handles fragmented frames and refuses invalid UTF8, oversized or malformed JSON', () => {
  const values = []; let failures = 0;
  const read = createXImportFrameReader(value => values.push(value), () => failures++);
  const frame = encodeXImportFrame({ version: 1, type: 'bridge-check' });
  read(frame.subarray(0, 2)); read(frame.subarray(2));
  assert.equal(values[0].type, 'bridge-check'); assert.equal(failures, 0);
  for (const bytes of [Buffer.from([255, 255, 255, 127]), Buffer.from([2, 0, 0, 0, 255, 255]), Buffer.from([2, 0, 0, 0, 123, 123])]) {
    let rejected = false; createXImportFrameReader(() => assert.fail(), () => { rejected = true; })(bytes); assert.equal(rejected, true);
  }
  assert.throws(() => encodeXImportFrame({ value: 'a'.repeat(X_IMPORT_MAX_BYTES) }));
});

test('extension identity is pinned; reader has no persisted cookies, remote scripts or broad host access', async () => {
  const manifest = JSON.parse(await readFile(new URL('../x-import/manifest.json', import.meta.url), 'utf8'));
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...digest].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
  assert.equal(id, X_IMPORT_EXTENSION_ID);
  assert.deepEqual(manifest.host_permissions, ['https://x.com/*', 'https://*.x.com/*']);
  assert.equal(manifest.incognito, 'not_allowed'); assert.equal(manifest.background, undefined);
  const popup = await readFile(new URL('../x-import/popup.js', import.meta.url), 'utf8');
  assert.ok(popup.indexOf("type: 'import-preflight'") < popup.indexOf('chrome.cookies.getAllCookieStores'));
  assert.doesNotMatch(popup, /chrome\.storage|clipboard|console\.|fetch\(/);
});
