import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWorkUsageService } from '../../src/application/index.js';
import { modelPerformanceProjection } from '../../src/reporting/index.js';
import { createModelPerformanceController } from './model-performance-controller.js';

test('work report emits content-free settlement without affecting result', async () => {
  const done = Promise.withResolvers(); const events = [];
  const service = createWorkUsageService({ build: () => done.promise,
    onSettled: value => { events.push(value); throw new Error('observer failure'); } });
  try {
    const first = await service.query({ schemaVersion: "local-work-usage-v1", action: 'query', period: '7d' });
    assert.equal(first.status, 'preparing');
    done.resolve({ status: 'unavailable' });
    await new Promise(setImmediate);
    assert.deepEqual(events, ['failed']);
    const settled = await service.query({ schemaVersion: "local-work-usage-v1", action: 'query', period: '7d', snapshotId: first.snapshotId });
    assert.equal(settled.status, 'unavailable');
  } finally { await service.close(); }
});

test('model report emits a bounded failure event on worker error', async () => {
  const worker = new EventEmitter(); worker.unref = () => {}; worker.ref = () => {};
  worker.postMessage = () => { queueMicrotask(() => worker.emit('exit', 0)); };
  const events = [];
  const controller = createModelPerformanceController({ directory: 'synthetic', codexHome: 'synthetic',
    snapshotStoreFactory: () => ({ read: async () => null, write: async () => {} }),
    workerFactory: () => worker, onSettled: status => { events.push(status); throw new Error('observer failure'); } });
  try {
    await controller.read('all');
    const snapshot = modelPerformanceProjection([], { now: Date.parse('2026-10-15T12:00:00Z'), period: 'all', speedMode: 'standard' });
    worker.emit('message', { type: 'snapshots', values: [snapshot] });
    worker.emit('message', { type: 'snapshots', values: [{ ...snapshot, collecting: true, historyProgress: { checked: 0, total: 1 } }] });
    worker.emit('message', { type: 'snapshots', values: [{ ...snapshot, stale: true }] });
    worker.emit('message', { type: 'diagnostics', codes: ['timing_scan_failed'] });
    worker.emit('message', { type: 'diagnostics', codes: ['timing_scan_failed'] });
    worker.emit('error', new Error('synthetic'));
    assert.deepEqual(events, ['ready', 'changed', 'changed', 'changed', 'failed']);
    assert.equal((await controller.read('all')).collecting, false);
  } finally { await controller.close(); }
});
