import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLocalProgressEvents } from './local-progress-events.js';

class Response extends EventEmitter {
  chunks = [];
  writable = true;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(value) { this.chunks.push(value); return this.writable; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
const parse = response => JSON.parse(response.chunks.at(-1).split('data: ')[1]);

test('progress stream bounds connections, orders state, and disconnects slow clients', () => {
  let listener;
  let state = { status: 'idle' };
  let snapshot = 'building';
  const events = createLocalProgressEvents({ snapshotStatus: () => ({ status: snapshot }),
    refresh: { getProgressStatus: () => state, subscribe: fn => { listener = fn; return () => { listener = null; }; } }, limit: 1 });
  const first = new Response();
  assert.equal(events.connect({}, first), true);
  assert.equal(first.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  const initial = parse(first);
  assert.equal(initial.snapshot.status, 'building');
  assert.equal(events.connect({}, new Response()), false);
  state = { status: 'running' }; snapshot = 'ready'; listener();
  const updated = parse(first);
  assert.equal(updated.sequence, initial.sequence + 1);
  assert.equal(updated.instanceId, initial.instanceId);
  assert.equal(updated.snapshot.status, 'ready');
  first.writable = false; listener();
  assert.equal(first.destroyed, true);
  const next = new Response();
  assert.equal(events.connect({}, next), true);
  assert.ok(parse(next).sequence > updated.sequence);
  events.close();
  assert.equal(next.destroyed, true);
  assert.equal(listener, null);
});
