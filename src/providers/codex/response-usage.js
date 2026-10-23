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
const rawKey = value => JSON.stringify(KEYS.map(k => value[k]));
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
function explicitUsage(value) {
  if (!KEYS.every(k => Number.isSafeInteger(value?.[k]))) return null;
  try { return usage(value); } catch { return null; }
}

export function createResponseUsagePlan({ identityKey, maximumResponses = 100_000,
  maximumRecords = 250_000 } = {}) {
  if (typeof identityKey !== 'function') throw new TypeError('identityKey is required');
  if (!Number.isSafeInteger(maximumResponses) || maximumResponses < 0 || maximumResponses > 100_000
      || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 250_000) {
    throw new TypeError('Response usage limits are invalid');
  }
  const responses = new Map(), turns = new Map(), legacy = new Map(), foreignTurns = new Set(), checkpoints=new Map();
  let own = null, activeTurn = null, settingsModel = null, records = 0, modern = false, legacyTotal = null, legacyTotalAt = NaN;
  let settingsRevision=0,pendingCheckpoint=null,settingsTier=null,tierRevision=0;
  const diagnostics = { responses: 0, duplicateResponses: 0, foreignResponses: 0,
    unattributedModels: 0, unverifiedPrefixTurns: 0, modelsRecovered:0 };
  function turn(key) {
    let t = turns.get(key);
    if (!t) { t = { total: zero(), model: null, modelAt: null, hasResponses: false,
      unverifiedPrefix: false,context:null,tierContext:null,lastResponseRecord:-1,routingSeen:false }; turns.set(key, t); }
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
          previousTier:codexTierObservation({type:'turn_context',payload:p.resume_metadata?.previous_turn_settings}),
          at:Date.parse(record.timestamp),record:records,context:null,
          explicit:explicitUsage(latest.usage)!==null&&explicitUsage(latest.turn_token_usage)!==null};
        const list=checkpoints.get(key)??[];list.push(cp);checkpoints.set(key,list);pendingCheckpoint=cp;
        return;
      }
      if (record?.type === 'turn_context') {
        activeTurn = id(p?.turn_id) ? p.turn_id : null;
        if (activeTurn && typeof p.model === 'string') {
          const t=turn(activeTurn),replacement=pendingCheckpoint?.turn===activeTurn;
          const tier=codexTierObservation(record);
          const context={model:id(p.model)?p.model:null,at:Date.parse(record.timestamp),record:records,
            settingsRevision,tierRevision,direct:!replacement,validAtCapture:!settingsModel||settingsModel===p.model,
            tier:tier?.status==='observed'?{rawTier:tier.rawTier,tierSource:tier.tierSource,timestamp:record.timestamp}
              :tier?.status==='malformed'||replacement||!settingsTier
                ||Date.parse(settingsTier.timestamp)>Date.parse(record.timestamp)?null:settingsTier};
          if(replacement)pendingCheckpoint.context=context;
          t.model=context.model;t.modelAt=context.at;t.context=context;t.tierContext=context;
        } else if(activeTurn) {
          // An unusable request context supplies no tier association. Keep the
          // independent model policy, but never revive an older tier context.
          turn(activeTurn).tierContext=null;
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
        if(tier?.status==='observed'){
          if(!settingsTier||settingsTier.rawTier!==tier.rawTier)tierRevision++;
          settingsTier=Number.isFinite(Date.parse(record.timestamp))
            ?{rawTier:tier.rawTier,tierSource:tier.tierSource,timestamp:record.timestamp}:null;
        } else if(tier?.status==='malformed'){
          tierRevision++;settingsTier=null;
        }
        return;
      }
      if(record?.type==='event_msg'&&p?.type==='model_reroute'){
        const key=id(p.turn_id)?p.turn_id:activeTurn;if(key)turn(key).routingSeen=true;
        return;
      }
      if (record?.type === 'event_msg' && p?.type === 'token_count') {
        const last = p.info?.last_token_usage;
        const total = p.info?.total_token_usage;
        const before = explicitUsage(legacyTotal), after = explicitUsage(total), beforeAt = legacyTotalAt;
        const unchanged = total && legacyTotal && Number.isSafeInteger(total.total_tokens)
          && total.total_tokens >= 0 && KEYS.every(k => (total[k] ?? null) === (legacyTotal[k] ?? null));
        if (total) {
          legacyTotal = Object.fromEntries(KEYS.map(k => [k, total[k] ?? null]));
          legacyTotalAt = Date.parse(record.timestamp);
        }
        // UI/quota status can repeat the previous response after a new turn
        // starts. Its unchanged cumulative counters establish no new spend.
        if (unchanged) return;
        if (last?.input_tokens > 0 || last?.output_tokens > 0
            || (last == null && p.info?.total_token_usage?.total_tokens > 0)) {
          legacy.set(locator, { turn: activeTurn, record:records, at:Date.parse(record.timestamp),
            delta:before&&after&&beforeAt<=Date.parse(record.timestamp)?difference(after,before):null,
            last: last ? Object.fromEntries(KEYS.map(k => [k,
              Number.isSafeInteger(last[k]) ? last[k] : null])) : null });
        }
        return;
      }
      if (record?.type !== 'token_usage_record') return;
      pendingCheckpoint=null;
      if (!Number.isFinite(Date.parse(record.timestamp))) fail('codex_response_usage_timestamp_invalid');
      if (!id(p?.thread_id) || !id(p?.turn_id) || !id(p?.response_id)) fail('codex_response_usage_identity_invalid');
      if (own === null) fail('codex_response_usage_session_unattributed');
      // A copied ancestor response belongs to the original thread, never to
      // the child that happens to contain its replayed JSONL line.
      if (p.thread_id !== own) { diagnostics.foreignResponses++; foreignTurns.add(p.turn_id); return; }
      modern = true;
      const raw = usage(p.usage), total = usage(p.turn_token_usage);
      const key = identityKey(JSON.stringify([p.thread_id, p.response_id]));
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)) fail('codex_response_usage_identity_invalid');
      const previous = responses.get(key);
      if (previous) {
        if (previous.turn !== p.turn_id || !same(previous.raw, raw) || !same(previous.total, total)
            || previous.observedAtMs !== Date.parse(record.timestamp)
            || previous.cacheWriteAssumedZero !== (p.usage.cache_write_input_tokens == null)) {
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
      const tierContext=t.tierContext;
      const frozenTier=tierContext?.direct&&tierContext.record>t.lastResponseRecord
        &&(t.hasResponses||!t.unverifiedPrefix);
      const capturedTier=tierContext?.direct&&tierContext.at<=Date.parse(record.timestamp)
        &&(frozenTier||tierContext.tierRevision===tierRevision);
      const requestTier=capturedTier?tierContext.tier:null;
      t.total = total; t.hasResponses = true;t.lastResponseRecord=records;
      responses.set(key, { key, locator, raw, total, turn: p.turn_id, model,originalModel,record:records,requestTier,
        cacheWriteAssumedZero: p.usage.cache_write_input_tokens == null,
        observedAtMs: Date.parse(record.timestamp) });
      diagnostics.responses++;
    },
    finish() {
      for(const [key,list]of checkpoints){
        const r=responses.get(key);if(!r)continue;
        const candidates=[],tierCandidates=[];
        for(const cp of list){
          if(cp.turn!==r.turn||!same(cp.raw,r.raw)||!same(cp.total,r.total))fail('codex_response_usage_checkpoint_conflict');
          const context=cp.context;
          const candidate=!turns.get(r.turn)?.routingSeen&&cp.record>r.record&&cp.at>=r.observedAtMs&&context&&context.record>cp.record&&context.at>=cp.at
            &&cp.previousModel&&cp.previousModel===context.model?cp.previousModel:null;
          candidates.push(candidate);
          // The replacement context describes the resumed request. Only an
          // independent prior-settings declaration agreeing with it can attest
          // the earlier compactor's tier, and every checkpoint must agree.
          tierCandidates.push(candidate&&cp.previousTier?.status==='observed'
            &&context.tier&&cp.previousTier.rawTier===context.tier.rawTier
            ?{rawTier:cp.previousTier.rawTier,tierSource:cp.previousTier.tierSource,
              timestamp:new Date(cp.at).toISOString()}:null);
        }
        // The replacement may be a different model from the compactor, and a
        // previous-model attempt may fall back. Never choose either side then.
        if(r.originalModel===null){
          r.model=candidates.length&&candidates.every(m=>m&&m===candidates[0])?candidates[0]:null;
          r.requestTier=tierCandidates.length&&tierCandidates.every(t=>t&&t.rawTier===tierCandidates[0]?.rawTier)
            ?tierCandidates[0]:null;
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
        requestTier:r.model===null?null:r.requestTier,
        verificationKey:identityKey(JSON.stringify(['codex-response-evidence/v1',r.key,
          r.turn,r.raw,r.total,r.observedAtMs,r.cacheWriteAssumedZero,r.model,
          r.model===null||r.requestTier===null?null:[r.requestTier.rawTier,
            r.requestTier.tierSource,Date.parse(r.requestTier.timestamp)]])),
      }]));
      const suppressed = new Set();
      const byTurn = new Map();
      const responsesByTurn = new Map(), checkpointsByTurn = new Map();
      for (const r of responses.values()) {
        const counts=byTurn.get(r.turn)??new Map(),key=rawKey(r.raw);
        counts.set(key,(counts.get(key)??0)+1);byTurn.set(r.turn,counts);
        if (turns.get(r.turn).unverifiedPrefix) {
          const rows=responsesByTurn.get(r.turn)??[];rows.push(r);responsesByTurn.set(r.turn,rows);
        }
      }
      for (const [key, list] of checkpoints) {
        for (const cp of list) {
          const rows=checkpointsByTurn.get(cp.turn)??[];
          rows.push({key,...cp});checkpointsByTurn.set(cp.turn,rows);
        }
      }
      const continuationPairs = new Map(), claimedContinuations = new Set();
      for (const [turnId, rows] of responsesByTurn) {
        if (!turns.get(turnId).unverifiedPrefix) continue;
        const anchors=checkpointsByTurn.get(turnId)??[], first=rows[0];
        if (anchors.length!==1) continue;
        const cp=anchors[0], prefix=difference(first.total,first.raw);
        // A retained compactor is a baseline only. Require a single exact,
        // preceding, otherwise unrepresented response covering this prefix.
        // This does not attribute, price or emit that historical prefix.
        if (!cp.explicit||responses.has(cp.key)||cp.record>=first.record||cp.at>first.observedAtMs
            ||!Number.isFinite(cp.at)||!same(cp.raw,cp.total)||!same(cp.total,prefix)) continue;
        for (const r of rows) {
          for (const position of [r.record-1,r.record+1]) {
            const pairs=continuationPairs.get(position)??[];
            pairs.push({response:r,checkpoint:cp});continuationPairs.set(position,pairs);
          }
        }
      }
      for (const [locator, item] of legacy) {
        if (item.turn !== null && turns.get(item.turn)?.hasResponses) {
          // Equal token vectors do not establish equal occurrences. An unknown
          // prefix cannot prove which legacy rows overlap; a complete turn can
          // consume each exact response vector at most once.
          if(turns.get(item.turn).unverifiedPrefix) {
            // Counter differences, latest increments, order and instant must
            // independently corroborate each adjacent pair. Vector equality
            // alone cannot identify an occurrence in an unknown prefix.
            const pairs=(continuationPairs.get(item.record)??[]).filter(({response:r,checkpoint:cp}) =>
              r.turn===item.turn&&cp.record<item.record&&cp.at<=item.at
              &&!r.cacheWriteAssumedZero&&item.last&&KEYS.every(k=>item.last[k]!==null)
              &&item.at===r.observedAtMs&&item.delta&&same(item.delta,r.raw)&&same(item.last,r.raw));
            if(pairs.length!==1||claimedContinuations.has(pairs[0].response.key))fail('codex_response_usage_legacy_conflict');
            claimedContinuations.add(pairs[0].response.key);
          }
          if(!item.last
            ||!LEGACY_MATCH_KEYS.every(k=>item.last[k]!==null))fail('codex_response_usage_legacy_conflict');
          const counts=byTurn.get(item.turn),key=rawKey({...item.last,
            cache_write_input_tokens:item.last.cache_write_input_tokens??0});
          const remaining=counts.get(key)??0;
          if(remaining===0)fail('codex_response_usage_legacy_conflict');
          counts.set(key,remaining-1);suppressed.add(locator);
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
