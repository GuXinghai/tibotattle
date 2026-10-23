import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import test from 'node:test';
import { createCodexLogScanner } from '../src/providers/codex/logs.js';
import { extractRolloutUsage } from '../src/local-index-extract.js';

const THREAD = '10000000-0000-4000-8000-000000000001';
const at = n => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();
const raw = (n = 1) => ({ input_tokens: 100 * n, cached_input_tokens: 80 * n,
  cache_write_input_tokens: 0, output_tokens: 10 * n, reasoning_output_tokens: 4 * n,
  total_tokens: 110 * n });
const record = (n, type, payload) => ({ timestamp: at(n), type, payload });
const meta = record(0, 'session_meta', { id: THREAD });
const context = (n = 1, tier) => record(n, 'turn_context', { turn_id: 'synthetic-turn',
  model: 'gpt-6.1-sol', ...(tier === undefined ? {} : { service_tier: tier }) });
const setting = n => record(n, 'event_msg', { type: 'thread_settings_applied',
  thread_settings: { service_tier: 'priority' } });
const legacy = (n, total, last = 1) => record(n, 'event_msg', { type: 'token_count',
  info: { total_token_usage: raw(total), last_token_usage: last === null ? null : raw(last) } });
const response = (n, id, total, value = 1) => record(n, 'token_usage_record', {
  thread_id: THREAD, turn_id: 'synthetic-turn', response_id: id,
  usage: raw(value), turn_token_usage: raw(total), thread_token_usage: raw(total) });

// Every byte and filesystem port is synthetic and held in memory. These tests
// call both public entrypoints without discovering a real Codex home or files.
function fixture(groups) {
  const sources = new Map();
  const infos = groups.map((rows, index) => {
    const path = `/virtual/ledger-${index}.jsonl`;
    const lines = rows.map(row => JSON.stringify(row));
    const bytes = Buffer.from(lines.join('\n') + '\n');
    const stats = { dev: 81, ino: index + 82, size: bytes.length, mtimeMs: 100,
      ctimeMs: 100, birthtimeMs: 100, uid: 501, nlink: 1,
      isFile: () => true, isSymbolicLink: () => false };
    const handle = { async read(target, offset, length, position) {
      const part = bytes.subarray(position, position + length);
      target.set(part, offset); return { bytesRead: part.length, buffer: target };
    }, stat: async () => stats, close: async () => {} };
    sources.set(path, { lines, handle, stats, bytes });
    return { path, rolloutKey: `ledger-${index}.jsonl`, location: 'archive', ...stats,
      lineage: { sessionId: THREAD, parentId: null, isFork: false,
        surfaceClassification: { surface: 'unknown', threadSource: 'unknown', agentScope: 'unknown' } } };
  });
  const filesystem = { defaultCodexHome: () => '/virtual', joinPath: (...p) => posix.join(...p),
    currentUid: () => 501, readSelectedRolloutNames: async () => null,
    openDirectory: async () => (async function* () {})(),
    statPath: async p => sources.get(p).stats, lstatPath: async p => sources.get(p).stats,
    openReadOnlyNoFollow: async p => sources.get(p).handle,
    createSha256: () => createHash('sha256'),
    readUtf8Range: async function* (p) { yield sources.get(p).bytes.toString(); },
    readUtf8LinesRange: async function* (p) { yield* sources.get(p).lines; } };
  const scanner = createCodexLogScanner({ filesystem,
    lineReader: { readBoundedUtf8Lines: async function* (p) { yield* sources.get(p).lines; } } });
  return {
    async scan(order = infos) {
      const events = [];
      const result = await scanner.scanCodexLogEvents({ startAt: at(0), endAt: at(59),
        rolloutInfos: order, onUsage: event => events.push(event) });
      return { events, diagnostics: result.diagnostics };
    },
    async extract(index = 0) {
      const events = [], info = infos[index];
      const result = await extractRolloutUsage(sources.get(info.path).handle,
        { size: info.size, onEvent: event => events.push(event) });
      return { events, diagnostics: result.diagnostics };
    },
    infos,
  };
}

function quantities(result, scanner) {
  return result.events.map(event => scanner
    ? [event.raw.input_tokens, event.raw.output_tokens]
    : [event.totalInputContextTokens, event.outputCombinedTokens]);
}

test('ambiguous legacy overlap fails before either entrypoint emits a partial total', async () => {
  const value = fixture([[meta, context(), legacy(2, 1), legacy(3, 2), response(4, 'b', 2)]]);
  for (const method of ['scan', 'extract']) {
    await assert.rejects(value[method](), { code: 'codex_response_usage_legacy_conflict' });
  }
});

test('complete equal-vector response occurrences conserve legacy quantities in both entrypoints', async () => {
  const value = fixture([[meta, context(), legacy(2, 1), response(3, 'a', 1),
    legacy(4, 2), response(5, 'b', 2)]]);
  assert.deepEqual(quantities(await value.scan(), true), [[100, 10], [100, 10]]);
  assert.deepEqual(quantities(await value.extract(), false), [[100, 10], [100, 10]]);
});

test('unknown modern prefix retains only exact raw response and explicit prefix diagnostic', async () => {
  const value = fixture([[meta, context(), response(3, 'after-prefix', 3)]]);
  const scanned = await value.scan(), indexed = await value.extract();
  assert.deepEqual(quantities(scanned, true), [[100, 10]]);
  assert.deepEqual(quantities(indexed, false), [[100, 10]]);
  assert.equal(scanned.diagnostics.responseUnverifiedPrefixTurns, 1);
  assert.equal(indexed.diagnostics.responseUnverifiedPrefixTurns, 1);
});

test('first total-only snapshot anchors without assigning its prefix to the current request', async () => {
  const value = fixture([[meta, context(), legacy(2, 10, null), legacy(3, 11, null)]]);
  for (const [method, scanner] of [['scan', true], ['extract', false]]) {
    const result = await value[method]();
    assert.deepEqual(quantities(result, scanner), [[100, 10]]);
    assert.equal(result.diagnostics.cumulativePrefixUnattributed, 1);
  }
});

test('same-timestamp later speed cannot backfill preceding legacy usage', async () => {
  const value = fixture([[meta, context(), legacy(2, 1), setting(2), legacy(3, 2)]]);
  assert.deepEqual((await value.scan()).events.map(e => e.tierSemantics.codexSpeedMode), ['unknown', 'fast']);
  assert.deepEqual((await value.extract()).events.map(e => e.tier?.providerTierRaw ?? null), [null, 'priority']);
});

test('future preceding speed does not authorize falling back to an older setting', async () => {
  const value = fixture([[meta, context(1, 'default'), setting(5), legacy(3, 1)]]);
  assert.deepEqual((await value.scan()).events.map(e => e.tierSemantics.codexSpeedMode), ['unknown']);
  assert.deepEqual((await value.extract()).events.map(e => e.tier?.providerTierRaw ?? null), [null]);
});

for (const [captured, expected] of [['default', 'standard'], [undefined, 'unknown']]) {
  test(`modern captured ${expected} speed survives in-flight change and stale context stays unknown`, async () => {
    const value = fixture([[meta, context(1, captured), setting(2), response(3, 'a', 1),
      response(4, 'b', 2), context(5), response(6, 'c', 3)]]);
    assert.deepEqual((await value.scan()).events.map(e => e.tierSemantics.codexSpeedMode), [expected, 'unknown', 'fast']);
    assert.deepEqual((await value.extract()).events.map(e => e.tier?.providerTierRaw ?? null),
      [captured ?? null, null, 'priority']);
  });
}

test('identical cross-source response copies deduplicate independent of enumeration order', async () => {
  const records = [meta, context(1, 'default'), response(2, 'same', 1)];
  const value = fixture([records, records]);
  for (const order of [value.infos, [...value.infos].reverse()]) {
    assert.deepEqual(quantities(await value.scan(order), true), [[100, 10]]);
  }
});

test('equivalent ISO encodings of captured tier time have the same private proof', async () => {
  const rows = [meta, context(1, 'default'), response(2, 'same', 1)];
  const equivalent = structuredClone(rows);
  equivalent[1].timestamp = '2026-10-01T09:00:01+09:00';
  const value = fixture([rows, equivalent]);
  for (const order of [value.infos, [...value.infos].reverse()]) {
    assert.deepEqual(quantities(await value.scan(order), true), [[100, 10]]);
  }
});

test('cross-source identity conflicts fail regardless of source order, including price attribution', async () => {
  for (const other of [response(2, 'same', 2, 2), response(3, 'same', 1), response(60, 'same', 1)]) {
    const value = fixture([[meta, context(1, 'default'), response(2, 'same', 1)],
      [meta, context(1, 'default'), other]]);
    for (const order of [value.infos, [...value.infos].reverse()]) {
      await assert.rejects(value.scan(order), { code: 'codex_response_usage_identity_conflict' });
    }
  }
  const differentTier = fixture([[meta, context(1, 'default'), response(2, 'same', 1)],
    [meta, context(1, 'priority'), response(2, 'same', 1)]]);
  for (const order of [differentTier.infos, [...differentTier.infos].reverse()]) {
    await assert.rejects(differentTier.scan(order), { code: 'codex_response_usage_identity_conflict' });
  }
});

test('same-source identity copies reject changed timestamp or component availability', async () => {
  const first = response(2, 'same', 1);
  const missingWrite = structuredClone(first);
  delete missingWrite.payload.usage.cache_write_input_tokens;
  for (const changed of [response(3, 'same', 1), missingWrite]) {
    for (const pair of [[first, changed], [changed, first]]) {
      const value = fixture([[meta, context(1, 'default'), ...pair]]);
      for (const method of ['scan', 'extract']) {
        await assert.rejects(value[method](), { code: 'codex_response_usage_identity_conflict' });
      }
    }
  }
});
