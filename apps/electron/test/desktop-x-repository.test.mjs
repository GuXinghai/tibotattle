import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('session cleanup receipts survive reopening, deduplicate and retain promoted checkpoints', async () => {
  const f = fixture(); const proof = { version: 1, digest: 'a'.repeat(64) };
  assert.deepEqual(await f.repository.listSessionCleanup(), { partitions: [], pendingClear: [] });
  await f.repository.writeSessionCheckpoint(partition, proof);
  await Promise.all([f.repository.queueSessionCleanup(partition), f.repository.queueSessionCleanup(partition)]);
  assert.deepEqual(await f.make().listSessionCleanup(), { partitions: [partition], pendingClear: [partition] });
  await f.make().retainSession(partition);
  assert.deepEqual(await f.repository.listSessionCleanup(), { partitions: [partition], pendingClear: [] });
  assert.deepEqual(await f.repository.readSessionCheckpoint(partition), proof);
});

test('verified cleanup removes only the selected checkpoint and retries failed acknowledgement', async () => {
  const f = fixture(); const other = 'abcdef12-1234-4234-8234-123456789abc';
  const proof = { version: 1, digest: 'a'.repeat(64) };
  for (const id of [partition, other]) { await f.repository.queueSessionCleanup(id); await f.repository.writeSessionCheckpoint(id, proof); }
  f.files.set('unrelated.bin', Buffer.from('preserve'));
  f.fail('x-session-registry-v1.json');
  await assert.rejects(f.repository.completeSessionCleanup(partition), { code: 'session_persist_failed' });
  assert.deepEqual(await f.make().listSessionCleanup(), { partitions: [partition, other], pendingClear: [partition, other] });
  assert.equal(await f.repository.readSessionCheckpoint(partition), null);
  await f.make().completeSessionCleanup(partition);
  assert.deepEqual(await f.repository.listSessionCleanup(), { partitions: [other], pendingClear: [other] });
  assert.deepEqual(await f.repository.readSessionCheckpoint(other), proof);
  assert.equal(f.files.get('unrelated.bin').toString(), 'preserve');
});

test('checkpoint deletion failure keeps the durable cleanup receipt', async () => {
  const f = fixture(); await f.repository.queueSessionCleanup(partition);
  await f.repository.writeSessionCheckpoint(partition, { version: 1, digest: 'a'.repeat(64) });
  const remove = f.storage.remove;
  f.storage.remove = async name => { if (name === `x-session-checkpoint-${partition}.json`) throw Error('synthetic'); return remove(name); };
  await assert.rejects(f.repository.completeSessionCleanup(partition), { code: 'session_clear_failed' });
  assert.deepEqual(await f.make().listSessionCleanup(), { partitions: [partition], pendingClear: [partition] });
  f.storage.remove = async () => {};
  await assert.rejects(f.repository.completeSessionCleanup(partition), { code: 'session_clear_failed' });
  assert.deepEqual(await f.make().listSessionCleanup(), { partitions: [partition], pendingClear: [partition] });
  f.storage.remove = remove;
  await f.make().completeSessionCleanup(partition);
  assert.deepEqual(await f.repository.listSessionCleanup(), { partitions: [], pendingClear: [] });
});

test('interruption after clear-intent publication keeps the receipt on reopen', async () => {
  const f = fixture(); await f.repository.registerSession(partition);
  f.fail('after:x-session-registry-v1.json');
  await assert.rejects(f.repository.queueSessionCleanup(partition), { code: 'session_persist_failed' });
  assert.deepEqual(await f.make().listSessionCleanup(), { partitions: [partition], pendingClear: [partition] });
  await f.make().queueSessionCleanup(partition);
  assert.deepEqual(await f.repository.listSessionCleanup(), { partitions: [partition], pendingClear: [partition] });
});

test('cleanup journal refuses future, malformed, duplicate and oversized records without mutation', async () => {
  const f = fixture(); const name = 'x-session-registry-v1.json';
  for (const bad of [{ version: 2, partitions: [], pendingClear: [] }, { version: 1, partitions: [partition, partition], pendingClear: [] }, { version: 1, partitions: ['../escape'], pendingClear: [] }, { version: 1, partitions: [], pendingClear: [], extra: true }, { version: 1, partitions: Array(65).fill(partition), pendingClear: [] }, { version: 1, partitions: [], pendingClear: [partition] }, { version: 1, partitions: [partition], pendingClear: [partition, partition] }]) {
    const bytes = Buffer.from(JSON.stringify(bad)); f.files.set(name, bytes);
    await assert.rejects(f.repository.listSessionCleanup(), { code: 'session_read_failed' });
    await assert.rejects(f.repository.queueSessionCleanup(partition), { code: 'session_read_failed' });
    await assert.rejects(f.repository.retainSession(partition), { code: 'session_read_failed' });
    await assert.rejects(f.repository.completeSessionCleanup(partition), { code: 'session_read_failed' });
    assert.deepEqual(f.files.get(name), bytes);
  }
  assert.throws(() => f.repository.queueSessionCleanup('../escape'), { code: 'invalid_x_state' });
  assert.throws(() => f.repository.completeSessionCleanup('../escape'), { code: 'invalid_x_state' });
});

test('cleanup queue refuses overflow without evicting cleanup obligations and verifies writes', async () => {
  const f = fixture(); const name = 'x-session-registry-v1.json';
  const partitions = Array.from({ length: 64 }, (_, index) => `${index.toString(16).padStart(8, '0')}-1234-4234-8234-123456789abc`);
  f.files.set(name, Buffer.from(JSON.stringify({ version: 1, partitions, pendingClear: [] })));
  await assert.rejects(f.repository.queueSessionCleanup(partition), { code: 'session_persist_failed' });
  assert.deepEqual(await f.repository.listSessionCleanup(), { partitions, pendingClear: [] });
  f.files.delete(name); f.storage.writeJson = async () => {};
  await assert.rejects(f.repository.queueSessionCleanup(partition), { code: 'session_persist_failed' });
});

test('registry keeps accepted sessions while preserving explicit logout intent across reopening', async () => {
  const f = fixture(); const other = 'abcdef12-1234-4234-8234-123456789abc';
  await f.repository.registerSession(partition);
  await f.repository.registerSession(other);
  await f.repository.retainSession(partition);
  assert.deepEqual(await f.make().listSessionCleanup(), { partitions: [partition, other], pendingClear: [] });
  await f.repository.queueSessionCleanup(partition);
  assert.deepEqual(await f.make().listSessionCleanup(), { partitions: [partition, other], pendingClear: [partition] });
  // Pointer writes never erase the registry or explicit clear intent.
  const state = await f.repository.read(); state.activePartition = partition; state.authScope = partition;
  await f.repository.write(state);
  assert.deepEqual(await f.make().listSessionCleanup(), { partitions: [partition, other], pendingClear: [partition] });
  await f.make().completeSessionCleanup(partition);
  assert.deepEqual(await f.repository.listSessionCleanup(), { partitions: [other], pendingClear: [] });
});

test('logout cache is readable but is not archived a second time on relogin', async () => {
  const f = fixture(); const value = await f.repository.read();
  value.authScope = partition; value.activePartition = partition;
  value.posts = [post('1')]; value.lists.posts = ['1'];
  await f.repository.write(value);
  const logout = structuredClone(value); logout.authScope = null; logout.activePartition = null; logout.notificationBaseline = { posts: { floor: null, seen: [] }, replies: { floor: null, seen: [] } };
  await f.repository.write(logout);
  assert.deepEqual((await f.make().read()).posts, value.posts);
  const next = structuredClone(value); next.authScope = 'abcdef12-1234-4234-8234-123456789abc'; next.activePartition = next.authScope; next.posts = [post('2')]; next.lists.posts = ['2'];
  await f.make().write(next);
  const selected = JSON.parse(f.files.get('x-reader-v1.json'));
  const data = JSON.parse(Buffer.concat(Array.from({ length: selected.chunks }, (_, index) => f.files.get(`x-cache-${selected.generation}-${index}.bin`))).toString());
  assert.equal(data.archives.length, 1);
  assert.equal(data.archives[0].authScope, partition);
  assert.deepEqual(data.archives[0].posts, value.posts);
  assert.deepEqual((await f.repository.read()).posts, next.posts);
});

test('legacy notification snapshots migrate read-only then publish a v2 envelope without replaying old IDs', async () => {
  const f = fixture(); const old = await f.repository.read();
  old.version = 1; old.activePartition = partition; old.authScope = partition;
  old.posts = [post('1')]; old.lists.posts = ['1'];
  old.notificationBaseline = { posts: ['0', '10', '9'], replies: ['0'] };
  const archived = structuredClone(old); archived.notificationBaseline = { posts: [], replies: ['0', '8'] };
  const bytes = Buffer.from(JSON.stringify({ version: 1, current: old, archives: [archived] }));
  const selected = { version: 1, generation: partition, chunks: 1, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  f.files.set(`x-cache-${partition}-0.bin`, bytes);
  f.files.set('x-reader-v1.json', Buffer.from(JSON.stringify(selected)));
  const before = new Map([...f.files].map(([name, data]) => [name, Buffer.from(data)]));
  const migrated = await f.repository.read();
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.notificationBaseline, { posts: { floor: '10', seen: [] }, replies: { floor: '0', seen: [] } });
  assert.deepEqual(f.files, before, 'reading does not rewrite legacy evidence');
  await f.repository.write(migrated);
  const pointer = JSON.parse(f.files.get('x-reader-v1.json'));
  const published = JSON.parse(f.files.get(`x-cache-${pointer.generation}-0.bin`));
  assert.equal(published.version, 2); assert.equal(published.current.version, 2); assert.equal(published.archives[0].version, 2);
  assert.deepEqual(published.archives[0].notificationBaseline, { posts: { floor: null, seen: [] }, replies: { floor: '8', seen: [] } });
  // The old envelope reader refuses v2 rather than modifying the new baseline.
  assert.notEqual(published.version, 1);
});

test('v2 notification state remains bounded and future envelope versions fail closed', async () => {
  const f = fixture(); const value = await f.repository.read();
  value.notificationBaseline.posts = { floor: '10', seen: ['11', '12'] };
  await f.repository.write(value); assert.deepEqual((await f.make().read()).notificationBaseline, value.notificationBaseline);
  for (const category of [{ floor: '10', seen: ['10'] }, { floor: '10', seen: ['11', '11'] }, { floor: null, seen: ['1'] }, { floor: '0', seen: Array.from({ length: 1025 }, (_, index) => String(index + 1)) }]) {
    assert.throws(() => f.repository.write({ ...value, notificationBaseline: { ...value.notificationBaseline, posts: category } }));
  }
  const pointer = JSON.parse(f.files.get('x-reader-v1.json'));
  const chunk = `x-cache-${pointer.generation}-0.bin`;
  const future = JSON.parse(f.files.get(chunk)); future.version = 3;
  const bytes = Buffer.from(JSON.stringify(future)); f.files.set(chunk, bytes);
  f.files.set('x-reader-v1.json', Buffer.from(JSON.stringify({ ...pointer, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })));
  await assert.rejects(f.repository.read(), { code: 'invalid_x_state' });
  await assert.rejects(f.repository.write(value), { code: 'invalid_x_state' });
});

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
  value.notificationBaseline = { posts: { floor: '10', seen: [] }, replies: { floor: '0', seen: [] } };
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
  first.notificationBaseline.posts = { floor: '1', seen: [] };
  await f.repository.write(first);
  const second = structuredClone(first);
  second.activePartition = 'abcdef12-1234-4234-8234-123456789abc'; second.authScope = second.activePartition;
  second.posts = [post('2')]; second.lists.posts = ['2']; second.notificationBaseline.posts = { floor: '2', seen: [] };
  await f.repository.write(second);
  assert.deepEqual((await f.make().read()).posts.map(item => item.id), ['2']);
  const decode = () => JSON.parse(Buffer.concat([...f.files.entries()].filter(([name]) => name.endsWith('.bin')).sort(([a], [b]) => Number(a.match(/-(\d+)\.bin$/)[1]) - Number(b.match(/-(\d+)\.bin$/)[1])).map(([, bytes]) => bytes)).toString());
  assert.equal(decode().archives[0].posts[0].text, 'synthetic prior scope retained text');
  assert.ok(f.repository.cacheBytes > Buffer.byteLength(JSON.stringify({ posts: second.posts, lists: second.lists })));
  await f.repository.clearCache();
  assert.deepEqual(decode().archives[0].posts, []);
  assert.deepEqual(decode().archives[0].notificationBaseline.posts, { floor: '1', seen: [] });
  assert.deepEqual((await f.make().read()).notificationBaseline.posts, { floor: '2', seen: [] });
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
