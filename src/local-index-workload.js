import { analyzeWorkload, normalizeQuotaResetEvent, WORKLOAD_POLICY } from "@app-usagemonitor/quota-analysis";
import { quotaWeightedApiPriceEquivalent } from "@app-usagemonitor/accounting";
import { openLocalIndexStore, withReadSnapshot } from "./local-index-store.js";
import { committedPredicate } from "./local-index-rollup.js";
import { quotaWindowProjection, usageProjection } from "./local-companion-usage-model.js";
import { forEachLocalCollectorRecord } from "./local-collector-state.js";
import { setImmediate } from "node:timers/promises";
import { createAccountingPricer } from "./replay-safe-accounting-cache.js";
import {createWorkloadAccountStateStore,validateWorkloadAccountState} from './local-index-workload-account-state.js';
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import { readRuntimeModelEvidenceStatus } from './local-index-runtime-model-evidence.js';
import { localCollectorQuotaRecordScopeToken } from './local-collector-projection.js';

// Identity is private transport metadata, never part of the evidence DTO.
const quotaContexts=new WeakMap();

const STATE_SCHEMA="overview-workload-state-v3";

// Private, bounded projection: account handles are compared here and never
// returned. The comparison stops at a change or loss of established identity.
export async function readWorkloadQuotaEvidence({stateFile,fromMs,nowMs,historyFromMs=fromMs,signal=null}) {
  if(typeof stateFile!=="string"||!stateFile||!Number.isSafeInteger(fromMs)||!Number.isSafeInteger(historyFromMs)
    ||!Number.isSafeInteger(nowMs)||fromMs>nowMs||historyFromMs>nowMs)
    throw new TypeError("Invalid workload quota evidence input");
  signal?.throwIfAborted();
  const observations=[],resetEvents=[],historyResetEvents=[];
  let scope=null,continuityThroughMs=null,count=0,lastIdentity=null,epoch=0;
  const historyQuota=[],scopedResetEvents=[],comparisonQuota=[];
  const result=await forEachLocalCollectorRecord({stateFile,kinds:["codex_quota_snapshot"],orderBy:"observed_at",
    onRecord:async (record,{recordId})=>{
      if(++count>100_000)throw Object.assign(new Error("quota_history_too_large"),{code:"quota_history_too_large"});
      if(count%256===0)await setImmediate();
      signal?.throwIfAborted();
      const atMs=Date.parse(record.observedAt);
      if(record.source!=="app_server_read"||!Number.isSafeInteger(atMs)||atMs<Math.min(fromMs,historyFromMs)||atMs>nowMs)return;
      if(!Array.isArray(record.windows)||record.windows.length>256
        ||record.resetEvents!==undefined&&(!Array.isArray(record.resetEvents)||record.resetEvents.length>2304))
        throw Object.assign(new Error("quota_history_invalid"),{code:"quota_history_invalid"});
      const identity=record.accountScope?.status==="available"&&typeof record.accountScope.scopeId==="string"
        ?record.accountScope.scopeId:null;
      const token=localCollectorQuotaRecordScopeToken(record);
      if(token!==lastIdentity||token===null)epoch++;
      lastIdentity=token;
      const windows=[];
      for(const raw of Array.isArray(record.windows)?record.windows:[]){
        const q=quotaWindowProjection(raw);
        if(!q||q.limitId!=="codex"||q.durationMinutes!==10080)continue;
        const resetAtMs=Date.parse(q.resetAt);
        const value={atMs,observationOrder:recordId,usedPercent:q.usedPercent,resetAtMs,planType:q.planType,limitId:q.limitId,
          resetKey:`${resetAtMs}:${q.planType}:${q.limitId}`};
        windows.push(value);
      }
      const events=[];
      for(const raw of Array.isArray(record.resetEvents)?record.resetEvents:[]){
        const event=normalizeQuotaResetEvent(raw);
        if(!event)throw Object.assign(new Error("quota_history_invalid"),{code:"quota_history_invalid"});
        if(event&&["scheduled_reset","unknown_reset","banked_reset_used"].includes(event.kind)
          &&event.provider==="openai_codex"&&event.limitId==="codex"&&event.windowDurationMins===10080
          &&Date.parse(event.observedAt)===atMs&&windows.some(q=>q.planType===event.planType))events.push(event);
      }
      if(token!==null){
        historyQuota.push(...windows.map(q=>({...q,scopeToken:token,accountKey:`${token}:${epoch}`,evidence:true})));
        scopedResetEvents.push(...events.map(event=>({token,event})));
      }
      if(historyQuota.length>100_000||scopedResetEvents.length>100_000)
        throw Object.assign(new Error('quota_history_too_large'),{code:'quota_history_too_large'});
      // History reset evidence and this process's strict comparison have
      // different ranges. Reading earlier history must not bind the startup
      // comparison to a previous account or suppress its newer observations.
      if(identity!==null&&atMs>=historyFromMs)historyResetEvents.push(...events);
      if(historyResetEvents.length>100_000)
        throw Object.assign(new Error("quota_history_too_large"),{code:"quota_history_too_large"});
      if(atMs<fromMs)return;
      if(scope!==null&&identity!==scope){continuityThroughMs??=atMs;return;}
      if(identity===null)return;
      scope??=identity;
      if(continuityThroughMs!==null)return;
      observations.push(...windows);resetEvents.push(...events);
      comparisonQuota.push(...windows.map(q=>({...q,accountKey:token===null?null:`${token}:${epoch}`})));
      if(observations.length>100_000||resetEvents.length>100_000)
        throw Object.assign(new Error("quota_history_too_large"),{code:"quota_history_too_large"});
    }});
  const evidence={status:result.status,observations,resetEvents,historyResetEvents,continuityThroughMs};
  quotaContexts.set(evidence,{historyQuota,scopedResetEvents,comparisonQuota});
  return evidence;
}
function validBaseline(b){return b===null||b&&Object.keys(b).length===5
  &&["atMs","usedPercent","resetAtMs","planType","limitId"].every(k=>Object.hasOwn(b,k))
  &&Number.isSafeInteger(b.atMs)&&b.atMs>=0&&Number.isSafeInteger(b.resetAtMs)&&b.resetAtMs>=0
  &&Number.isFinite(b.usedPercent)&&b.usedPercent>=0&&b.usedPercent<=100
  &&/^[a-z0-9_]{1,64}$/u.test(b.planType)&&b.limitId==="codex";}
const validState=validateWorkloadAccountState;
export const workloadStateStore=createWorkloadAccountStateStore;
export function workloadState(result){return{schemaVersion:STATE_SCHEMA,
  comparison:{startedAtMs:result.comparison.startedAtMs,capacityUsd:result.comparison.capacityUsd,
    planType:result.comparison.planType,baseline:result.comparison.baseline},capacityHistory:result.capacityHistory};}

const SAFE_ERRORS = new Set(["local_index_newer_version", "local_index_family_mismatch",
  "local_index_unavailable", "price_missing", "numeric_invalid", "workload_context_too_large"]);
function failure(code, previous, nowMs, liveQuota, stage) {
  const error = { code: SAFE_ERRORS.has(code) ? code : stage==="aggregation"?"aggregation_failed":"workload_read_failed", stage, retryable: true };
  const fallback=analyzeWorkload({nowMs,quota:liveQuota});
  return previous ? { ...structuredClone(previous), status:"stale", current:{state:"unknown",level:null,ratePpPerHour:null,hours:null},attemptedAt:new Date(nowMs).toISOString(), errors:[error] }
    : {...fallback,status:"unavailable",errors:[error]};
}
function liveWeeklyQuota(windows){
  return windows.filter(q=>Number(q.durationMinutes??q.windowDurationMinutes??q.windowMinutes)===10080
    &&(q.limitId===null||q.limitId===undefined||q.limitId==="codex")).map(q=>({
      atMs:Date.parse(q.observedAt),usedPercent:Number.isFinite(q.usedPercent)?q.usedPercent:100-q.remainingPercent,
      planType:q.planType??'unknown',limitId:'codex',resetAtMs:Date.parse(q.resetAt??q.resetsAt),
      resetKey:`${Date.parse(q.resetAt??q.resetsAt)}:${q.planType??"unknown"}:codex`,
    })).filter(q=>Number.isFinite(q.atMs)&&Number.isFinite(q.usedPercent)&&!q.resetKey.startsWith("NaN:"));
}

// Retained local lineage establishes replay without changing stored facts.
// Raw UUIDs stay inside this reader; only index-local session handles reach
// the runtime-neutral analyzer. Ambiguous or cyclic ancestry proves nothing.
function workAncestors(database) {
  const ids = new Map(database.prepare("SELECT id,session_uuid FROM session WHERE session_uuid IS NOT NULL").all()
    .map((s) => [s.session_uuid,String(s.id)]));
  const parents = new Map();
  for (const s of database.prepare("SELECT session_id,lineage_json FROM source WHERE lineage_json IS NOT NULL").iterate()) {
    let lineage; try { lineage=JSON.parse(s.lineage_json)?.lineage; } catch { continue; }
    if (!lineage?.isFork || !lineage.parentId) continue;
    const child=String(s.session_id),parent=ids.get(lineage.parentId);
    if (parent) { const set=parents.get(child)??new Set();set.add(parent);parents.set(child,set); }
  }
  const result=new Map();
  for (const child of parents.keys()) {
    const chain=[],seen=new Set([child]);let at=child,valid=true;
    while (parents.has(at)) {
      const set=parents.get(at);if(set.size!==1){valid=false;break;}
      at=[...set][0];if(seen.has(at)){valid=false;break;}seen.add(at);chain.push(at);
    }
    result.set(child,valid?chain:[]);
  }
  return result;
}

// Display-window clipping must not discard the ancestry evidence needed to
// recognize copied boundaries. Retrieve only older facts for the same tasks
// and their established ancestors, within the reader's existing transaction.
function completeWorkAncestry(database, rows, ancestors, beforeMs) {
  const wanted=new Map();
  for(const row of rows){
    const chain=ancestors.get(String(row.session_id))??[];
    if(!chain.length)continue;
    const key=Buffer.from(row.task_key).toString("hex"),sessions=wanted.get(key)??new Set();
    for(const session of chain)sessions.add(session);
    wanted.set(key,sessions);
  }
  const keys=[...wanted.keys()];let inspected=0;
  for(let i=0;i<keys.length;i+=128){
    const batch=keys.slice(i,i+128);
    const older=database.prepare(`SELECT w.* FROM work_lifecycle_fact w
      WHERE w.task_key IN (${batch.map(()=>"?").join(",")}) AND w.observed_at_ms<?
      AND ${committedPredicate("w")} ORDER BY w.observed_at_ms,w.source_id,w.source_offset LIMIT 100001`)
      .all(...batch.map(key=>Buffer.from(key,"hex")),beforeMs);
    inspected+=older.length;
    if(inspected>100_000)throw Object.assign(new Error("local_index_unavailable"),{code:"local_index_unavailable"});
    for(const row of older){
      if(wanted.get(Buffer.from(row.task_key).toString("hex")).has(String(row.session_id)))rows.push(row);
    }
  }
  return rows;
}

/** Read only committed content-free facts. A failure never erases last-good analytics. */
export function readLocalIndexWorkload({ indexFile, nowMs, quotaWindows = [], capacity = null,
  previous = null, storedState = null, liveSinceMs = nowMs, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  sourceFresh = false, declaredSpeedBaselines = [], quotaEvidence = null, signal = null,
  accountScopeToken = undefined, previousAccountScopeToken = null } = {}) {
  let database,stage="index";
  const scoped=accountScopeToken!==undefined;
  const knownScope=typeof accountScopeToken==='string'&&/^[a-f0-9]{64}$/u.test(accountScopeToken);
  const context=quotaContexts.get(quotaEvidence);
  // An unknown or different account cannot inherit a last-good comparison.
  if(scoped&&(!knownScope||previousAccountScopeToken!==accountScopeToken))previous=null;
  const liveQuota=liveWeeklyQuota(quotaWindows);
  try {
    signal?.throwIfAborted();
    database = openLocalIndexStore(indexFile,{readOnly:true});
    return withReadSnapshot(database,({commitSeq})=>{
      const from = Math.max(0,nowMs-WORKLOAD_POLICY.historyMs);
      let comparisonFrom=Math.max(0,Math.min(nowMs,liveSinceMs));
      if(scoped){
        const latest=(context?.historyQuota??[]).filter(q=>q.scopeToken===accountScopeToken).at(-1);
        const epochStart=latest?(context.historyQuota.find(q=>q.accountKey===latest.accountKey)?.atMs??nowMs):nowMs;
        comparisonFrom=Math.max(comparisonFrom,epochStart);
      }
      // One preceding weekly cycle closes intervals crossing the seven-day
      // display boundary. A still older anchor is identity/context evidence,
      // never proof that omitted usage was zero.
      const evidenceFrom=Math.max(0,Math.min(from-WORKLOAD_POLICY.comparisonWindowMs
        -WORKLOAD_POLICY.comparisonDeadlineUncertaintyMs,comparisonFrom));
      const current = quotaWindows.filter((q)=>Number(q.windowMinutes ?? q.windowDurationMinutes ?? q.durationMinutes)===10080
        && (q.limitId===undefined || q.limitId===null || q.limitId==="codex"))
        .sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];
      const plan = current?.planType && current.planType!=="unknown" ? current.planType : capacity?.planScope?.planType ?? null;
      const quotaSelect=`SELECT DISTINCT q.observed_at_ms,q.used_percent,q.resets_at_ms,q.plan_type,q.limit_id,
        CASE WHEN a.status='available' THEN hex(a.scope_local) ELSE NULL END AS account_key
        FROM quota_occurrence q LEFT JOIN usage_event u ON u.source_id=q.source_id AND u.source_offset=q.source_offset
        LEFT JOIN account_scope a ON a.id=u.account_scope_id`;
      const quotaRows = database.prepare(`${quotaSelect}
        WHERE q.duration_mins=10080 AND q.admission='admitted'
        AND q.observed_at_ms>=? AND q.observed_at_ms<=? AND q.limit_id='codex' AND ${committedPredicate("q")}
        ORDER BY q.observed_at_ms LIMIT 100001`).all(evidenceFrom,nowMs);
      if(quotaRows.length>100_000)throw Object.assign(new Error('workload_context_too_large'),{code:'workload_context_too_large'});
      // A preceding anchor establishes the visible era, without importing
      // future labels or rewriting any unknown historical source occurrence.
      const anchor=database.prepare(`SELECT MAX(q.observed_at_ms) AS at FROM quota_occurrence q
        WHERE q.duration_mins=10080 AND q.admission='admitted' AND q.limit_id='codex'
        AND q.plan_type IS NOT NULL AND q.plan_type<>'unknown' AND q.observed_at_ms<? AND ${committedPredicate('q')}`).get(evidenceFrom).at;
      if(anchor!==null)quotaRows.push(...database.prepare(`${quotaSelect} WHERE q.observed_at_ms=?
        AND q.duration_mins=10080 AND q.admission='admitted' AND q.limit_id='codex' AND ${committedPredicate('q')} LIMIT 100001`).all(anchor));
      if(quotaRows.length>100_000)throw Object.assign(new Error('workload_context_too_large'),{code:'workload_context_too_large'});
      let quota = quotaRows
        .map((q)=>({atMs:q.observed_at_ms,usedPercent:q.used_percent,
          resetAtMs:q.resets_at_ms,planType:q.plan_type??'unknown',limitId:'codex',...(q.account_key?{accountKey:`index:${q.account_key}`} : {}),
          resetKey:`${q.resets_at_ms}:${q.plan_type??'unknown'}:codex`}));
      if(scoped){
        // Rollout quota facts have no proven collector account identity. Keep
        // the source facts, but do not assign them to the current account.
        quota=knownScope?(context?.historyQuota??[]).filter(q=>q.scopeToken===accountScopeToken)
          .map(({scopeToken,...q})=>q):[];
      }
      if (current) {
        const atMs=Date.parse(current.observedAt), resetAtMs=Date.parse(current.resetAt ?? current.resetsAt);
        const usedPercent=Number.isFinite(current.usedPercent)?current.usedPercent:100-current.remainingPercent;
        const matching=quota.filter(q=>q.atMs===atMs&&q.usedPercent===usedPercent&&q.resetAtMs===resetAtMs).at(-1);
        if(Number.isFinite(atMs)&&Number.isFinite(resetAtMs)&&Number.isFinite(usedPercent)) quota.push({atMs,usedPercent,
          ...(scoped?{accountKey:knownScope?matching?.accountKey??`${accountScopeToken}:current:${atMs}`:null,
            observationOrder:matching?.observationOrder??Number.MAX_SAFE_INTEGER,conflict:matching?.conflict===true}:{}),
          resetAtMs,planType:current.planType??"unknown",limitId:"codex",direct:true,resetKey:`${resetAtMs}:${current.planType??"unknown"}:codex`});
      }
      const pricer=createAccountingPricer();
      const usage=[],pricingRecords=[];let pricingIssueCount=0,usageRows=0;
      for(const r of database.prepare(`SELECT u.*,m.model_id,t.codex_speed_mode,t.api_service_tier
        FROM usage_event u JOIN model m ON m.id=u.model_id JOIN tier_semantics t ON t.id=u.tier_id
        WHERE u.observed_at_ms>=? AND u.observed_at_ms<=? AND ${committedPredicate("u")}
        ORDER BY u.observed_at_ms,u.source_id,u.source_offset`).iterate(evidenceFrom,nowMs)) {
        if(++usageRows>1_000_000)throw Object.assign(new Error('workload_context_too_large'),{code:'workload_context_too_large'});
        if(usageRows%1024===0)signal?.throwIfAborted();
        const record={observedAt:new Date(r.observed_at_ms).toISOString(),model:r.model_id,
          totalInputContextTokens:r.total_input_context,components:{input_uncached_tokens:r.tokens_in_uncached,
            input_cache_read_tokens:r.tokens_in_cache_read,input_cache_write_tokens:r.tokens_in_cache_write,
            output_text_tokens:r.tokens_out_text,output_reasoning_tokens:r.tokens_out_reasoning,output_combined_tokens:r.tokens_out_combined},
          tierSemantics:{codexSpeedMode:r.codex_speed_mode,apiServiceTier:r.api_service_tier}};
        const p=usageProjection(record,declaredSpeedModeAt(declaredSpeedBaselines,r.observed_at_ms)??"unknown",pricer);
        if(!p || p.isSpark)continue;
        const speed=["standard","fast","ultrafast"].includes(p.speed)?p.speed
          :["standard","fast","ultrafast"].includes(p.declaredSpeed)?p.declaredSpeed:"standard";
        const weighted=quotaWeightedApiPriceEquivalent({apiPriceEquivalentUsd:p.apiPriceEquivalentUsd,
          model:p.model,mode:speed,eventTime:record.observedAt,standardPriceCardIds:p.priceCardIds,
          totalInputContextTokens:r.total_input_context});
        const priced=p.pricingCoverageStatus==="fully_priced"&&Number.isFinite(weighted.usd);
        usage.push({atMs:r.observed_at_ms,session:String(r.session_id),usd:weighted.usd,priced});
        if(!priced&&r.observed_at_ms>=from){pricingIssueCount++;if(pricingRecords.length<2000)pricingRecords.push({at:record.observedAt,
          model:p.model,reason:p.model==='unknown'?'model_unknown':'price_incomplete',tokens:p.totalTokens,
          inputUncached:r.tokens_in_uncached,cacheRead:r.tokens_in_cache_read,
          output:r.tokens_out_combined??(r.tokens_out_text===null||r.tokens_out_reasoning===null?null:r.tokens_out_text+r.tokens_out_reasoning)});}
      }
      const ancestors=workAncestors(database);
      const workFrom=Math.max(0,evidenceFrom-24*3600000);
      const workRows=database.prepare(`SELECT w.* FROM work_lifecycle_fact w
        WHERE w.observed_at_ms>=? AND w.observed_at_ms<=? AND ${committedPredicate("w")}
        ORDER BY w.observed_at_ms,w.source_id,w.source_offset LIMIT 100001`).all(workFrom,nowMs);
      if(workRows.length>100_000)throw Object.assign(new Error('workload_context_too_large'),{code:'workload_context_too_large'});
      const events=completeWorkAncestry(database,workRows,ancestors,workFrom)
        .map((e)=>({key:Buffer.from(e.task_key).toString("hex"),session:String(e.session_id),
          kind:e.kind,atMs:e.observed_at_ms,durationMs:e.duration_ms,ancestors:ancestors.get(String(e.session_id))??[]}));
      const selected=capacity?.status==="available"&&capacity.planScope?.planType===plan
        &&(!scoped||knownScope&&capacity.accountScopeToken===accountScopeToken)?capacity.scenarios?.[capacity.selectedScenario]:null;
      const previousState=scoped?(knownScope?storedState:null):previous??storedState;
      // A display plan/window selects calculation inputs, not retained evidence.
      const retainedHistory=previousState?.capacityHistory?.filter((c)=>
        validState({schemaVersion:STATE_SCHEMA,comparison:{startedAtMs:0,capacityUsd:null,planType:null,baseline:null},capacityHistory:[c]}))??[];
      const history=retainedHistory.filter(c=>c.planType===plan);
      if(selected && Number.isFinite(selected.medianCapacityUsd)) {
        const last=history.at(-1);
        if(!last||last.usd!==selected.medianCapacityUsd||last.version!==selected.cohortId){
          const entry={usd:selected.medianCapacityUsd,availableAtMs:Math.min(nowMs,Date.parse(capacity.computedAt)||nowMs),planType:plan,version:selected.cohortId,basisId:selected.basisId};
          history.push(entry);retainedHistory.push(entry);
        }
      }
      if(retainedHistory.length>4096)throw Object.assign(new Error('workload_context_too_large'),{code:'workload_context_too_large'});
      retainedHistory.sort((a,b)=>a.availableAtMs-b.availableAtMs);
      history.sort((a,b)=>a.availableAtMs-b.availableAtMs);
      const before=history.filter(x=>x.availableAtMs<from).at(-1);
      const validHistory=[...(before?[before]:[]),...history.filter(x=>x.availableAtMs>=from)];
      const cap=validHistory.at(-1)??null;
      // Scoped comparisons replay the retained current epoch. The old saved
      // baseline has no durable observation order and cannot prove its epoch.
      const previousComparison=scoped?null:previousState?.comparison;
      const comparisonCapacityUsd=previousComparison?.startedAtMs===comparisonFrom&&previousComparison.planType===plan
        ?previousComparison.capacityUsd:null;
      const savedBaseline=previousComparison?.startedAtMs===comparisonFrom&&previousComparison.planType===plan
        &&validBaseline(previousComparison.baseline)?previousComparison.baseline:null;
      const comparisonBaseline=savedBaseline?{...savedBaseline,
        resetKey:`${savedBaseline.resetAtMs}:${savedBaseline.planType}:${savedBaseline.limitId}`}:null;
      stage="aggregation";
      const state=analyzeWorkload({nowMs,events,usage,quota,estimationPlanType:plan,capacity:cap,capacityHistory:validHistory,liveSinceMs:comparisonFrom,sourceFresh,timeZone,
        usageCoverageFromMs:evidenceFrom,quotaResetEvents:scoped
          ?(context?.scopedResetEvents??[]).filter(x=>x.token===accountScopeToken).map(x=>x.event)
          :quotaEvidence?.historyResetEvents??quotaEvidence?.resetEvents??[],
        comparisonCapacityUsd,comparisonBaseline,comparisonAccountKey:scoped?quota.at(-1)?.accountKey??null:null,
        comparisonQuota:scoped?quota:quotaEvidence?.observations??[],comparisonResetEvents:scoped
          ?(context?.scopedResetEvents??[]).filter(x=>x.token===accountScopeToken).map(x=>x.event):quotaEvidence?.resetEvents??[],
        comparisonContinuityThroughMs:scoped?null:quotaEvidence?.continuityThroughMs??null,
        comparisonEvidenceError:quotaEvidence?.errorCode??null});
      let capture;
      try{capture=readRuntimeModelEvidenceStatus(database);}catch{capture={status:'failed',errorCode:'runtime_evidence_checkpoint_invalid'};}
      if(capture.errorCode){state.errors.push({code:capture.errorCode,stage:'index'});state.status='partial';}
      state.pricingDetails={total:pricingIssueCount,records:pricingRecords,truncated:pricingIssueCount>pricingRecords.length,capture};
      if(quotaEvidence?.errorCode&&previous?.comparison?.startedAtMs===comparisonFrom
        &&previous.comparison.planType===plan&&previous.comparison.capacityUsd===state.comparison.capacityUsd){
        for(const key of ["actualPp","expectedPp"]){const known=previous.comparison[key];
          if(Number.isFinite(known)&&known>=0)state.comparison[key]=Math.max(known,state.comparison[key]??0);
        }
        state.comparison.inferred ||= previous.comparison.inferred===true;
        state.comparison.coverage="partial";
      }
      state.comparison.planType=plan;
      const malformed=Number(database.prepare("SELECT COALESCE(SUM(count),0) AS n FROM source_diagnostic WHERE code='malformedWorkRecords'").get().n);
      if(malformed>0){state.errors.push({code:"work_record_unsupported",stage:"work",count:malformed});state.status="partial";}
      state.sourceGeneration=commitSeq;
      state.capacityHistory=retainedHistory;
      return state;
    });
  } catch(error) {
    if(signal?.aborted)throw error;
    const value=failure(error?.code,previous,nowMs,liveQuota,stage);
    const newest=liveQuota.filter(q=>q.atMs<=nowMs).at(-1);
    if(newest&&(!previous?.allowance?.observedAt||newest.atMs>Date.parse(previous.allowance.observedAt))) {
      value.allowance={...value.allowance,remainingPercent:100-newest.usedPercent,observedAt:new Date(newest.atMs).toISOString()};
    }
    return value;
  }
  finally { database?.close(); }
}
