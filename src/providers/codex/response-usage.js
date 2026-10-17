// Response raw usage is authoritative per exact identity. A nonzero first
// cumulative prefix remains explicitly unverified; legacy quota observations
// remain independent of this selection.
// Raw provider identities stay inside this bounded, scan-local reconciler.
import {codexTierObservation} from './tier-normalization.js';
const KEYS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/u.test(value);
const same = (a, b) => KEYS.every(k => a[k] === b[k]);
const LEGACY_MATCH_KEYS = KEYS.filter(k => k !== 'cache_write_input_tokens');
const zero = () => Object.fromEntries(KEYS.map(k => [k, 0]));
export const RESPONSE_MODEL_RECOVERY_VERSION = 1;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function usage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('codex_response_usage_invalid');
  const result = {};
  for (const k of KEYS) {
    const n = value[k] ?? (k === 'cache_write_input_tokens' ? 0 : null);
    if (!Number.isSafeInteger(n) || n < 0) fail('codex_response_usage_invalid');
    result[k] = n;
  }
  if (result.input_tokens + result.output_tokens !== result.total_tokens
      || result.cached_input_tokens + result.cache_write_input_tokens > result.input_tokens
      || result.reasoning_output_tokens > result.output_tokens) fail('codex_response_usage_invalid');
  return result;
}
function difference(total, response) {
  const prior = Object.fromEntries(KEYS.map(k => [k, total[k] - response[k]]));
  if (Object.values(prior).some(n => !Number.isSafeInteger(n) || n < 0)) return null;
  try { return usage(prior); } catch { return null; }
}

export function createResponseUsagePlan({ identityKey, maximumResponses = 100_000,
  maximumRecords = 250_000 } = {}) {
  if (typeof identityKey !== 'function') throw new TypeError('identityKey is required');
  if (!Number.isSafeInteger(maximumResponses) || maximumResponses < 0 || maximumResponses > 100_000
      || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 250_000) {
    throw new TypeError('Response usage limits are invalid');
  }
  const responses = new Map(), turns = new Map(), legacy = new Map(), foreignTurns = new Set(), checkpoints=new Map();
  let own = null, activeTurn = null, settingsModel = null, records = 0, modern = false, legacyTotal = null;
  let settingsRevision=0,pendingCheckpoint=null,settingsTier=null;
  const diagnostics = { responses: 0, duplicateResponses: 0, foreignResponses: 0,
    unattributedModels: 0, unverifiedPrefixTurns: 0, modelsRecovered:0 };
  function turn(key) {
    let t = turns.get(key);
    if (!t) { t = { total: zero(), model: null, modelAt: null, hasResponses: false,
      unverifiedPrefix: false,context:null,lastResponseRecord:-1,routingSeen:false }; turns.set(key, t); }
    return t;
  }
  return {
    observe(record, locator) {
      if (++records > maximumRecords) fail('codex_response_usage_resource_limit');
      const p = record?.payload;
      if (record?.type === 'session_meta') { own = id(p?.id) ? p.id : null; return; }
      if(record?.type==='compacted'){
        pendingCheckpoint=null;
        const latest=p?.latest_token_usage_record;
        // A checkpoint retains the latest usage as resume state; that may be a
        // different response. It establishes no association unless both IDs agree.
        if(!own||!id(p?.compaction_response_id)||!latest||latest.thread_id!==own
          ||p.compaction_response_id!==latest.response_id||!id(latest.turn_id)||!id(latest.response_id))return;
        const key=identityKey(JSON.stringify([own,latest.response_id]));
        const cp={raw:usage(latest.usage),total:usage(latest.turn_token_usage),turn:latest.turn_id,
          previousModel:id(p.resume_metadata?.previous_turn_settings?.model)?p.resume_metadata.previous_turn_settings.model:null,
          at:Date.parse(record.timestamp),record:records,context:null};
        const list=checkpoints.get(key)??[];list.push(cp);checkpoints.set(key,list);pendingCheckpoint=cp;
        return;
      }
      if (record?.type === 'turn_context') {
        activeTurn = id(p?.turn_id) ? p.turn_id : null;
        if (activeTurn && typeof p.model === 'string') {
          const t=turn(activeTurn),replacement=pendingCheckpoint?.turn===activeTurn;
          const tier=codexTierObservation(record);
          const context={model:id(p.model)?p.model:null,at:Date.parse(record.timestamp),record:records,
            settingsRevision,direct:!replacement,validAtCapture:!settingsModel||settingsModel===p.model,
            tier:tier?.status==='observed'?{rawTier:tier.rawTier,tierSource:tier.tierSource,timestamp:record.timestamp}:replacement?null:settingsTier};
          if(replacement)pendingCheckpoint.context=context;
          t.model=context.model;t.modelAt=context.at;t.context=context;
        }
        pendingCheckpoint=null;
        return;
      }
      if (record?.type === 'event_msg' && p?.type === 'task_started') {
        pendingCheckpoint=null;
        if (id(p.turn_id)) activeTurn = p.turn_id;
        return;
      }
      if (record?.type === 'event_msg' && p?.type === 'thread_settings_applied') {
        pendingCheckpoint=null;
        if (typeof p.thread_settings?.model === 'string') {
          if(settingsModel!==p.thread_settings.model)settingsRevision++;
          settingsModel=p.thread_settings.model;
        }
        const tier=codexTierObservation(record);
        if(tier?.status==='observed')settingsTier={rawTier:tier.rawTier,tierSource:tier.tierSource,timestamp:record.timestamp};
        else if(tier?.status==='malformed')settingsTier=null;
        return;
      }
      if(record?.type==='event_msg'&&p?.type==='model_reroute'){
        const key=id(p.turn_id)?p.turn_id:activeTurn;if(key)turn(key).routingSeen=true;
        return;
      }
      if (record?.type === 'event_msg' && p?.type === 'token_count') {
        const last = p.info?.last_token_usage;
        const total = p.info?.total_token_usage;
        const unchanged = total && legacyTotal && Number.isSafeInteger(total.total_tokens)
          && total.total_tokens >= 0 && KEYS.every(k => (total[k] ?? null) === (legacyTotal[k] ?? null));
        if (total) legacyTotal = Object.fromEntries(KEYS.map(k => [k, total[k] ?? null]));
        // UI/quota status can repeat the previous response after a new turn
        // starts. Its unchanged cumulative counters establish no new spend.
        if (unchanged) return;
        if (last?.input_tokens > 0 || last?.output_tokens > 0
            || (last == null && p.info?.total_token_usage?.total_tokens > 0)) {
          legacy.set(locator, { turn: activeTurn,
            last: last ? Object.fromEntries(KEYS.map(k => [k,
              Number.isSafeInteger(last[k]) ? last[k] : null])) : null });
        }
        return;
      }
      if (record?.type !== 'token_usage_record') return;
      pendingCheckpoint=null;
      modern = true;
      if (!Number.isFinite(Date.parse(record.timestamp))) fail('codex_response_usage_timestamp_invalid');
      if (!id(p?.thread_id) || !id(p?.turn_id) || !id(p?.response_id)) fail('codex_response_usage_identity_invalid');
      if (own === null) fail('codex_response_usage_session_unattributed');
      // A copied ancestor response belongs to the original thread, never to
      // the child that happens to contain its replayed JSONL line.
      if (p.thread_id !== own) { diagnostics.foreignResponses++; foreignTurns.add(p.turn_id); return; }
      const raw = usage(p.usage), total = usage(p.turn_token_usage);
      const key = identityKey(JSON.stringify([p.thread_id, p.response_id]));
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)) fail('codex_response_usage_identity_invalid');
      const previous = responses.get(key);
      if (previous) {
        if (previous.turn !== p.turn_id || !same(previous.raw, raw) || !same(previous.total, total)) {
          fail('codex_response_usage_identity_conflict');
        }
        diagnostics.duplicateResponses++; return;
      }
      if (responses.size >= maximumResponses) fail('codex_response_usage_resource_limit');
      const t = turn(p.turn_id);
      // A physical page may begin after an unrecorded response prefix. Its
      // first exact raw response is still known, but the prefix is not spend
      // and cannot be used to claim complete turn coverage. Every later
      // response must continue the observed cumulative chain exactly.
      if (!t.hasResponses) {
        const prefix = difference(total, raw);
        if (prefix === null) {
          const e = new Error('codex_response_usage_chain_incomplete'); e.code = e.message;
          e.diagnostic = { firstResponse: true,
            previous: null, response: KEYS.map(k => raw[k]),
            cumulative: KEYS.map(k => total[k]) };
          throw e;
        }
        t.unverifiedPrefix = KEYS.some(k => prefix[k] !== 0);
        if (t.unverifiedPrefix) diagnostics.unverifiedPrefixTurns++;
      } else if (!KEYS.every(k => Number.isSafeInteger(t.total[k] + raw[k])
          && t.total[k] + raw[k] === total[k])) {
        const e = new Error('codex_response_usage_chain_incomplete'); e.code = e.message;
        e.diagnostic = { firstResponse: false,
          previous: KEYS.map(k => t.total[k]), response: KEYS.map(k => raw[k]),
          cumulative: KEYS.map(k => total[k]) };
        throw e;
      }
      const originalModel = t.model && t.modelAt <= Date.parse(record.timestamp)
        && (!settingsModel || settingsModel === t.model) ? t.model : null;
      const context=t.context;
      const frozenRequest=context?.direct&&context.validAtCapture
        &&context.record>t.lastResponseRecord&&(t.hasResponses||!t.unverifiedPrefix);
      const sameSettings=context?.settingsRevision===settingsRevision&&context.validAtCapture;
      // Preserve the established, coherent context/settings path. Additional
      // request evidence repairs gaps; capture-time settings lag must not
      // invalidate a model already coherent when usage was persisted.
      const model=originalModel??(context&&context.at<=Date.parse(record.timestamp)&&!t.routingSeen&&(frozenRequest||sameSettings)
        ?context.model:null);
      t.total = total; t.hasResponses = true;t.lastResponseRecord=records;
      responses.set(key, { key, locator, raw, total, turn: p.turn_id, model,originalModel,record:records,requestTier:context?.tier??null,
        cacheWriteAssumedZero: p.usage.cache_write_input_tokens == null,
        observedAtMs: Date.parse(record.timestamp) });
      diagnostics.responses++;
    },
    finish() {
      for(const [key,list]of checkpoints){
        const r=responses.get(key);if(!r)continue;
        const candidates=[];
        for(const cp of list){
          if(cp.turn!==r.turn||!same(cp.raw,r.raw)||!same(cp.total,r.total))fail('codex_response_usage_checkpoint_conflict');
          const context=cp.context;
          candidates.push(!turns.get(r.turn)?.routingSeen&&cp.record>r.record&&cp.at>=r.observedAtMs&&context&&context.record>cp.record&&context.at>=cp.at
            &&cp.previousModel&&cp.previousModel===context.model?cp.previousModel:null);
        }
        // The replacement may be a different model from the compactor, and a
        // previous-model attempt may fall back. Never choose either side then.
        if(r.originalModel===null){
          r.model=candidates.length&&candidates.every(m=>m&&m===candidates[0])?candidates[0]:null;
          r.requestTier=list[0]?.context?.tier??null;
        }
      }
      diagnostics.unattributedModels=0;diagnostics.modelsRecovered=0;
      for(const r of responses.values()){
        if(r.model===null)diagnostics.unattributedModels++;
        else if(r.originalModel!==r.model)diagnostics.modelsRecovered++;
      }
      const byLocator = new Map([...responses.values()].map(r => [r.locator, {
        key:r.key,locator:r.locator,raw:r.raw,model:r.model,
        cacheWriteAssumedZero:r.cacheWriteAssumedZero,observedAtMs:r.observedAtMs,
        ...(r.model!==null&&r.originalModel!==r.model?{requestTier:r.requestTier}:{}),
      }]));
      const suppressed = new Set();
      const byTurn = new Map();
      for (const r of responses.values()) { const list = byTurn.get(r.turn) ?? []; list.push(r); byTurn.set(r.turn, list); }
      for (const [locator, item] of legacy) {
        if (item.turn !== null && turns.get(item.turn)?.hasResponses) {
          if (item.last && byTurn.get(item.turn).some(response =>
            LEGACY_MATCH_KEYS.every(k => item.last[k] !== null
              && item.last[k] === response.raw[k])
              && (item.last.cache_write_input_tokens === response.raw.cache_write_input_tokens
                || (item.last.cache_write_input_tokens === null
                  && response.raw.cache_write_input_tokens === 0)))) {
            suppressed.add(locator);
          } else fail('codex_response_usage_legacy_conflict');
        } else if (item.turn !== null && foreignTurns.has(item.turn)) {
          suppressed.add(locator);
        }
      }
      // A modern file with unscoped legacy spend cannot establish overlap.
      // Do not silently add both streams or discard the unscoped record.
      if (responses.size && [...legacy.values()].some(item => item.turn === null)) {
        fail('codex_response_usage_legacy_scope_unattributed');
      }
      return { modern, diagnostics, responseAt: locator => byLocator.get(locator) ?? null,
        suppressLegacyAt: locator => suppressed.has(locator) };
    },
  };
}
