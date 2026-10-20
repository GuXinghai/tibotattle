import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, appendFile, copyFile, rename, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResponseUsagePlan } from '../src/providers/codex/logs.js';
import { extractRolloutUsage } from '../src/local-index-extract.js';
import { localCodexLogScanner } from '../src/local-node-runtime.js';
import { refreshCodexHome, withReadOnlyStore } from './helpers/local-index-rollout-store.js';
import { openLocalIndexStore, createLocalIndexWriter } from '../src/local-index-store.js';
import { assertSameFacts, v2Facts } from './helpers/local-index-facts.js';

const at = n => new Date(Date.UTC(2026, 8, 3, 12, 0, n)).toISOString();
const raw = (n = 1) => ({ input_tokens: 100 * n, cached_input_tokens: 80 * n,
  cache_write_input_tokens: 0, output_tokens: 10 * n, reasoning_output_tokens: 4 * n, total_tokens: 110 * n });
const rec = (n, type, payload) => ({ timestamp: at(n), type, payload });
const meta = rec(0, 'session_meta', { id: '10000000-0000-4000-8000-000000000001' });
const context = rec(0, 'turn_context', { turn_id: 'synthetic-turn', model: 'gpt-6.1-sol', service_tier: 'default' });
const response = (n, id, count) => rec(n, 'token_usage_record', {
  thread_id: meta.payload.id, turn_id: context.payload.turn_id, response_id: id,
  usage: raw(), turn_token_usage: raw(count), thread_token_usage: raw(count) });
const legacy = (n, count) => rec(n, 'event_msg', { type: 'token_count',
  info: { last_token_usage: raw(), total_token_usage: raw(count) } });
const plan = records => {
  const p = createResponseUsagePlan({ identityKey: s => createHash('sha256').update(s).digest('hex') });
  records.forEach((r, i) => p.observe(r, i));return p.finish();
};
async function fixture(records) {
  const root = await mkdtemp(join(tmpdir(), 'codex-response-'));
  await mkdir(join(root, 'sessions'));
  const path = join(root, 'sessions', 'rollout-2026-09-03T12-00-00-10000000-0000-4000-8000-000000000001.jsonl');
  await writeFile(path, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { root, path };
}

test('response identities distinguish identical calls and suppress both legacy spend and repeated copies', () => {
  const a = response(2, 'synthetic-a', 1), b = response(4, 'synthetic-b', 2);
  const r = plan([meta, context, legacy(1, 1), a, legacy(3, 2), b, a,
    rec(5, 'compacted', { latest_token_usage_record: b.payload })]);
  assert.equal(r.diagnostics.responses, 2);assert.equal(r.diagnostics.duplicateResponses, 1);
  assert(r.suppressLegacyAt(2));assert(r.suppressLegacyAt(4));
  assert.notEqual(r.responseAt(3).key, r.responseAt(5).key);
  assert.equal(r.responseAt(6), null);
  assert(!JSON.stringify(r.responseAt(3)).includes('synthetic-'));
});

test('invalid identities, conflicting copies, missing responses and resource limits fail explicitly', () => {
  const invalidPrefix = response(1, 'a', 1);invalidPrefix.payload.usage = raw(2);
  assert.throws(() => plan([meta, context, invalidPrefix]), /chain_incomplete/);
  const first = response(1, 'a', 1), changed = structuredClone(first);changed.payload.usage = raw(2);
  assert.throws(() => plan([meta, context, first, changed]), /identity_conflict/);
  const bad = response(1, 'a', 1);bad.payload.usage.reasoning_output_tokens = 999;
  assert.throws(() => plan([meta, context, bad]), /usage_invalid/);
  const p = createResponseUsagePlan({ identityKey: s => createHash('sha256').update(s).digest('hex'), maximumResponses: 0 });p.observe(meta, 0);p.observe(context, 1);
  assert.throws(() => p.observe(first, 2), /resource_limit/);
});

test('first response raw usage survives an unknown nonnegative prefix while later gaps still fail', () => {
  const first = response(2, 'first-after-prefix', 3);
  const next = response(3, 'next', 4);
  const reconciled = plan([meta, context, first, next]);
  assert.equal(reconciled.diagnostics.unverifiedPrefixTurns, 1);
  assert.deepEqual(reconciled.responseAt(2).raw, raw());
  assert.deepEqual(reconciled.responseAt(3).raw, raw());

  const midChainGap = response(3, 'mid-chain-gap', 4);
  assert.throws(() => plan([meta, context, response(2, 'first', 2), midChainGap]),
    { code: 'codex_response_usage_chain_incomplete' });

  const impossiblePrefix = response(2, 'negative-prefix', 1);
  impossiblePrefix.payload.usage = raw(2);
  assert.throws(() => plan([meta, context, impossiblePrefix]),
    { code: 'codex_response_usage_chain_incomplete' });
});

test('legacy overlap needs known component agreement and handles only absent zero cache-write evidence', () => {
  for (const [label, omitModernCacheWrite] of [['assumed', true], ['explicit', false]]) {
    const old = legacy(1, 3);
    delete old.payload.info.last_token_usage.cache_write_input_tokens;
    const current = response(2, `response-${label}-cache-write`, 3);
    if (omitModernCacheWrite) delete current.payload.usage.cache_write_input_tokens;
    const reconciled = plan([meta, context, old, current]);
    assert(reconciled.suppressLegacyAt(2));
    assert.equal(reconciled.diagnostics.unverifiedPrefixTurns, 1);
  }

  const explicitConflict = legacy(1, 3);
  explicitConflict.payload.info.last_token_usage.cache_write_input_tokens = 1;
  assert.throws(() => plan([meta, context, explicitConflict,
    response(2, 'response-cache-write-conflict', 3)]),
  { code: 'codex_response_usage_legacy_conflict' });

  const unmatched = legacy(1, 3);
  unmatched.payload.info.last_token_usage = raw(2);
  assert.throws(() => plan([meta, context, unmatched, response(2, 'only-one-response', 3)]),
    { code: 'codex_response_usage_legacy_conflict' });
});

test('fork replay never charges the child and an in-flight setting change retains the captured request model', () => {
  const foreign = response(1, 'foreign', 1);foreign.payload.thread_id = 'synthetic-ancestor';
  const foreignOnly = plan([meta, context, foreign]);
  assert.equal(foreignOnly.modern, false);
  assert.equal(foreignOnly.diagnostics.foreignResponses, 1);
  const r = plan([meta, context, foreign, rec(2, 'event_msg', { type: 'thread_settings_applied',
    thread_settings: { model: 'gpt-6-astra' } }), response(3, 'own', 1)]);
  assert.equal(r.diagnostics.foreignResponses, 1);assert.equal(r.responseAt(2), null);
  assert.equal(r.modern, true);
  assert.equal(r.responseAt(4).model, 'gpt-6.1-sol');
});

test('oversized ignored lines keep response locators and legacy suppression aligned', async () => {
  const ignored = rec(1, 'ignored', { padding: 'x'.repeat(4_096) });
  const second = response(4, 'after-second-ignored-line', 3);
  second.payload.usage = raw(2);
  const secondLegacy = legacy(5, 3);
  secondLegacy.payload.info.last_token_usage = raw(2);
  const f = await fixture([meta, context, ignored, response(2, 'after-ignored-line', 1),
    legacy(3, 1), ignored, second, secondLegacy]);
  const resourceGuard = { limits: { maximumLineBytes: 1_024 }, observeSourceFile() {},
    observeSourcePlan() {}, observeDirectoryEntry() {}, observeLine() {}, checkRuntime() {} };
  try {
    const scanned = [];
    await localCodexLogScanner.scanCodexLogEvents({ codexHome: f.root,
      startAt: at(0), endAt: at(59), resourceGuard, onUsage: event => scanned.push(event) });
    assert.deepEqual(scanned.map(event => [event.timestamp, event.raw.input_tokens,
      event.sourceRecordOrdinal]), [[at(2), 100, 4], [at(4), 200, 7]]);
    const indexed = [];
    await extractRolloutUsage(f.path, { size: (await stat(f.path)).size,
      maximumLineBytes: 1_024, onEvent: event => indexed.push(event) });
    assert.deepEqual(indexed.map(event => event.totalInputContextTokens), [100, 200]);
  } finally { await rm(f.root, { recursive: true }); }
});

test('foreign response prefixes permit legacy appends and healthy sources progress with cold parity', async () => {
  const foreign = response(1, 'copied-ancestor-response', 1);
  foreign.payload.thread_id = 'synthetic-ancestor';
  foreign.payload.turn_id = 'synthetic-ancestor-turn';
  const ownContext = rec(0, 'turn_context', { turn_id: context.payload.turn_id, model: 'gpt-6.1-sol' });
  const foreignContext = rec(0, 'turn_context', { ...ownContext.payload,
    turn_id: foreign.payload.turn_id });
  const f = await fixture([meta, foreignContext, foreign, legacy(2, 1), ownContext, legacy(3, 2)]);
  const healthyId = '20000000-0000-4000-8000-000000000002';
  const healthyPath = join(f.root, 'sessions', `rollout-2026-09-03T12-00-00-${healthyId}.jsonl`);
  const indexFile = join(f.root, 'index.sqlite');
  const secretFile = join(f.root, 'salt');
  try {
    await writeFile(healthyPath, [rec(0, 'session_meta', { id: healthyId }), ownContext,
      legacy(1, 1)].map(record => JSON.stringify(record)).join('\n') + '\n');
    await refreshCodexHome(f.root, { indexFile, secretFile });
    await appendFile(f.path, JSON.stringify(legacy(4, 3)) + '\n');
    await appendFile(healthyPath, JSON.stringify(legacy(4, 2)) + '\n');
    const refreshed = await refreshCodexHome(f.root, { indexFile, secretFile });
    assert.equal(refreshed.sourcesResumed, 2);
    assert.equal(withReadOnlyStore(indexFile, db => db.prepare(
      'SELECT SUM(total_input_context) n FROM usage_event').get().n), 400);
    const coldFile = join(f.root, 'cold.sqlite');
    await refreshCodexHome(f.root, { indexFile: coldFile, secretFile });
    assertSameFacts(v2Facts(indexFile), v2Facts(coldFile), 'foreign-prefix append vs cold');
    const repeated = await refreshCodexHome(f.root, { indexFile, secretFile });
    assert.equal(repeated.writeTransactions, 0);
  } finally { await rm(f.root, { recursive: true }); }
});

test('a missed modern append hint retries one full transaction and replaces source segments', async () => {
  const f = await fixture([meta, context, legacy(1, 1), response(2, 'fallback-own-response', 1)]);
  const indexFile = join(f.root, 'index.sqlite'), secretFile = join(f.root, 'salt');
  try {
    await refreshCodexHome(f.root, { indexFile, secretFile });
    const prior = withReadOnlyStore(indexFile, db => db.prepare(
      'SELECT id, scanned_bytes, source_ordinal, hex(source_local) local FROM source').get());
    const commitSeq = () => withReadOnlyStore(indexFile, db => db.prepare(
      'SELECT commit_seq FROM store_state WHERE id = 1').get().commit_seq);
    const previousCommit = commitSeq();
    // Simulate a missing classification hint. The extractor must still be the
    // correctness boundary, and must request replay before emitting any facts.
    const db = openLocalIndexStore(indexFile);
    try { db.exec('UPDATE usage_event SET flags = flags & ~16'); } finally { db.close(); }
    await appendFile(f.path, JSON.stringify(legacy(3, 1)) + '\n');
    await assert.rejects(extractRolloutUsage(f.path, { size: (await stat(f.path)).size,
      startOffset: prior.scanned_bytes, onEvent() { assert.fail('append replay must precede writes'); } }),
    { code: 'codex_response_usage_rescan_required' });
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(refreshCodexHome(f.root, { indexFile, secretFile, signal: cancellation.signal }));
    assert.equal(commitSeq(), previousCommit);
    assert.equal(withReadOnlyStore(indexFile, db => db.prepare(
      'SELECT scanned_bytes FROM source').get().scanned_bytes), prior.scanned_bytes);
    const refreshed = await refreshCodexHome(f.root, { indexFile, secretFile });
    assert.equal(refreshed.sourcesRescanned, 1);
    assert.equal(refreshed.sourcesResumed, 0);
    assert.equal(refreshed.writeTransactions, 2);
    assert.equal(commitSeq(), previousCommit + 1);
    const current = withReadOnlyStore(indexFile, db => db.prepare(
      'SELECT id, scanned_bytes, source_ordinal, hex(source_local) local FROM source').get());
    assert.equal(current.id, prior.id);
    assert.equal(current.source_ordinal, prior.source_ordinal);
    assert.equal(current.local, prior.local);
    assert.equal(current.scanned_bytes, (await stat(f.path)).size);
    const coldFile = join(f.root, 'cold.sqlite');
    await refreshCodexHome(f.root, { indexFile: coldFile, secretFile });
    assertSameFacts(v2Facts(indexFile), v2Facts(coldFile), 'fallback rescan vs cold');
    const segments = file => withReadOnlyStore(file, store => store.prepare(
      'SELECT segment, hex(digest) digest FROM source_segment ORDER BY segment').all());
    assert.deepEqual(segments(indexFile), segments(coldFile));
    const repeated = await refreshCodexHome(f.root, { indexFile, secretFile });
    assert.equal(repeated.writeTransactions, 0);
  } finally { await rm(f.root, { recursive: true }); }
});

test('index and provider count compaction and missing ordinary responses once; legacy-only turns survive', async () => {
  const cp = response(3, 'synthetic-compaction', 2);
  const records = [meta, context, legacy(1, 1), response(2, 'synthetic-normal', 1), cp,
    rec(4, 'compacted', { compaction_response_id: cp.payload.response_id, latest_token_usage_record: cp.payload }),
    response(5, 'synthetic-missing-ordinary', 3), cp,
    rec(6, 'turn_context', { turn_id: 'synthetic-legacy', model: 'gpt-6.1-sol' }), legacy(7, 2)];
  const f = await fixture(records);
  try {
    const events=[];await extractRolloutUsage(f.path,{size:(await stat(f.path)).size,onEvent:e=>events.push(e)});
    assert.equal(events.length,4);assert.equal(events.reduce((n,e)=>n+e.totalInputContextTokens,0),400);
    assert.equal(events.reduce((n,e)=>n+e.outputCombinedTokens,0),40);
    const scanned=[];await localCodexLogScanner.scanCodexLogEvents({codexHome:f.root,startAt:at(0),endAt:at(59),onUsage:e=>scanned.push(e)});
    assert.equal(scanned.length,4);assert.equal(scanned.reduce((n,e)=>n+e.raw.input_tokens,0),400);
  } finally { await rm(f.root,{recursive:true}); }
});

test('task_started establishes the legacy overlap turn before a response without turn_context', () => {
  const started = rec(1, 'event_msg', { type: 'task_started', turn_id: context.payload.turn_id });
  const planWithTaskStart = plan([meta, started, legacy(2, 1), response(3, 'task-started-response', 1)]);
  assert.equal(planWithTaskStart.diagnostics.responses, 1);
  assert.equal(planWithTaskStart.suppressLegacyAt(2), true);
});

test('first modern append atomically replaces prior legacy overlap and repeat refresh is idempotent', async () => {
  const started = rec(0, 'event_msg', { type: 'task_started', turn_id: context.payload.turn_id });
  const f=await fixture([meta,started,legacy(1,1)]),indexFile=join(f.root,'index.sqlite');
  const totals=()=>withReadOnlyStore(indexFile,db=>db.prepare('SELECT count(*) n,sum(total_input_context) input,sum(tokens_out_combined) output FROM usage_event').get());
  try {
    await refreshCodexHome(f.root,{indexFile});assert.equal(totals().input,100);
    await appendFile(f.path,JSON.stringify(response(2,'synthetic-a',1))+'\n'+JSON.stringify(response(3,'synthetic-b',2))+'\n');
    await refreshCodexHome(f.root,{indexFile});assert.equal(totals().input,200);assert.equal(totals().output,20);
    await refreshCodexHome(f.root,{indexFile});assert.equal(totals().input,200);
    await appendFile(f.path,JSON.stringify(response(4,'synthetic-c',3))+'\n');
    await refreshCodexHome(f.root,{indexFile});assert.equal(totals().input,300);
  } finally { await rm(f.root,{recursive:true}); }
});

test('duplicate response ownership survives rescan, owner replacement, pruning, and replay', async () => {
  const shared = response(2, 'synthetic-shared-owner', 1);
  const prefix = [meta, context, shared];
  const prefixText = prefix.map(record => JSON.stringify(record)).join('\n') + '\n';
  const f = await fixture([...prefix, rec(3, 'event_msg', { type: 'task_complete' })]);
  const survivingCopy = join(f.root, 'sessions',
    'rollout-2026-09-03T12-00-01-10000000-0000-4000-8000-000000000001_20000000-0000-4000-8000-000000000002.jsonl');
  const indexFile = join(f.root, 'index.sqlite');
  const replacementMeta = rec(3, 'session_meta', { id: meta.payload.id,
    history_mode: 'paginated', history_base: { thread_id: meta.payload.id,
      end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(prefixText) } });
  replacementMeta.ordinal = 3;
  const replacementResponse = response(4, 'synthetic-shared-owner', 1);
  replacementResponse.ordinal = 4;
  const copyRecords = [replacementMeta, replacementResponse];
  const copyText = copyRecords.map(record => JSON.stringify(record)).join('\n') + '\n';
  const writeCopy = async (records) => writeFile(
    survivingCopy, records.map(record => JSON.stringify(record)).join('\n') + '\n',
  );
  const totals = () => withReadOnlyStore(indexFile, db => db.prepare(`
    SELECT COUNT(*) AS events, COALESCE(SUM(total_input_context), 0) AS input,
           COALESCE(SUM(tokens_out_combined), 0) AS output
    FROM usage_event`).get());
  try {
    await writeCopy(copyRecords);
    await refreshCodexHome(f.root, { indexFile });
    const sourceCounts = withReadOnlyStore(indexFile, db => ({
      sources: db.prepare('SELECT COUNT(*) n FROM source').get().n,
      usage: db.prepare('SELECT COUNT(*) n FROM usage_event').get().n,
      quarantine: db.prepare('SELECT COALESCE(quarantine_code, \'none\') code, COUNT(*) n FROM source GROUP BY quarantine_code').all(),
    }));
    assert.equal(totals().events, 1, JSON.stringify(sourceCounts));
    assert.equal(totals().input, 100);

    // Replacing one source replays the same owner response while its physical
    // duplicate remains. It must stay one event after the session rescan.
    // Shrinking the parent suffix leaves the exact history_base prefix valid.
    // The replacement source must be replayed in the same session; it carries
    // the same response identity as the source whose facts are being replaced.
    await writeFile(f.path, prefixText);
    const replaced = await refreshCodexHome(f.root, { indexFile });
    assert.ok(replaced.sourcesRescanned > 0);
    assert.equal(totals().events, 1);
    assert.equal(totals().input, 100);
    assert.equal(totals().output, 10);

    // A changed quantity under that same response identity still fails while
    // preserving the last committed physical copy.
    const changed = response(4, 'synthetic-shared-owner', 2);
    changed.payload.usage = raw(2);
    changed.ordinal = 4;
    await writeCopy([replacementMeta, changed]);
    const directEvents = [];
    await extractRolloutUsage(survivingCopy, { size: (await stat(survivingCopy)).size,
      onEvent: event => directEvents.push(event) });
    let refreshError = null;
    let changedResult = null;
    try { changedResult = await refreshCodexHome(f.root, { indexFile }); }
    catch (error) { refreshError = error.code ?? 'unknown'; }
    const sourceFacts = withReadOnlyStore(indexFile, db => ({
      sources: db.prepare('SELECT COUNT(*) n FROM source').get().n,
      sourceStates: db.prepare('SELECT COALESCE(quarantine_code, \'none\') code, COUNT(*) n FROM source GROUP BY quarantine_code').all(),
      usage: db.prepare('SELECT COUNT(*) n FROM usage_event').get().n,
      sourceUsage: db.prepare('SELECT s.source_ordinal ordinal, s.scanned_bytes scanned, s.size_bytes size, COUNT(u.source_offset) events FROM source s LEFT JOIN usage_event u ON u.source_id=s.id GROUP BY s.id ORDER BY s.source_ordinal').all(),
      sourceResponseDiagnostics: db.prepare("SELECT s.source_ordinal ordinal, COALESCE(SUM(CASE WHEN d.code = 'responseUsageEvents' THEN d.count ELSE 0 END), 0) events, COALESCE(SUM(CASE WHEN d.code = 'responseUnverifiedPrefixTurns' THEN d.count ELSE 0 END), 0) prefixes FROM source s LEFT JOIN source_diagnostic d ON d.source_id = s.id GROUP BY s.id ORDER BY s.source_ordinal").all(),
    }));
    assert.equal(refreshError, 'codex_response_usage_identity_conflict', JSON.stringify({ direct: directEvents.map(event => [event.responseUsage, event.totalInputContextTokens, event.outputCombinedTokens]), sourceFacts,
      changedRescanned: changedResult?.sourcesRescanned, changedSkipped: changedResult?.sourcesSkipped }));
    assert.equal(totals().events, 1);
    assert.equal(totals().input, 100);

    await writeCopy(copyRecords);
    await refreshCodexHome(f.root, { indexFile });
    await rm(f.path);
    await refreshCodexHome(f.root, { indexFile });
    await appendFile(survivingCopy, JSON.stringify(rec(4, 'event_msg', { type: 'task_complete' })) + '\n');
    await refreshCodexHome(f.root, { indexFile });
    assert.equal(totals().events, 1);
    assert.equal(totals().input, 100);
    assert.equal(totals().output, 10);
  } finally {
    await rm(f.root, { recursive: true });
  }
});

test('unknown model attribution stays separate and conflicting response updates preserve last committed facts', async () => {
  const a=response(2,'synthetic-a',1),settings=rec(1,'event_msg',{type:'thread_settings_applied',thread_settings:{model:'gpt-6-astra'}});
  settings.timestamp=at(0);
  const conflictingContext=rec(1,'turn_context',context.payload);
  const records=[meta,settings,conflictingContext,a],f=await fixture(records),indexFile=join(f.root,'index.sqlite');
  try {
    await refreshCodexHome(f.root,{indexFile});
    const row=withReadOnlyStore(indexFile,db=>db.prepare('SELECT m.model_id,m.recognition,u.total_input_context FROM usage_event u JOIN model m ON m.id=u.model_id').get());
    assert.equal(row.model_id,'unknown');assert.equal(row.recognition,'missing');assert.equal(row.total_input_context,100);
    const bad=structuredClone(a);bad.payload.usage=raw(2);bad.payload.turn_token_usage=raw(2);
    await appendFile(f.path,JSON.stringify(bad)+'\n');
    await assert.rejects(refreshCodexHome(f.root,{indexFile}),{code:'codex_response_usage_identity_conflict'});
    assert.equal(withReadOnlyStore(indexFile,db=>db.prepare('SELECT SUM(total_input_context) n FROM usage_event').get().n),100);
    await writeFile(f.path,[...records.slice(0,-1),bad].map(r=>JSON.stringify(r)).join('\n')+'\n');
    await assert.rejects(refreshCodexHome(f.root,{indexFile}),{code:'codex_response_usage_identity_conflict'});
    assert.equal(withReadOnlyStore(indexFile,db=>db.prepare('SELECT SUM(total_input_context) n FROM usage_event').get().n),100);
  } finally {await rm(f.root,{recursive:true});}
});

test('persistent response identity suppresses physical copies and rejects changed quantities',async()=>{
  const f=await fixture([meta,context,response(1,'synthetic-a',1)]),indexFile=join(f.root,'index.sqlite');
  try{
    await refreshCodexHome(f.root,{indexFile});const db=openLocalIndexStore(indexFile);
    try{
      const r=db.prepare('SELECT * FROM usage_event LIMIT 1').get(),writer=createLocalIndexWriter(db);writer.begin();
      const source=writer.registerSource({sourceLocal:Buffer.alloc(32,91),sessionId:r.session_id,surfaceId:r.surface_id,path:join(f.root,'synthetic-copy.jsonl'),rolloutKey:'synthetic-copy',sizeBytes:0,mtimeMs:0});
      const e={sourceId:source.id,sourceOffset:1,observedAtMs:r.observed_at_ms,eventKey:r.event_key,sessionId:r.session_id,accountScopeId:r.account_scope_id,modelId:r.model_id,tierId:r.tier_id,surfaceId:r.surface_id,reasoningEffort:r.reasoning_effort,responseUsage:true,tokensInUncached:r.tokens_in_uncached,tokensInCacheRead:r.tokens_in_cache_read,tokensInCacheWrite:r.tokens_in_cache_write,tokensOutText:r.tokens_out_text,tokensOutReasoning:r.tokens_out_reasoning,tokensOutCombined:r.tokens_out_combined,totalInputContext:r.total_input_context};
      assert.equal(writer.writeUsageEvent(e),0);
      assert.throws(()=>writer.writeUsageEvent({...e,tokensInUncached:e.tokensInUncached+1}),{code:'codex_response_usage_identity_conflict'});
      writer.rollback();assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_event').get().n,1);
    }finally{db.close();}
  }finally{await rm(f.root,{recursive:true});}
});


test('deferred modern response tails preserve reconciled history through rescan, copies and rotation', async () => {
  const f = await fixture([meta, context, legacy(1, 1), response(2, 'synthetic-first', 1)]);
  const options = { indexFile: join(f.root, 'index.sqlite'), workerCount: 1 };
  const facts = () => withReadOnlyStore(options.indexFile, db => db.prepare('SELECT hex(event_key) AS id,tokens_in_uncached,tokens_in_cache_read,tokens_out_combined FROM usage_event ORDER BY event_key').all());
  try {
    await refreshCodexHome(f.root, options); const before = facts(); assert.equal(before.length, 1);
    const next = JSON.stringify(response(3, 'synthetic-next', 2)); await appendFile(f.path, next);
    await refreshCodexHome(f.root, options); assert.deepEqual(facts(), before); await refreshCodexHome(f.root, options); assert.deepEqual(facts(), before);
    await appendFile(f.path, '\n'); await refreshCodexHome(f.root, options); const completed = facts(); assert.equal(completed.length, 2);
    const archive = join(f.root, 'archived_sessions'); await mkdir(archive);
    const copy = join(archive, f.path.split(/[\\/]/).at(-1)); await copyFile(f.path, copy);
    await refreshCodexHome(f.root, options); assert.deepEqual(facts(), completed);
    await rename(f.path, join(f.root, 'retained-source')); await refreshCodexHome(f.root, options); assert.deepEqual(facts(), completed);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
