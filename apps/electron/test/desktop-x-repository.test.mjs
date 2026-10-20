import test from 'node:test';
import assert from 'node:assert/strict';
import { createXRepository, createDesktopXRepository } from '../desktop-x-repository.js';

const partition = '12345678-1234-4234-8234-123456789abc';

test('session checkpoints persist only a validated digest and fail visibly on write or read corruption', async () => {
  const f = fixture(); const value = { version: 1, digest: 'a'.repeat(64) };
  assert.equal(await f.repository.readSessionCheckpoint(partition), null);
  await f.repository.writeSessionCheckpoint(partition, value);
  assert.deepEqual(await f.make().readSessionCheckpoint(partition), value);
  assert.throws(() => f.repository.writeSessionCheckpoint('../escape', value));
  assert.throws(() => f.repository.writeSessionCheckpoint(partition, { ...value, cookie: 'synthetic-private' }));
  const name = `x-session-checkpoint-${partition}.json`;
  f.fail(name);
  await assert.rejects(f.repository.writeSessionCheckpoint(partition, { ...value, digest: 'b'.repeat(64) }), { code: 'session_persist_failed' });
  assert.deepEqual(await f.repository.readSessionCheckpoint(partition), value);
  f.files.set(name, Buffer.from('{invalid'));
  await assert.rejects(f.repository.readSessionCheckpoint(partition), { code: 'session_read_failed' });
});
function post(id, text = 'synthetic public post') {
  return { id, author: { name: 'Synthetic', handle: 'synthetic' }, createdAt: '2026-10-20T01:00:00.000Z', text, complete: true, kind: 'post', media: [] };
}
function fixture() {
  const files = new Map();
  let fail = null;
  const storage = {
    async readJson(name) { return files.has(name) ? JSON.parse(files.get(name).toString()) : null; },
    async writeJson(name, value) {
      if (fail === name) { fail = null; throw Error('synthetic write failure'); }
      files.set(name, Buffer.from(JSON.stringify(value)));
      if (fail === `after:${name}`) { fail = null; throw Error('synthetic interruption after publication'); }
    },
    async read(name) { if (!files.has(name)) throw Error('synthetic missing'); return Buffer.from(files.get(name)); },
    async create(name, bytes) {
      assert.ok(bytes.length <= 256 * 1024);
      if (fail === 'chunk') { fail = null; throw Error('synthetic chunk failure'); }
      assert.ok(!files.has(name)); files.set(name, Buffer.from(bytes));
    },
    async remove(name) { files.delete(name); },
  };
  const sessionPaths = [];
  const make = () => createXRepository({ storage, sessionPath: async id => { sessionPaths.push(id); return `protected:${id}`; } });
  return { files, storage, repository: make(), make, sessionPaths, fail(value) { fail = value; } };
}

test('settings persist without login; multi-chunk text remains exact and prior posts survive subsequent writes', async () => {
  const f = fixture();
  const initial = await f.repository.read();
  assert.equal(initial.settings.refreshMinutes, 5);
  assert.equal(initial.activePartition, null);
  initial.settings.refreshMinutes = -1;
  await f.repository.write(initial);
  const state = await f.make().read();
  assert.equal(state.settings.refreshMinutes, -1);
  state.activePartition = partition; state.authScope = partition;
  state.posts = [post('1', '🧪'.repeat(45000)), post('2', 'x'.repeat(100000))];
  state.lists.posts = ['1', '2'];
  await f.repository.write(state);
  assert.deepEqual(await f.make().read(), state);
  assert.ok([...f.files.keys()].filter(name => name.endsWith('.bin')).length > 1);
  const later = structuredClone(state);
  later.posts = [post('3')]; later.lists.posts = ['3'];
  await f.repository.write(later);
  assert.deepEqual((await f.make().read()).posts.map(value => value.id), ['1', '2', '3']);
});

test('failed chunk or pointer publication preserves previous committed snapshot and journal resumes exact cleanup', async () => {
  for (const failure of ['chunk', 'x-reader-v1.json']) {
    const f = fixture();
    const old = await f.repository.read(); old.posts = [post('1')]; old.lists.posts = ['1'];
    await f.repository.write(old);
    f.files.set('unrelated.bin', Buffer.from('preserve'));
    f.fail(failure);
    const next = structuredClone(old); next.posts.push(post('2')); next.lists.posts.push('2');
    await assert.rejects(f.repository.write(next));
    assert.deepEqual(await f.make().read(), old);
    await f.make().write(old);
    assert.equal(f.files.get('unrelated.bin').toString(), 'preserve');
    assert.equal(f.files.has('x-reader-pending-v1.json'), false);
    assert.equal([...f.files.keys()].filter(name => name.startsWith('x-cache-')).length, 1);
  }
});

test('explicit cache clearing preserves settings, session and notification history', async () => {
  const f = fixture(); const value = await f.repository.read();
  value.activePartition = partition; value.authScope = partition;
  value.settings.notifyPosts = true;
  value.posts = [post('10')]; value.lists.posts = ['10'];
  value.notificationBaseline = { posts: ['0', '10'], replies: ['0'] };
  await f.repository.write(value);
  assert.ok(f.repository.cacheBytes > 0);
  const cleared = await f.repository.clearCache();
  assert.deepEqual(cleared.posts, []);
  assert.deepEqual(cleared.notificationBaseline, value.notificationBaseline);
  assert.deepEqual(cleared.settings, value.settings);
  assert.equal(cleared.activePartition, partition);
  assert.equal(cleared.authScope, partition);
  assert.equal(f.repository.cacheBytes, 0);
  assert.deepEqual(await f.make().read(), cleared);
});

test('session replacement archives prior scope without displaying it; explicit clear removes archived text but keeps baselines', async () => {
  const f = fixture(); const first = await f.repository.read();
  first.activePartition = partition; first.authScope = partition;
  first.posts = [post('1', 'synthetic prior scope retained text')]; first.lists.posts = ['1'];
  first.notificationBaseline.posts = ['0', '1'];
  await f.repository.write(first);
  const second = structuredClone(first);
  second.activePartition = 'abcdef12-1234-4234-8234-123456789abc'; second.authScope = second.activePartition;
  second.posts = [post('2')]; second.lists.posts = ['2']; second.notificationBaseline.posts = ['0', '2'];
  await f.repository.write(second);
  assert.deepEqual((await f.make().read()).posts.map(item => item.id), ['2']);
  const decode = () => JSON.parse(Buffer.concat([...f.files.entries()].filter(([name]) => name.endsWith('.bin')).sort(([a], [b]) => Number(a.match(/-(\d+)\.bin$/)[1]) - Number(b.match(/-(\d+)\.bin$/)[1])).map(([, bytes]) => bytes)).toString());
  assert.equal(decode().archives[0].posts[0].text, 'synthetic prior scope retained text');
  assert.ok(f.repository.cacheBytes > Buffer.byteLength(JSON.stringify({ posts: second.posts, lists: second.lists })));
  await f.repository.clearCache();
  assert.deepEqual(decode().archives[0].posts, []);
  assert.deepEqual(decode().archives[0].notificationBaseline.posts, ['0', '1']);
  assert.deepEqual((await f.make().read()).notificationBaseline.posts, ['0', '2']);
});

test('interruption after atomic publication never removes the newly committed generation', async () => {
  const f = fixture(); const first = await f.repository.read();
  await f.repository.write(first);
  const next = structuredClone(first); next.posts = [post('1')]; next.lists.posts = ['1'];
  f.fail('after:x-reader-v1.json');
  await assert.rejects(f.repository.write(next));
  assert.deepEqual(await f.make().read(), next);
  await f.make().write(next);
  assert.deepEqual(await f.make().read(), next);
  assert.equal(f.files.has('x-reader-pending-v1.json'), false);
});

test('corrupt/future state fails closed instead of overwriting or returning empty', async () => {
  const f = fixture(); const value = await f.repository.read();
  value.posts = [post('1')]; value.lists.posts = ['1'];
  await f.repository.write(value);
  const saved = Buffer.from(f.files.get('x-reader-v1.json'));
  const pointer = JSON.parse(saved);
  f.files.set('x-reader-v1.json', Buffer.from(JSON.stringify({ ...pointer, version: 2 })));
  await assert.rejects(f.repository.read(), { code: 'invalid_x_state' });
  await assert.rejects(f.repository.write(value), { code: 'invalid_x_state' });
  f.files.set('x-reader-v1.json', saved);
  const chunk = [...f.files.keys()].find(name => name.startsWith('x-cache-'));
  f.files.get(chunk)[1] ^= 1;
  await assert.rejects(f.repository.read(), { code: 'invalid_x_state' });
  await assert.rejects(f.repository.clearCache(), { code: 'invalid_x_state' });
});

test('unsafe IDs, unknown snapshot fields and unbranded production storage are refused; post extras are omitted', async () => {
  const f = fixture(); const value = await f.repository.read();
  for (const id of ['../escape', 'persist:123', '', `${partition}/child`, partition.toUpperCase()]) await assert.rejects(f.repository.getSessionPath(id), { code: 'invalid_x_state' });
  assert.deepEqual(f.sessionPaths, []);
  assert.equal(await f.repository.getSessionPath(partition), `protected:${partition}`);
  assert.throws(() => f.repository.write({ ...value, cookies: [] }), { code: 'invalid_x_state' });
  assert.throws(() => createDesktopXRepository({ store: f.storage, createSessionStore() {} }), { code: 'invalid_x_state' });
  const extra = post('1'); extra.cookie = 'synthetic-noncredential-marker'; extra.author.token = 'synthetic-unused';
  value.posts = [extra]; value.lists.posts = ['1'];
  await f.repository.write(value);
  assert.ok(!Buffer.concat([...f.files.values()]).toString().includes('synthetic-noncredential-marker'));
  assert.deepEqual((await f.repository.read()).posts, [post('1')]);
});
