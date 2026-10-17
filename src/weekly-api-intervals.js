import { addUsdStrings } from "@app-usagemonitor/accounting";
import { classifyQuotaResetTimeline, classifyUsageAttribution, planEraForInterval,
  planAttributionContextKey, QUOTA_RESET_CLASSIFICATION_POLICY } from "@app-usagemonitor/quota-analysis";

export const WEEKLY_API_INTERVAL_VERSION = "weekly-api-interval-v1";
const contextKey = planAttributionContextKey("openai_codex", "codex");
const MAX_ROWS = 100_000;
// Owner-supplied announcement, 2026-10-07 05:56 JST. Earlier records remain
// ordinary historical usage; this policy only affects this derived numerator.
const FREE_APPROVAL_REVIEW_FROM_MS = Date.parse("2026-10-06T20:56:00.000Z");
const REASONS = new Set([null, "reset_boundary", "quota_conflict", "plan_conflict", "missing_usage",
  "unpriced", "usage_attribution_unresolved", "review_origin_unresolved", "pricing_change", "awaiting_change"]);
const KEYS = ["startMs", "endMs", "planType", "segment", "quotaPp", "apiUsd", "weeklyUsd", "reason",
  "usageEvents", "unknownSpeedEvents", "excludedReviewEvents", "excludedReviewUsd", "priceCardIds"];
const fail = code => Object.assign(new Error(code), { code });
export function unavailableWeeklyApiIntervals(reason = "weekly_api_intervals_unavailable") {
  return { schemaVersion: WEEKLY_API_INTERVAL_VERSION, status: "unavailable", reason,
    generatedAt: null, sourceGeneration: null, sourceFingerprint: null, rows: [] };
}

// A bounded, read-only projection of already committed, deduplicated facts.
// Quota plateaus retain their ORIGINAL anchor. Usage belongs to (start,end].
export async function buildWeeklyApiIntervals({ corpus, endMs, generation, fingerprint, signal }) {
  const index = corpus.planAttribution.index;
  const readings = new Map();
  for (const q of corpus.weeklyRateLimitSnapshots) {
    if (q[2] !== "openai_codex" || q[4] !== "codex" || q[6] !== 10080 || q[1] > endMs
        || q[3] === "unknown") continue;
    if (!Number.isSafeInteger(q[1]) || !Number.isFinite(q[7]) || !Number.isFinite(q[8])
        || q[8] < 0 || q[8] > 100) throw fail("weekly_api_quota_invalid");
    const key = `${q[3]}:${q[1]}`;
    const previous = readings.get(key);
    if (previous && (Math.abs(previous.reset-q[7]*1000)>QUOTA_RESET_CLASSIFICATION_POLICY.resetScheduleJitterMs
        || previous.used !== q[8])) { previous.conflict = true;previous.used=Math.max(previous.used,q[8]); }
    else if (!previous) readings.set(key, { at: q[1], reset: q[7] * 1000, used: q[8], plan: q[3], conflict: false });
  }
  if (readings.size > MAX_ROWS) throw fail("weekly_api_resource_limit");
  const ordered = [...readings.values()].sort((a,b) => a.at-b.at || a.plan.localeCompare(b.plan));
  const resetEvents = classifyQuotaResetTimeline(ordered.map(q => ({
    observedAt: new Date(q.at).toISOString(), windows: [{ provider: "openai_codex", limitId: "codex",
      planType: q.plan, windowDurationMins: 10080, resetsAt: Math.floor(q.reset/1000), usedPercent: q.used }],
  })));
  const resetByPlan=new Map(),resetCursor=new Map();
  for(const e of resetEvents){const list=resetByPlan.get(e.planType)??[];list.push(Date.parse(e.observedAt));resetByPlan.set(e.planType,list);}
  for(const list of resetByPlan.values())list.sort((a,b)=>a-b);
  const rows = [], anchors = new Map(); let segment = 0;
  for (const q of ordered) {
    signal?.throwIfAborted();
    const a = anchors.get(q.plan);
    if (!a) { anchors.set(q.plan, q); continue; }
    const era = planEraForInterval(index, { contextKey, intervalStartMs: a.at, observedAtMs: q.at });
    const events=resetByPlan.get(q.plan)??[];let cursor=resetCursor.get(q.plan)??0,reset=false;
    while(cursor<events.length&&events[cursor]<=q.at){if(events[cursor]>a.at)reset=true;cursor++;}
    resetCursor.set(q.plan,cursor);
    const scheduleChanged = Math.abs(q.reset-a.reset) > QUOTA_RESET_CLASSIFICATION_POLICY.resetScheduleJitterMs;
    const changedEra=era.status!=="matched"||era.era.planType!==q.plan;
    let reason = changedEra ? "plan_conflict" : reset||scheduleChanged ? "reset_boundary"
      : q.conflict||a.conflict||a.tainted ? "quota_conflict" : null;
    // Interleaved sessions can repeat an older integer reading. Only reset
    // evidence may lower the confirmed cycle baseline; counting its rebound
    // as another deduction would count the same quota twice. Retain the
    // original anchor and all usage until the next NEW high-water reading.
    if(!changedEra&&!reset&&!scheduleChanged&&q.used<=a.used){
      if(q.conflict)a.tainted=true;
      continue;
    }
    rows.push({ startMs:a.at, endMs:q.at, planType:q.plan, segment,
      quotaPp:reason ? null : q.used-a.used, apiUsd:"0", weeklyUsd:null, reason,
      usageEvents:0, unknownSpeedEvents:0, excludedReviewEvents:0, excludedReviewUsd:"0", priceCardIds:[] });
    if (reason) segment++;
    anchors.set(q.plan, q);
    if (rows.length > MAX_ROWS) throw fail("weekly_api_resource_limit");
  }
  // A trailing unchanged reading is explicitly pending, never a zero capacity.
  for (const [plan,a] of anchors) {
    const last = ordered.filter(q => q.plan === plan).at(-1);
    if (last?.at > a.at) rows.push({startMs:a.at,endMs:last.at,planType:plan,segment:++segment,
      quotaPp:null,apiUsd:"0",weeklyUsd:null,reason:last.used<a.used?"quota_conflict":"awaiting_change",usageEvents:0,
      unknownSpeedEvents:0,excludedReviewEvents:0,excludedReviewUsd:"0",priceCardIds:[]});
  }
  rows.sort((a,b)=>a.startMs-b.startMs || a.planType.localeCompare(b.planType));
  const byPlan = new Map();
  const accounts=new Map();
  const priceBases=new Map();
  for (const row of rows) { const list=byPlan.get(row.planType) ?? []; list.push(row); byPlan.set(row.planType,list); }
  const atInterval = (list, at) => {
    let lo=0,hi=list.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(list[mid].endMs<at)lo=mid+1;else hi=mid;}
    const row=list[lo]; return row && at>row.startMs && at<=row.endMs ? row : null;
  };
  await corpus.forEachRetainedUsage(event => {
    signal?.throwIfAborted();
    const at=Date.parse(event[0]); if(at>endMs)return;
    for (const [plan,list] of byPlan) {
      const row=atInterval(list,at); if(!row)continue;
      const info=event.weeklyApiOrigin;
      const usd=info?.apiUsd??event[11],coverage=info?.apiCoverage??event[12];
      const review=at>=FREE_APPROVAL_REVIEW_FROM_MS
        && (info?.autoReview === true || event[1] === "codex-auto-review");
      if(review){row.excludedReviewEvents++;row.excludedReviewUsd=coverage==='fully_priced'&&row.excludedReviewUsd!==null
        ?addUsdStrings(row.excludedReviewUsd,usd):null;continue;}
      if(at>=FREE_APPROVAL_REVIEW_FROM_MS&&info?.originKnown===false)row.reason??="review_origin_unresolved";
      const association=classifyUsageAttribution(index,{contextKey,observedAtMs:at,
        ...(event[20]?.[2] ? {intervalStartMs:Date.parse(event[20][2])}:{}),
        observedPlanType:event[20]?.[0]==="same_record"?event[20][1]:null},{planType:plan});
      if(association.disposition==="incompatible")continue;
      if(event[20]?.[0]==="conflicted" || association.disposition==="unresolved"
          || event.weeklyApiOrigin?.accountConflicted) row.reason ??= "usage_attribution_unresolved";
      row.usageEvents++;
      const account=event.weeklyApiOrigin?.accountScope;
      if(account!=null){const prior=accounts.get(row);if(prior!==undefined&&prior!==account)row.reason??="usage_attribution_unresolved";accounts.set(row,account);}
      if(info?.unknownSpeed??(event[9]==="unknown"&&event[14]!==event[15]))row.unknownSpeedEvents++;
      if(coverage!=="fully_priced")row.reason ??= "unpriced";
      if(typeof usd!=='string'||!Number.isFinite(Number(usd))||Number(usd)<0)throw fail("weekly_api_pricing_invalid");
      row.apiUsd=addUsdStrings(row.apiUsd,usd);
      const cards=info?.priceCardIds??event[18]??[];
      const bases=priceBases.get(row)??new Map();
      // Context bands and speed tariffs legitimately coexist in one interval.
      // Only a revision of the SAME tariff family is a price-epoch boundary.
      for(const card of cards){
        const family=card.replace(/-from-\d{4}-\d{2}-\d{2}.*$/u,'');
        if(bases.has(family)&&bases.get(family)!==card)row.reason??="pricing_change";
        bases.set(family,card);
      }
      priceBases.set(row,bases);
      for(const card of cards){if(!row.priceCardIds.includes(card))row.priceCardIds.push(card);}
      if(row.priceCardIds.length>256)throw fail("weekly_api_resource_limit");
    }
  });
  let previous = new Map(); segment=0;
  for(const row of rows){
    if(!row.reason && row.usageEvents===0)row.reason="missing_usage";
    row.priceCardIds.sort();
    // Different model mixes can have different cards without changing the price
    // basis. Era/reset/refused intervals, not model identity, split continuity.
    const p=previous.get(row.planType);
    const sameAccount=!p||accounts.get(p)==null||accounts.get(row)==null||accounts.get(p)===accounts.get(row);
    const samePricing=!p||[...(priceBases.get(row)??[])].every(([model,basis])=>!priceBases.get(p)?.has(model)||priceBases.get(p).get(model)===basis);
    if(!p || p.endMs!==row.startMs || p.reason || row.reason || !sameAccount || !samePricing)segment++;
    row.segment=p&&p.endMs===row.startMs&&!p.reason&&!row.reason&&sameAccount&&samePricing?p.segment:segment;
    if(!row.reason)row.weeklyUsd=Number(row.apiUsd)/(row.quotaPp/100);
    previous.set(row.planType,row);
  }
  const result={schemaVersion:WEEKLY_API_INTERVAL_VERSION,status:"available",reason:null,
    generatedAt:new Date(endMs).toISOString(),sourceGeneration:String(generation),sourceFingerprint:fingerprint,rows};
  if(!validWeeklyApiIntervals(result))throw fail("weekly_api_projection_invalid");
  if(Buffer.byteLength(JSON.stringify(result))>8*1024*1024)throw fail("weekly_api_resource_limit");
  return result;
}

export function validWeeklyApiIntervals(value) {
  if(!value || Object.keys(value).sort().join()!==["schemaVersion","status","reason","generatedAt","sourceGeneration","sourceFingerprint","rows"].sort().join()
    || value.schemaVersion!==WEEKLY_API_INTERVAL_VERSION || !Array.isArray(value.rows)||value.rows.length>MAX_ROWS)return false;
  if(value.status==="unavailable")return typeof value.reason==="string" && /^weekly_api_[a-z_]{1,64}$/.test(value.reason)
    && value.generatedAt===null&&value.sourceGeneration===null&&value.sourceFingerprint===null&&value.rows.length===0;
  if(value.status!=="available"||value.reason!==null || typeof value.generatedAt!=="string"
    || !Number.isFinite(Date.parse(value.generatedAt))||new Date(value.generatedAt).toISOString()!==value.generatedAt
    || typeof value.sourceGeneration!=="string"|| !/^[1-9][0-9]{0,19}$/.test(value.sourceGeneration)
    || typeof value.sourceFingerprint!=="string"|| !/^generation-v2-[a-f0-9]{64}$/.test(value.sourceFingerprint))return false;
  const ends=new Map();let last=-Infinity;
  for(const r of value.rows){
    if(Object.keys(r).sort().join()!==[...KEYS].sort().join() || !Number.isSafeInteger(r.startMs)||!Number.isSafeInteger(r.endMs)
      || r.startMs<last||r.endMs<=r.startMs||r.endMs>Date.parse(value.generatedAt)
      || !Number.isFinite(new Date(r.startMs).getTime())||!Number.isFinite(new Date(r.endMs).getTime())
      || !(r.quotaPp===null||(Number.isFinite(r.quotaPp)&&r.quotaPp>=0&&r.quotaPp<=100))
      || typeof r.planType!=="string"|| !/^[a-z][a-z0-9_]{0,63}$/.test(r.planType)||r.planType==="unknown"
      || r.startMs<(ends.get(r.planType)??-Infinity)|| !REASONS.has(r.reason)
      || ![r.segment,r.usageEvents,r.unknownSpeedEvents,r.excludedReviewEvents].every(n=>Number.isSafeInteger(n)&&n>=0)
      || r.unknownSpeedEvents>r.usageEvents
      || ![r.apiUsd,...(r.excludedReviewUsd===null?[]:[r.excludedReviewUsd])].every(n=>typeof n==="string"&&/^\d+(?:\.\d{1,20})?$/.test(n)&&Number.isFinite(Number(n)))
      || !Array.isArray(r.priceCardIds)||r.priceCardIds.length>256||!r.priceCardIds.every(s=>typeof s==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(s))
      || (r.reason===null ? !(Number.isFinite(r.quotaPp)&&r.quotaPp>0&&r.quotaPp<=100&&Number.isFinite(r.weeklyUsd)&&r.weeklyUsd>=0
        && Math.abs(r.weeklyUsd-Number(r.apiUsd)/(r.quotaPp/100))<=1e-10*Math.max(1,r.weeklyUsd)) : r.weeklyUsd!==null))return false;
    ends.set(r.planType,r.endMs);last=r.startMs;
  }
  return true;
}
