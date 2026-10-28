import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalProgressEvents } from '../public/local-progress-events.js';

class FakeEventSource {
  static last;
  constructor(url) { this.url = url; this.handlers = new Map(); FakeEventSource.last = this; }
  addEventListener(name, handler) { this.handlers.set(name, handler); }
  emit(name, value) { this.handlers.get(name)?.(value); }
  close() { this.closed = true; }
}
const ONE = '11111111-1111-4111-8111-111111111111';
const TWO = '22222222-2222-4222-8222-222222222222';
const payload = (instanceId, sequence, extra = {}) => ({ instanceId, sequence,
  snapshot: { status: 'ready' }, refresh: { refreshId: null, status: 'idle', mode: null, reason: null,
    quota: { status: 'skipped' }, usage: { status: 'skipped' }, progress: null, pending: null,
    quickResultPublished: false, publication: null }, report: null, ...extra });
const send = value => FakeEventSource.last.emit('progress', { data: JSON.stringify(value) });

test('stream rejects old sequences and retired instances and restores a reconnect snapshot', async () => {
  const bus = createLocalProgressEvents({ EventSourceRef: FakeEventSource });
  const seen = [];
  bus.subscribe(value => seen.push(value));
  assert.equal(FakeEventSource.last.url, '/api/local/events');
  send(payload(ONE, 1));
  send(payload(ONE, 1));
  const beforeDisconnect = bus.cursor();
  const waiting = bus.wait(beforeDisconnect);
  FakeEventSource.last.emit('error');
  await waiting;
  assert.equal(bus.connection(), 'disconnected');
  assert.equal(seen.at(-1).connection, 'disconnected');
  send(payload(ONE, 2));
  assert.equal(seen.at(-1).connection, 'connected');
  send(payload(TWO, 1));
  send(payload(ONE, 3));
  assert.equal(bus.current().instanceId, TWO);
  assert.equal(seen.filter(value => value.connection === 'connected' && value.sequence === 1 && value.instanceId === ONE).length, 1);
  bus.close();
  assert.equal(FakeEventSource.last.closed, true);
});

test('missing EventSource is explicitly unavailable and does not wait forever', async () => {
  const bus = createLocalProgressEvents({ EventSourceRef: null });
  assert.equal(bus.connection(), 'unavailable');
  await bus.wait(bus.cursor());
  assert.equal(bus.current(), null);
});

test('a waiter cannot miss an event delivered before it subscribes to the wait', async () => {
  const bus = createLocalProgressEvents({ EventSourceRef: FakeEventSource });
  const cursor = bus.cursor();
  send(payload(ONE, 1, { report: { kind: 'work_usage', status: 'ready' } }));
  await bus.wait(cursor);
  assert.equal(bus.current().report.kind, 'work_usage');
  bus.close();
});

test('closed event contracts, observer isolation and abortable wait', async () => {
  const bus = createLocalProgressEvents({ EventSourceRef: FakeEventSource });
  let received = 0;
  bus.subscribe(() => { throw new Error('observer'); });
  bus.subscribe(() => { received++; });
  send({ ...payload(ONE, 1), privateField: 'discard' });
  send(payload(ONE, 2, { snapshot: { status: 'invented' } }));
  send(payload(ONE, 3, { refresh: { ...payload(ONE, 3).refresh, progress: { status: 'scanning', filesProcessed: -1 } } }));
  assert.equal(received, 0);
  send(payload(ONE, 4));
  assert.equal(received, 1);
  const controller = new AbortController();
  const waiting = bus.wait(bus.cursor(), { signal: controller.signal });
  controller.abort();
  await waiting;
  bus.close();
});

test('deadline and abort release their timer, listener and waiter', async () => {
  const scheduled = new Map();
  let next = 0;
  const bus = createLocalProgressEvents({ EventSourceRef: FakeEventSource,
    setTimeoutRef: (callback, ms) => { const id = ++next; scheduled.set(id, { callback, ms }); return id; },
    clearTimeoutRef: id => scheduled.delete(id) });
  send(payload(ONE, 1));
  const timed = bus.wait(bus.cursor(), { timeoutMs: 30_000 });
  assert.equal([...scheduled.values()][0].ms, 30_000);
  [...scheduled.values()][0].callback();
  await timed;
  assert.equal(scheduled.size, 0);
  const controller = new AbortController();
  const cancelled = bus.wait(bus.cursor(), { signal: controller.signal, timeoutMs: 241 * 60_000 });
  assert.equal(scheduled.size, 1);
  controller.abort();
  await cancelled;
  assert.equal(scheduled.size, 0);
  bus.close();
});
