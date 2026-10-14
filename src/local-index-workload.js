import { analyzeWorkload, WORKLOAD_POLICY } from "@app-usagemonitor/quota-analysis";
import { quotaWeightedApiPriceEquivalent } from "@app-usagemonitor/accounting";
import { openLocalIndexStore, withReadSnapshot } from "./local-index-store.js";
import { committedPredicate } from "./local-index-rollup.js";
import { usageProjection } from "./local-companion-usage-model.js";
import { createAccountingPricer } from "./replay-safe-accounting-cache.js";
import { createWindowsProtectedStateStore, createWindowsFilesystemAdapter } from "./platform/index.js";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { declaredSpeedModeAt } from "./codex-speed-baseline.js";
import { codexPrimaryAllowanceBasis } from "./codex-primary-allowance-basis.js";

const STATE_SCHEMA="overview-workload-state-v1";
function validState(s){
  if(!s||Object.keys(s).some(k=>!["schemaVersion","comparison","capacityHistory"].includes(k))||s.schemaVersion!==STATE_SCHEMA)return false;
  if(!s.comparison||Object.keys(s.comparison).join()!=="anchorMs"||!Number.isSafeInteger(s.comparison.anchorMs)||s.comparison.anchorMs<0)return false;
  return Array.isArray(s.capacityHistory)&&s.capacityHistory.length<=4096&&s.capacityHistory.every(c=>c
    &&Object.keys(c).length===5&&["usd","availableAtMs","planType","version","basisId"].every(k=>Object.hasOwn(c,k))
    &&Number.isFinite(c.usd)&&c.usd>0&&Number.isSafeInteger(c.availableAtMs)&&c.availableAtMs>=0
    &&(c.planType===null||/^[a-z0-9_]{1,64}$/u.test(c.planType))
    &&/^[a-f0-9]{64}$/u.test(c.version)
    &&c.basisId===codexPrimaryAllowanceBasis("unresolved_as_standard").basisId);
}
export function workloadStateStore(indexFile){
  const root=join(dirname(indexFile),"private"),name="overview-workload-state.json",file=join(root,name);
  let backend=null;
  const store=()=>backend??=createWindowsProtectedStateStore({rootPath:root,adapter:createWindowsFilesystemAdapter()});
  return {
    async read(){if(!existsSync(file))return null;const result=store().readJson(name);
      if(!validState(result.value))throw Object.assign(new Error("workload_state_invalid"),{code:"workload_state_invalid"});return result.value;},
    async write(value){if(!validState(value))throw Object.assign(new Error("workload_state_invalid"),{code:"workload_state_invalid"});
      const b=store();b.ensureProtectedDirectory();
      if(existsSync(file)){const previous=b.read(name);b.replaceJson(name,previous.identity,value);}else b.createJson(name,value);
      return true;},
  };
}
export function workloadState(result){return{schemaVersion:STATE_SCHEMA,
  comparison:{anchorMs:result.comparison.anchorMs},capacityHistory:result.capacityHistory};}

const SAFE_ERRORS = new Set(["local_index_newer_version", "local_index_family_mismatch",
  "local_index_unavailable", "price_missing", "numeric_invalid"]);
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
      resetKey:`${Date.parse(q.resetAt??q.resetsAt)}:${q.planType??"unknown"}:codex`,
    })).filter(q=>Number.isFinite(q.atMs)&&Number.isFinite(q.usedPercent)&&!q.resetKey.startsWith("NaN:"));
}

/** Read only committed content-free facts. A failure never erases last-good analytics. */
export function readLocalIndexWorkload({ indexFile, nowMs, quotaWindows = [], capacity = null,
  previous = null, storedState = null, liveSinceMs = nowMs, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  sourceFresh = false, declaredSpeedBaselines = [] } = {}) {
  let database,stage="index";
  const liveQuota=liveWeeklyQuota(quotaWindows);
  try {
    database = openLocalIndexStore(indexFile,{readOnly:true});
    return withReadSnapshot(database,({commitSeq})=>{
      const from = Math.max(0,nowMs-WORKLOAD_POLICY.historyMs);
      const current = quotaWindows.filter((q)=>Number(q.windowMinutes ?? q.windowDurationMinutes ?? q.durationMinutes)===10080
        && (q.limitId===undefined || q.limitId===null || q.limitId==="codex"))
        .sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0];
      const plan = current?.planType && current.planType!=="unknown" ? current.planType : capacity?.planScope?.planType ?? null;
      const quota = database.prepare(`SELECT DISTINCT q.observed_at_ms, q.used_percent, q.resets_at_ms, q.plan_type, q.limit_id
        FROM quota_occurrence q WHERE q.duration_mins=10080 AND q.admission='admitted'
        AND q.observed_at_ms>=? AND q.observed_at_ms<=? AND q.limit_id='codex' AND ${committedPredicate("q")}
        ORDER BY q.observed_at_ms`).all(from,nowMs)
        .filter((q)=>plan===null || q.plan_type===null || q.plan_type==="unknown" || q.plan_type===plan)
        .map((q)=>({atMs:q.observed_at_ms,usedPercent:q.used_percent,
          resetKey:`${q.resets_at_ms}:${q.plan_type&&q.plan_type!=="unknown"?q.plan_type:plan??"unknown"}:codex`}));
      if (current) {
        const atMs=Date.parse(current.observedAt), resetAtMs=Date.parse(current.resetAt ?? current.resetsAt);
        const usedPercent=Number.isFinite(current.usedPercent)?current.usedPercent:100-current.remainingPercent;
        if(Number.isFinite(atMs)&&Number.isFinite(resetAtMs)&&Number.isFinite(usedPercent)) quota.push({atMs,usedPercent,resetKey:`${resetAtMs}:${current.planType??plan??"unknown"}:codex`});
      }
      const pricer=createAccountingPricer();
      const usage=[];
      for(const r of database.prepare(`SELECT u.*,m.model_id,t.codex_speed_mode,t.api_service_tier
        FROM usage_event u JOIN model m ON m.id=u.model_id JOIN tier_semantics t ON t.id=u.tier_id
        WHERE u.observed_at_ms>=? AND u.observed_at_ms<=? AND ${committedPredicate("u")}
        ORDER BY u.observed_at_ms,u.source_id,u.source_offset`).iterate(from,nowMs)) {
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
        usage.push({atMs:r.observed_at_ms,session:String(r.session_id),usd:weighted.usd,
          priced:p.pricingCoverageStatus==="fully_priced"&&Number.isFinite(weighted.usd)});
      }
      const events=database.prepare(`SELECT w.* FROM work_lifecycle_fact w
        WHERE w.observed_at_ms>=? AND w.observed_at_ms<=? AND ${committedPredicate("w")}
        ORDER BY w.observed_at_ms,w.source_id,w.source_offset`).all(from-24*3600000,nowMs)
        .map((e)=>({key:Buffer.from(e.task_key).toString("hex"),session:String(e.session_id),
          kind:e.kind,atMs:e.observed_at_ms,durationMs:e.duration_ms}));
      const selected=capacity?.status==="available"&&capacity.planScope?.planType===plan?capacity.scenarios?.[capacity.selectedScenario]:null;
      const previousState=previous??storedState;
      const previousCapacity=previousState?.capacityHistory?.filter((c)=>c.planType===plan
        &&validState({schemaVersion:STATE_SCHEMA,comparison:{anchorMs:0},capacityHistory:[c]}))??[];
      const history=[...previousCapacity];
      if(selected && Number.isFinite(selected.medianCapacityUsd)) {
        const last=history.at(-1);
        if(!last||last.usd!==selected.medianCapacityUsd||last.version!==selected.cohortId)
          history.push({usd:selected.medianCapacityUsd,availableAtMs:Math.min(nowMs,Date.parse(capacity.computedAt)||nowMs),planType:plan,version:selected.cohortId,basisId:selected.basisId});
      }
      history.sort((a,b)=>a.availableAtMs-b.availableAtMs);
      const before=history.filter(x=>x.availableAtMs<from).at(-1);
      const validHistory=[...(before?[before]:[]),...history.filter(x=>x.availableAtMs>=from)];
      const cap=validHistory.at(-1)??null;
      stage="aggregation";
      const state=analyzeWorkload({nowMs,events,usage,quota,capacity:cap,capacityHistory:validHistory,liveSinceMs,sourceFresh,timeZone,
        comparisonAnchorMs:previousState?.comparison?.anchorMs});
      const malformed=Number(database.prepare("SELECT COALESCE(SUM(count),0) AS n FROM source_diagnostic WHERE code='malformedWorkRecords'").get().n);
      if(malformed>0){state.errors.push({code:"work_record_unsupported",stage:"work",count:malformed});state.status="partial";}
      state.sourceGeneration=commitSeq;
      state.capacityHistory=validHistory;
      return state;
    });
  } catch(error) {
    const value=failure(error?.code,previous,nowMs,liveQuota,stage);
    const newest=liveQuota.filter(q=>q.atMs<=nowMs).at(-1);
    if(newest&&(!previous?.allowance?.observedAt||newest.atMs>Date.parse(previous.allowance.observedAt))) {
      value.allowance={...value.allowance,remainingPercent:100-newest.usedPercent,observedAt:new Date(newest.atMs).toISOString()};
    }
    return value;
  }
  finally { database?.close(); }
}
