import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openLocalIndexStore, readPendingModelRecognitionSources } from '../src/local-index-store.js';
import { refreshCodexHome, withReadOnlyStore } from './helpers/local-index-rollout-store.js';
import { readLocalIndexUsage } from '../src/local-index-report.js';
import { createLocalIndexBackend } from '../src/local-index-backend.js';

test('reviewed model recovery is bounded, restartable, idempotent and preserves unknown speed and tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'model-recognition-'));
  const indexFile = join(root, 'index.sqlite');
  const at = '2025-11-22T00:00:00.000Z';
  const raw = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100,
    reasoning_output_tokens: 40, total_tokens: 1100 };
  const inspect = () => withReadOnlyStore(indexFile, db => ({
    facts: db.prepare(`SELECT hex(event_key) event,tokens_in_uncached,tokens_in_cache_read,
      tokens_in_cache_write,tokens_out_text,tokens_out_reasoning,tokens_out_combined,tier_id
      FROM usage_event ORDER BY event_key`).all(),
    pending: readPendingModelRecognitionSources(db).size,
    models: db.prepare(`SELECT m.model_id model,COUNT(*) events FROM usage_event u
      JOIN model m ON m.id=u.model_id GROUP BY m.model_id ORDER BY m.model_id`).all(),
    report: readLocalIndexUsage(db, { nowMs: Date.parse('2026-10-19T00:00:00Z') }).usage.find(r => r.id === 'all'),
  }));
  try {
    await mkdir(join(root, 'sessions'));
    for (let i = 0; i < 11; i++) {
      const id = `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      const model = i < 8 ? 'gpt-5.1-codex-max' : i < 10 ? 'synthetic-unreviewed' : 'gpt-5.1-codex';
      const records = [
        { timestamp: at, type: 'session_meta', payload: { id } },
        { timestamp: at, type: 'turn_context', payload: { model } },
        { timestamp: at, type: 'event_msg', payload: { type: 'token_count',
          info: { last_token_usage: raw, total_token_usage: raw }, rate_limits: null } },
      ];
      await writeFile(join(root, 'sessions', `rollout-2025-11-22T00-00-00-${id}.jsonl`),
        records.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    await refreshCodexHome(root);
    const cold = inspect();
    assert.equal(cold.report.pricingCoverage.unpricedEvents, 2);
    // Rehearse the prior catalog in synthetic state only; source bytes stay unchanged.
    const db = openLocalIndexStore(indexFile);
    try {
      db.exec(`BEGIN;
        UPDATE usage_event SET model_id=(SELECT id FROM model WHERE model_id='unknown')
          WHERE model_id=(SELECT id FROM model WHERE model_id='gpt-5.1-codex-max');
        DELETE FROM source_diagnostic WHERE code='modelRecognitionVersion';
        COMMIT;`);
    } finally { db.close(); }
    const before = inspect();
    assert.equal(before.pending, 10);
    const backend = createLocalIndexBackend({indexFile});
    assert.equal(backend.refreshTimeoutMs({existingTimeoutMs:1,freshTimeoutMs:2}), 2);
    // Even an append to a source beyond this batch must retain its repair queue.
    await appendFile(join(root,'sessions','rollout-2025-11-22T00-00-00-10000000-0000-4000-8000-000000000010.jsonl'), '\n');
    const abort = new AbortController(); abort.abort();
    await assert.rejects(refreshCodexHome(root, { signal: abort.signal }), { name: 'AbortError' });
    assert.equal(inspect().pending, 10);
    const first = await refreshCodexHome(root);
    assert.equal(first.status, 'deferred');
    assert.equal(first.deferred.reason, 'model_attribution_recovery');
    assert.equal(first.sourcesRescanned, 8);
    assert.equal(inspect().pending, 2);
    // A new invocation (like a restart) resumes the committed queue.
    const second = await refreshCodexHome(root);
    assert.equal(second.status, 'refreshed');
    assert.equal(second.sourcesRescanned, 2);
    const after = inspect();
    assert.deepEqual(after.facts, before.facts);
    assert.deepEqual(after.models, cold.models);
    assert.equal(after.report.pricingCoverage.unpricedEvents, 2);
    assert.equal(after.report.bySpeed.unknown.events, 11);
    assert.equal(after.pending, 0);
    assert.equal(backend.refreshTimeoutMs({existingTimeoutMs:1,freshTimeoutMs:2}), 1);
    const replay = await refreshCodexHome(root);
    assert.equal(replay.sourcesRescanned, 0);
    assert.equal(replay.usageEvents, 0);
    assert.deepEqual(inspect(), after);
  } finally { await rm(root, { recursive: true, force: true }); }
});
