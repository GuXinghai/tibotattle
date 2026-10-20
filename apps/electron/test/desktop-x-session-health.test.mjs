import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopXSessionHealth } from '../desktop-x-session-health.js';

function fixture() {
  let saved = null; const jar = ['auth_token', 'ct0'].map(name => ({ name, value: 'synthetic-not-an-authentication-secret', domain: '.x.com' }));
  const repository = { checkSessionHealth: async () => ({ cookieDatabasePresent: true, cookieDatabaseBytes: 20480 }), readSessionCheckpoint: async () => saved, writeSessionCheckpoint: async (_id, proof) => { saved = structuredClone(proof); } };
  const runtime = { safeStorage: { isEncryptionAvailable: () => true } };
  const session = { clearStorageData: async () => { jar.length = 0; }, cookies: { set: async cookie => { jar.push({ ...cookie }); }, get: async filter => jar.filter(cookie => filter.domain ? cookie.domain === '.x.com' : filter.url ? cookie.url === filter.url : true).map(cookie => ({ ...cookie })), flushStore: async () => {} } };
  const health = createDesktopXSessionHealth({ runtime, repository, clock: () => 1000000 });
  return { health, session, repository, runtime, jar, saved: () => saved };
}
const reject = () => { throw new Error('Private synthetic path and diagnostic details must not escape'); };

test('persistence marker stores only digest and detects a silently empty restored cookie store', async () => {
  const f = fixture(); assert.equal(await f.health.verify(f.session, 'synthetic'), false);
  await f.health.checkpoint(f.session, 'synthetic'); assert.match(f.saved().digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(f.saved()), ['version', 'digest']); assert.equal(await f.health.verify(f.session, 'synthetic'), true);
  f.jar.length = 0;
  await assert.rejects(f.health.verify(f.session, 'synthetic'), { code: 'session_restore_failed', message: 'session_restore_failed' });
});

test('legacy empty auth remains a local restore failure, never an inferred remote expiry', async () => {
  const f = fixture(); f.jar.length = 0;
  await assert.rejects(f.health.verify(f.session, 'synthetic'), { code: 'session_restore_failed' }); assert.equal(f.saved(), null);
});

test('a resolved flush without a nonempty on-disk Cookie database is not accepted as persistent', async () => {
  for (const metadata of [{ cookieDatabasePresent: false, cookieDatabaseBytes: 0 }, { cookieDatabasePresent: true, cookieDatabaseBytes: 0 }]) {
    const f = fixture(); f.repository.checkSessionHealth = async () => metadata;
    await assert.rejects(f.health.checkpoint(f.session, 'synthetic'), { code: 'session_persist_failed' });
    assert.equal(f.saved(), null);
  }
});

test('cookie set, readback and durable flush failures retain separate content-free errors', async () => {
  for (const [mutate, code] of [
    [f => { f.session.cookies.set = reject; }, 'session_write_failed'],
    [f => { f.session.cookies.set = async () => {}; }, 'session_write_failed'],
    [f => { f.session.cookies.get = reject; }, 'session_read_failed'],
    [f => { f.session.cookies.flushStore = reject; }, 'session_persist_failed'],
    [f => { f.repository.writeSessionCheckpoint = reject; }, 'session_persist_failed'],
    [f => { f.repository.checkSessionHealth = reject; }, 'session_permission_failed'],
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.health.checkpoint(f.session, 'synthetic'), { code, message: code }); assert.equal(f.saved(), null);
  }
});

test('only explicit decrypt evidence or unavailable OS encryption produces decrypt error', async () => {
  const f = fixture(); f.runtime.safeStorage.isEncryptionAvailable = () => false;
  await assert.rejects(f.health.verify(f.session, 'synthetic'), { code: 'session_decrypt_failed' });
  const g = fixture(); g.session.cookies.get = () => { throw Object.assign(new Error('private'), { code: 'session_decrypt_failed' }); };
  await assert.rejects(g.health.verify(g.session, 'synthetic'), { code: 'session_decrypt_failed', message: 'session_decrypt_failed' });
  const h = fixture(); h.session.cookies.get = () => { throw Object.assign(new Error('decrypt private'), { code: 'UNKNOWN_UPSTREAM_CODE' }); };
  await assert.rejects(h.health.verify(h.session, 'synthetic'), { code: 'session_read_failed' });
  const unavailable = fixture(); delete unavailable.runtime.safeStorage;
  await assert.rejects(unavailable.health.verify(unavailable.session, 'synthetic'), { code: 'session_decrypt_failed' });
});

test('clear, clear flush and silent incomplete clear are observable', async () => {
  for (const mutate of [f => { f.session.clearStorageData = reject; }, f => { f.session.cookies.flushStore = reject; }, f => { f.session.clearStorageData = async () => {}; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.health.clear(f.session, 'synthetic'), { code: 'session_clear_failed', message: 'session_clear_failed' });
  }
});
