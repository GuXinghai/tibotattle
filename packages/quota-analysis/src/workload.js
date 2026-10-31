import { normalizeQuotaResetEvent } from "./reset-events.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const WORKLOAD_POLICY = Object.freeze({
  version: "task-workload-v15", bucketMs: 5 * MINUTE, historyMs: 168 * HOUR,
  // currentMs retains the historical unresolved-task lookback; recent display
  // windows must not change task-boundary detection when their lengths change.
  currentMs: 15 * MINUTE, shortTermMs: 15 * MINUTE, trendMs: 60 * MINUTE,
  minimumBins: 9, minimumClassBins: 3, minimumClassMs: MINUTE,
  comparisonWindowMs: 168 * HOUR,
  comparisonDeadlineUncertaintyMs: 5 * MINUTE,
});
const LEVELS = ["light", "medium", "heavy"];
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const iso = (ms) => new Date(ms).toISOString();
const hours = (ms) => ms / HOUR;
// Receipts at a bucket's closing timestamp belong to that completed bucket.
const receiptBucket = (atMs) => Math.floor((atMs - 1) / WORKLOAD_POLICY.bucketMs) * WORKLOAD_POLICY.bucketMs;
const ratioHours = (remaining, rate) => finite(remaining) && finite(rate) && rate > 0 ? remaining / rate : null;

export function unionWorkIntervals(intervals, fromMs, toMs) {
  const ordered = intervals.map(({ startMs, endMs }) => ({
    startMs: Math.max(fromMs, startMs), endMs: Math.min(toMs, endMs),
  })).filter((x) => finite(x.startMs) && finite(x.endMs) && x.endMs > x.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const result = [];
  for (const x of ordered) {
    const last = result.at(-1);
    if (last && x.startMs <= last.endMs) last.endMs = Math.max(last.endMs, x.endMs);
    else result.push({ ...x });
  }
  return result;
}
const lengthMs = (intervals, from, to) => unionWorkIntervals(intervals, from, to)
  .reduce((sum, x) => sum + x.endMs - x.startMs, 0);

const taskTerminal=e=>e.kind==='complete'||e.kind==='abort';
// A complete, one-way lineage proof is shared by replay, branch cancellation
// and continuation. Reciprocal/self ancestry and incomplete chains prove nothing.
function taskDescendant(e,ancestor){
  return e.session!==ancestor.session&&e.ancestors?.includes(ancestor.session)
    &&!e.ancestors.includes(e.session)&&!ancestor.ancestors?.includes(e.session)
    &&(ancestor.ancestors??[]).every(session=>e.ancestors.includes(session));
}
function ownedTaskBoundaries(candidates){
  let replayed=0;
  const owned=candidates.filter(e=>{
    const copied=candidates.some(a=>taskDescendant(e,a)&&a.kind===e.kind
      &&(e.kind!=='complete'||a.durationMs===e.durationMs));
    if(copied)replayed++;
    return !copied;
  });
  const sessions=new Map();
  for(const e of owned){const rows=sessions.get(e.session)??[];rows.push(e);sessions.set(e.session,rows);}
  const completed=[];
  for(const rows of sessions.values()){
    const starts=rows.filter(e=>e.kind==='start'),ends=rows.filter(taskTerminal);
    if(starts.length===1&&ends.length===1&&ends[0].kind==='complete'&&ends[0].atMs>=starts[0].atMs)
      completed.push(starts[0]);
  }
  // Fork cleanup is a real event in its own branch, not a second ending of an
  // independently completed ancestor. Keep it in stored facts, not its timing.
  // Without that complete ancestor pair, continuation/conflict rules still apply.
  return {replayed,events:owned.filter(e=>e.kind!=='abort'
    ||!completed.some(start=>taskDescendant(e,start)&&e.atMs>=start.atMs))};
}

export function taskWorkIntervals(events, { nowMs, liveSinceMs = nowMs, sourceFresh = false, usage = [] }) {
  const groups = new Map();
  const usageBySession = new Map();
  for (const u of usage) { const list=usageBySession.get(u.session)??[];list.push(u);usageBySession.set(u.session,list); }
  for (const list of usageBySession.values()) list.sort((a,b)=>a.atMs-b.atMs);
  for (const e of events) {
    if (!finite(e.atMs) || e.atMs > nowMs || typeof e.key !== "string") continue;
    const group = groups.get(e.key) ?? [];
    if (!group.some((x) => x.session === e.session && x.kind === e.kind && x.atMs === e.atMs && x.durationMs === e.durationMs)) group.push(e);
    groups.set(e.key, group);
  }
  let replayed = 0;
  const taskGroups=[];
  for (const candidates of groups.values()) {
    const owned=ownedTaskBoundaries(candidates);replayed+=owned.replayed;
    // Same-session duplicates were removed above. Equal timestamps in two
    // unrelated sessions do not prove replay or shared task ownership.
    const group=owned.events.toSorted((a, b) => a.atMs - b.atMs);
    taskGroups.push(group);
  }
  const startsBySession = new Map();
  for (const group of taskGroups) for (const e of group) if (e.kind === "start") {
    const list = startsBySession.get(e.session) ?? [];
    list.push({ key:e.key, atMs: e.atMs }); startsBySession.set(e.session, list);
  }
  for (const list of startsBySession.values()) list.sort((a,b)=>a.atMs-b.atMs);
  function nextContext(begin) {
    const list = startsBySession.get(begin.session) ?? [];
    let lo=0,hi=list.length;
    while(lo<hi){const mid=(lo+hi)>>1;if(list[mid].atMs<=begin.atMs)lo=mid+1;else hi=mid;}
    while(lo<list.length&&list[lo].key===begin.key)lo++;
    return list[lo]?.atMs ?? null;
  }
  const intervals = [], incomplete = [], openWindows = [];
  let active = 0, unresolved = 0, conflicts = 0, durationDifferences = 0;
  for (const group of taskGroups) {
    const starts = group.filter((x) => x.kind === "start");
    const ends = group.filter(taskTerminal);
    if (starts.length > 1 || ends.length > 1) {
      conflicts++;
      // An ambiguous task must not silently leave a quota numerator paired
      // with only the other, known tasks' time denominator.
      const startMs=group.reduce((min,e)=>Math.min(min,e.atMs,finite(e.durationMs)?e.atMs-e.durationMs:e.atMs),nowMs);
      const endMs=ends.length?group.reduce((max,e)=>Math.max(max,e.atMs),0):nowMs;
      incomplete.push({startMs:Math.max(0,startMs),endMs});
      continue;
    }
    const begin = starts[0], end = ends[0];
    if (end) {
      if(begin && begin.session!==end.session && !taskDescendant(end,begin)){
        conflicts++;
        incomplete.push({startMs:Math.min(begin.atMs,end.atMs),endMs:Math.max(begin.atMs,end.atMs)});
        continue;
      }
      const startMs = begin?.atMs ?? (finite(end.durationMs) ? end.atMs - end.durationMs : null);
      if (!finite(startMs) || startMs < 0 || end.atMs < startMs) {
        conflicts++; continue;
      }
      // Work is the observed task interval, including tools and waiting.
      // A separate elapsed timer is diagnostic evidence, not a veto on work.
      if (begin && finite(end.durationMs) && Math.abs(end.atMs - startMs - end.durationMs) > 2000) durationDifferences++;
      intervals.push({ startMs, endMs: end.atMs });
      continue;
    }
    if (!begin) continue;
    const next = nextContext(begin), contextEnd = next ?? nowMs;
    const activity = (usageBySession.get(begin.session)??[]).filter((u) => u.atMs >= begin.atMs
      && (next === null ? u.atMs <= contextEnd : u.atMs < contextEnd));
    if (sourceFresh && begin.atMs >= liveSinceMs && next === null) {
      intervals.push({ startMs: begin.atMs, endMs: nowMs }); active++;
    } else {
      // A receipt is neither a task terminal nor proof of continuous work.
      // A later task context bounds which observations could belong here; it
      // does NOT establish an inferred completion at that context's start.
      // Keep this window uncertain, rather than extending an orphan through
      // later independent tasks or inventing an inactivity timeout.
      openWindows.push({ startMs: begin.atMs, endMs: contextEnd });
      const last = activity.at(-1)?.atMs ?? begin.atMs;
      if (next === null && last >= nowMs - WORKLOAD_POLICY.currentMs) unresolved++;
    }
  }
  // Definite parallel work can qualify the union's timing even when an
  // orphan's ending is unknown. Explicitly conflicting lifecycle records
  // remain fail-closed; they are not repaired by another task's coverage.
  incomplete.push(...uncertainWorkIntervals(openWindows,unionWorkIntervals(intervals,0,nowMs),nowMs));
  return { intervals, incomplete, active, unresolved, conflicts, replayed, durationDifferences };
}

// Exact weighted 1-D three-means; O(3*n*n), O(3*n) memory, no random seed.
function fitWorkload(bins) {
  const rows = bins.filter((b) => b.complete !== false && finite(b.workMs) && b.workMs > 0 && b.priced && finite(b.usd) && b.usd >= 0)
    .map((b) => ({ ...b, x: b.usd / hours(b.workMs) }))
    .filter(b=>finite(b.x))
    .sort((a, b) => a.x - b.x || a.atMs - b.atMs || a.workMs-b.workMs);
  if (rows.length < WORKLOAD_POLICY.minimumBins) return null;
  // Equal intensities are atomic: sample-count constraints must never split
  // the same value across different colors just to manufacture three groups.
  const values=[];
  for(const row of rows){let value=values.at(-1);
    if(!value||value.x!==row.x){value={x:row.x,workMs:0,count:0};values.push(value);}
    value.workMs+=row.workMs;value.count++;
  }
  const n=values.length;
  if(n<3)return null;
  const w = new Float64Array(n + 1), s = new Float64Array(n + 1), q = new Float64Array(n + 1);
  const counts = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    w[i + 1] = w[i] + values[i].workMs;
    s[i + 1] = s[i] + values[i].workMs * values[i].x;
    q[i + 1] = q[i] + values[i].workMs * values[i].x ** 2;
    counts[i+1]=counts[i]+values[i].count;
  }
  let prev = new Float64Array(n + 1).fill(Infinity); prev[0] = 0;
  const splits = [];
  for (let k = 1; k <= 3; k++) {
    const next = new Float64Array(n + 1).fill(Infinity), split = new Int32Array(n + 1).fill(-1);
    for (let i = k; i <= n; i++) {
      for (let j = k - 1; j < i; j++) {
        const weight = w[i] - w[j];
        if (!finite(prev[j]) || weight < WORKLOAD_POLICY.minimumClassMs
          || counts[i]-counts[j]<WORKLOAD_POLICY.minimumClassBins) continue;
        const score = prev[j] + Math.max(0, q[i] - q[j] - (s[i] - s[j]) ** 2 / weight);
        if (score < next[i]) { next[i] = score; split[i] = j; }
      }
    }
    splits.push(split); prev = next;
  }
  if (!finite(prev[n])) return null;
  const centers = [], thresholds = [];
  let stop = n;
  for (let k = 2; k >= 0; k--) {
    const start = splits[k][stop];
    if(start>0){const left=values[start-1].x,right=values[start].x,mid=left+(right-left)/2;
      // x < cut belongs to the lower partition. Fall back to the upper value
      // when adjacent floating-point values cannot represent their midpoint.
      thresholds.unshift(mid>left?mid:right);
    }
    centers.unshift((s[stop] - s[start]) / (w[stop] - w[start])); stop = start;
  }
  if (!centers.every(finite) || !(centers[0] < centers[1] && centers[1] < centers[2])) return null;
  return {centers,thresholds};
}
export function clusterWorkload(bins) { return fitWorkload(bins)?.centers ?? null; }
function classify(x, model) {
  if (!model || !finite(x) || x < 0) return "unclassified";
  // Use the fitted cuts for both training bins and current load. Nearest-mean
  // reassignment would undo the fitted minimum-size/time constraints.
  return LEVELS[x<model.thresholds[0]?0:x<model.thresholds[1]?1:2];
}

function uncertainWorkIntervals(incomplete, intervals, nowMs) {
  // Parallel work is a union, not a sum. Where a proven task already covers
  // an uncertain task, its timing cannot change the wall-time denominator.
  const result=[];let i=0;
  for(const window of unionWorkIntervals(incomplete,0,nowMs)){
    let from=window.startMs;
    while(i<intervals.length&&intervals[i].endMs<=from)i++;
    for(let j=i;j<intervals.length&&intervals[j].startMs<window.endMs;j++){
      const known=intervals[j];
      if(known.startMs>from)result.push({startMs:from,endMs:Math.min(known.startMs,window.endMs)});
      from=Math.max(from,known.endMs);if(from>=window.endMs)break;
    }
    if(from<window.endMs)result.push({startMs:from,endMs:window.endMs});
  }
  return result;
}
function dateKey(atMs, formatter) {
  const parts = formatter.formatToParts(atMs);
  const part = (key) => parts.find((x) => x.type === key).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// Owner-approved display/estimate assumption, never a correction of source facts.
// Only preceding explicit observations anchor a period. Conflicting labels or
// an explicit identity change break continuity; nothing backfills the first era.
function workloadPlanPeriods(quota) {
  const ordered=quota.map(q=>({...q,sourcePlanType:q.planType})).sort((a,b)=>a.atMs-b.atMs
    ||(a.observationOrder??-1)-(b.observationOrder??-1));
  const states=new Map(), result=[];
  for(let i=0;i<ordered.length;){
    let end=i+1;while(end<ordered.length&&sameQuotaObservation(ordered[end],ordered[i]))end++;
    const groups=new Map();
    for(const q of ordered.slice(i,end)){const key=q.limitId??'codex',group=groups.get(key)??[];group.push(q);groups.set(key,group);}
    for(const [family,group] of groups){
      const state=states.get(family)??{plan:null,period:null,account:null,seen:false};states.set(family,state);
      const accounts=new Set(group.map(q=>q.accountKey).filter(x=>typeof x==='string'&&x.length));
      const account=accounts.size===1?[...accounts][0]:null;
      const identityConflict=accounts.size>1;
      const identityUnknown=group.some(q=>Object.hasOwn(q,'accountKey')&&!(typeof q.accountKey==='string'&&q.accountKey.length));
      const accountChanged=identityConflict||identityUnknown||account!==null&&state.seen&&account!==state.account;
      if(accountChanged){state.plan=null;state.period=null;}
      if(account!==null)state.account=account;
      else if(identityUnknown)state.account=null;
      state.seen=true;
      const plans=new Set(group.map(q=>q.planType).filter(p=>typeof p==='string'&&p!=='unknown'&&/^[a-z][a-z0-9_]{0,63}$/u.test(p)));
      const conflict=identityConflict||plans.size>1||group.some(q=>q.conflict===true);
      if(conflict){state.plan=null;state.period=null;}
      else if(plans.size===1){const plan=[...plans][0];if(plan!==state.plan){state.plan=plan;state.period=group[0].atMs;}}
      const seen=new Set();
      group.sort((a,b)=>Number(b.direct===true)-Number(a.direct===true)||Number(plans.has(b.planType))-Number(plans.has(a.planType))
        ||Number(b.evidence===true)-Number(a.evidence===true)
        ||(a.resetAtMs??0)-(b.resetAtMs??0)||a.usedPercent-b.usedPercent);
      for(const q of group){
        const legacy=!Object.hasOwn(q,'planType');
        const observed=plans.has(q.planType);
        const plan=conflict?null:observed?q.planType:state.plan;
        q.planAttribution=legacy?'unresolved':observed?'observed':plan?'inferred':'unresolved';
        q.planType=legacy?undefined:plan??'unknown';q.planPeriod=legacy?null:state.period;
        q.accountChanged=accountChanged;
        if(conflict)q.conflict=true;
        if(!legacy){const reset=Number.isSafeInteger(q.resetAtMs)?q.resetAtMs:q.resetKey;
          q.resetKey=JSON.stringify([family,plan,state.period,reset,plan?null:q.atMs]);}
        const key=JSON.stringify([q.resetKey,q.planType,q.usedPercent,q.conflict===true]);
        if(!seen.has(key)){seen.add(key);result.push(q);}
      }
    }
    i=end;
  }
  return result;
}

// A collector sequence orders separate completed reads even when the clock
// gives them the same millisecond. Unordered simultaneous evidence still has
// no defensible first/last reading and retains the existing conflict checks.
function sameQuotaObservation(a,b) {
  return a.atMs===b.atMs&&(a.observationOrder??null)===(b.observationOrder??null);
}

// Recovery is an observed stage boundary, not a scheduled window reset or
// negative consumption. Keep the source reset identity intact and pair only
// inside each stage. Replaying the same ordered facts reconstructs the stages.
function quotaConsumptionStages(observations) {
  let prior=null,stage=0;
  return observations.map(q=>{
    if(q.conflict){prior=null;return {...q};}
    if(q.comparisonStale)return {...q};
    const same=prior&&prior.resetKey===q.resetKey&&!q.accountChanged;
    const recovery=Boolean(same&&q.usedPercent<prior.usedPercent);
    if(!same||recovery)stage++;
    const result={...q,stageKey:`${q.resetKey}:stage:${stage}`,recovery};
    prior=result;
    return result;
  });
}

// Shared by history and the startup comparison; their accumulation policies
// remain separate. Deadlines are evidence,
// not exact IDs: while both deadlines are still in the future, nearby readings
// describe the same pending expiry. At/after expiry that inference is forbidden.
// Process chronologically; future observations never relabel earlier evidence.
function weeklyQuotaTracks(observations, resetEvents, history = false) {
  const scopes = new Map();
  const budget = WORKLOAD_POLICY.comparisonDeadlineUncertaintyMs;
  const resets=new Map();
  for(const raw of resetEvents){const event=normalizeQuotaResetEvent(raw);
    if(event&&event.provider==="openai_codex"&&event.windowDurationMins===10080
      &&["scheduled_reset","unknown_reset","banked_reset_used"].includes(event.kind))
      resets.set(`${event.observedAt}:${event.planType}:${event.limitId}`,event);
  }
  const unusedDeadline=q=>q.usedPercent===0&&Math.abs(q.resetAtMs-q.atMs-WORKLOAD_POLICY.comparisonWindowMs)<=budget;
  return observations.map(q => {
    if (history && q.conflict) { scopes.clear(); return { ...q }; }
    if (!Number.isSafeInteger(q.resetAtMs) || q.resetAtMs < 0 || typeof q.planType !== "string"
        || !q.planType || q.planType === "unknown" || typeof q.limitId !== "string" || !q.limitId) {
      return { ...q, resetKey: `opaque:${q.resetKey}`, transition: "opaque" };
    }
    const scope = history ? JSON.stringify([q.planType,q.limitId,q.planPeriod,q.accountKey??null])
      :JSON.stringify([q.planType,q.limitId,q.accountKey??null]);
    const state = scopes.get(scope) ?? { current: null, retired: [] };
    scopes.set(scope, state);
    const prior = state.current;
    if (prior && Math.abs(q.resetAtMs-prior.resetAtMs)>budget
      && state.retired.some(track => Math.abs(q.resetAtMs - track.resetAtMs) <= budget)) {
      // A delayed reading from a positively expired, retired cycle cannot reopen
      // it or produce another artificial transition back from the new cycle.
      return { ...q, comparisonStale: true };
    }
    let transition = "initial";
    if (prior) {
      const reset=history||q.evidence===true&&q.planAttribution!=='inferred'
        ?resets.get(`${iso(q.atMs)}:${q.planType}:${q.limitId}`):null;
      if(reset&&prior.atMs>=Date.parse(reset.intervalStartedAt)&&prior.atMs<q.atMs){
        state.retired.push(prior);transition="reset";
      }else{
      const distance = Math.abs(q.resetAtMs - prior.resetAtMs);
      const sameDeadline = q.resetAtMs === prior.resetAtMs;
      const pendingExpiry = q.atMs < Math.min(prior.resetAtMs, q.resetAtMs);
      // An unused weekly window may report now+one week on every read. Its
      // deadline is not anchored until first use/countdown; zero readings do
      // not manufacture repeated resets. Once anchored, normal bounds apply.
      const startsUnused=prior.pendingStart&&pendingExpiry
        &&q.resetAtMs>=prior.atMs+WORKLOAD_POLICY.comparisonWindowMs-budget
        &&q.resetAtMs<=q.atMs+WORKLOAD_POLICY.comparisonWindowMs+budget;
      if (sameDeadline || pendingExpiry && distance <= budget || startsUnused) {
        prior.atMs=q.atMs;prior.pendingStart=unusedDeadline(q);
        if(startsUnused)prior.resetAtMs=q.resetAtMs;
        return { ...q, resetKey: prior.key, transition: sameDeadline ? "same" : "jitter" };
      }
      // A new weekly expiry must be future-dated, substantially later than the
      // expired one, and no farther than a weekly window from this observation.
      // No percentage drop is required: hidden usage may already fill a new
      // cycle. A percentage drop alone never proves a reset or grants continuity.
      const renewed = prior.resetAtMs <= q.atMs && q.resetAtMs > q.atMs
        && q.resetAtMs - prior.resetAtMs >= WORKLOAD_POLICY.comparisonWindowMs / 2
        && q.resetAtMs - q.atMs <= WORKLOAD_POLICY.comparisonWindowMs + budget;
      transition = renewed ? "reset" : "ambiguous";
      if (renewed) state.retired.push(prior);
      }
    }
    state.current = { atMs:q.atMs,pendingStart:unusedDeadline(q),resetAtMs: q.resetAtMs, key: `${scope}:${q.resetAtMs}:${q.atMs}` };
    return { ...q, resetKey: state.current.key, transition };
  });
}

export function analyzeWorkload({ nowMs, events = [], usage = [], quota = [], capacity = null,
  capacityHistory = [], liveSinceMs = nowMs, sourceFresh = false, timeZone = "UTC", comparisonCapacityUsd = null,
  comparisonBaseline = null, comparisonQuota = [], comparisonResetEvents = [],
  comparisonAccountKey = null,
  comparisonContinuityThroughMs = null, comparisonEvidenceError = null, estimationPlanType = null,
  quotaResetEvents = comparisonResetEvents, usageCoverageFromMs = 0 }) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("workload_clock_invalid");
  const fromMs = Math.max(0, nowMs - WORKLOAD_POLICY.historyMs);
  const dateFormatter=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"});
  const errors = [];
  const work = taskWorkIntervals(events, { nowMs, liveSinceMs, sourceFresh, usage });
  if (work.conflicts) errors.push({ code: "work_boundary_conflict", stage: "work", count: work.conflicts });
  // Complete change intervals may start before the display/cluster window.
  // Keep that context for allocation denominators; clip only the presentation.
  const intervals = unionWorkIntervals(work.intervals, 0, nowMs);
  const uncertain = unionWorkIntervals(work.incomplete,0,nowMs);
  const completeWork=(from,to)=>!uncertain.some(x=>x.startMs<to&&x.endMs>from);
  if(uncertain.some(x=>x.endMs>fromMs))errors.push({code:"work_boundary_incomplete",stage:"work"});
  const allUsage = usage.filter(u=>finite(u.atMs)&&u.atMs>=0&&u.atMs<=nowMs).sort((a,b)=>a.atMs-b.atMs);
  const selectedUsage = allUsage.filter(u=>u.atMs>=fromMs);
  const hasPrice=u=>u.priced&&finite(u.usd)&&u.usd>=0;
  const byBucket=new Map();
  for(const u of selectedUsage){const key=receiptBucket(u.atMs);
    const list=byBucket.get(key)??[];list.push(u);byBucket.set(key,list);}
  const starts=intervals.map(i=>i.startMs),prefix=[0];
  for(const x of intervals)prefix.push(prefix.at(-1)+x.endMs-x.startMs);
  function integral(at){let lo=0,hi=starts.length;while(lo<hi){const mid=(lo+hi)>>1;if(starts[mid]<at)lo=mid+1;else hi=mid;}
    if(lo===0)return 0;const i=lo-1;return prefix[i]+Math.max(0,Math.min(at,intervals[i].endMs)-intervals[i].startMs);}
  const measure=(a,b)=>b>a?integral(b)-integral(a):0;
  function usageBetween(a,b){let lo=0,hi=allUsage.length;while(lo<hi){const mid=(lo+hi)>>1;if(allUsage[mid].atMs<=a)lo=mid+1;else hi=mid;}
    const values=[];for(let i=lo;i<allUsage.length&&allUsage[i].atMs<=b;i++)values.push(allUsage[i]);return values;}
  const bins = [];
  for (let atMs = Math.floor(fromMs / WORKLOAD_POLICY.bucketMs) * WORKLOAD_POLICY.bucketMs; atMs < nowMs; atMs += WORKLOAD_POLICY.bucketMs) {
    const to = Math.min(nowMs, atMs + WORKLOAD_POLICY.bucketMs), from = Math.max(fromMs, atMs);
    const values = byBucket.get(atMs)??[];
    bins.push({ atMs, fromMs: from, toMs: to, workMs: measure(from, to),
      complete: from>=usageCoverageFromMs && completeWork(from,to),
      usd: values.reduce((sum, u) => sum + (hasPrice(u) ? u.usd : 0), 0), priced: values.every(hasPrice),
      actualPp: 0, coveredWorkMs: 0, actualCovered: false });
  }
  const model = fitWorkload(bins), centers = model?.centers ?? null;
  const binMap=new Map(bins.map(b=>[b.atMs,b]));
  for (const b of bins) b.level = b.complete && b.workMs > 0 && b.priced ? classify(b.usd / hours(b.workMs), model) : "unclassified";
  const today = dateKey(nowMs, dateFormatter), todayUtc = Date.parse(`${today}T00:00:00Z`);
  const daily = Array.from({ length: 7 }, (_, i) => ({ date: iso(todayUtc - (6 - i) * 24 * HOUR).slice(0,10),
    light: 0, medium: 0, heavy: 0, unclassified: 0, covered: false, inferred:false, plans:[] }));
  const dayMap = new Map(daily.map((d) => [d.date, d]));
  let allObservations = [];
  const resolvedQuota=weeklyQuotaTracks(workloadPlanPeriods(quota.filter((q)=>finite(q.atMs)&&q.atMs<=nowMs&&q.atMs>=0
    &&finite(q.usedPercent)&&q.usedPercent>=0&&q.usedPercent<=100)),quotaResetEvents,true);
  for (const x of resolvedQuota) {
    const last = allObservations.at(-1);
    if (last && sameQuotaObservation(last,x)) {
      if (x.conflict || last.usedPercent !== x.usedPercent || last.resetKey !== x.resetKey) {
        last.conflict = true;
        if(x.atMs>=fromMs)errors.push({ code: "quota_observation_conflict", stage: "quota" });
      }
    } else {allObservations.push({ ...x });if(x.conflict&&x.atMs>=fromMs)errors.push({code:'quota_observation_conflict',stage:'quota'});}
  }
  allObservations=quotaConsumptionStages(allObservations);
  const observations=allObservations.filter(q=>q.atMs>=fromMs);
  if(observations.some(q=>q.transition==='ambiguous'))errors.push({code:'quota_reset_ambiguous',stage:'quota'});
  const latestPlanObservation=allObservations.filter(q=>!q.conflict&&q.planType&&q.planType!=='unknown').at(-1);
  const estimatePlan=estimationPlanType??latestPlanObservation?.planType??null;
  const estimatePeriod=latestPlanObservation?.planType===estimatePlan?latestPlanObservation.planPeriod:null;
  const forEstimate=q=>estimatePlan===null?!Object.hasOwn(q,'planType')||q.planType===undefined
    :q.planType===estimatePlan&&estimatePeriod!==null&&q.planPeriod===estimatePeriod;
  const pairs = [];
  let previous = null, staleQuota = 0;
  for (const b of allObservations) {
    if (b.conflict) { previous = null; continue; }
    if (b.comparisonStale) {
      b.stale = true; if(b.atMs>=fromMs)staleQuota++; continue;
    }
    // Integer quota readings are not per-request receipts. Equal readings
    // refresh observation freshness, never the first-change allocation anchor.
    // Keeping this policy here also prevents a renderer/reader second ledger.
    if (previous?.stageKey === b.stageKey && b.usedPercent===previous.usedPercent) continue;
    if (previous?.stageKey === b.stageKey && b.atMs>=fromMs)
      pairs.push([previous,b,b.usedPercent-previous.usedPercent]);
    previous = b;
  }
  let actualPp = 0, actualWorkMs = 0, estimationPp=0, estimationWorkMs=0, estimateInferred=false;
  let segmentPriceMissing=false;
  const summaries=new Map(),unallocatedPlans=new Map(),unallocatedRecords=[];
  let unallocatedCount=0;
  const summaryFor=q=>{const planType=q.planType??'unknown';let s=summaries.get(planType);
    if(!s){s={planType,closedIntervals:0,observedPp:0,dailyPp:0,outsidePp:0,unallocatedPp:0};summaries.set(planType,s);}return s;};
  function allocate(day,level,pp,q,inferred){
    day[level]+=pp;day.covered=true;day.inferred ||= inferred;
    const planType=q.planType??'unknown';let group=day.plans.find(p=>p.planType===planType);
    if(!group){group={planType,light:0,medium:0,heavy:0,unclassified:0,covered:true,inferred:false};day.plans.push(group);}
    group[level]+=pp;group.inferred ||= inferred;
  }
  for (const [a,b,delta] of pairs) {
    if(delta<=0)continue;
    const summary=summaryFor(b);summary.closedIntervals++;summary.observedPp+=delta;
    const ms = measure(a.atMs, b.atMs);
    const incompleteHistory=a.atMs<usageCoverageFromMs;
    const unknown = incompleteHistory||!completeWork(a.atMs,b.atMs);
    if (ms > 0 && !unknown) { actualPp += delta; actualWorkMs += ms; }
    const estimate=forEstimate(a)&&forEstimate(b),inferred=a.planAttribution==='inferred'||b.planAttribution==='inferred';
    if(estimate&&ms>0&&!unknown){estimationPp+=delta;estimationWorkMs+=ms;estimateInferred ||= inferred;}
    const costs = usageBetween(a.atMs,b.atMs);
    const totalUsd = costs.reduce((s,u) => s+(hasPrice(u) ? u.usd : 0),0);
    const priced = costs.every(hasPrice);
    segmentPriceMissing ||= !priced;
    if (!incompleteHistory && priced && totalUsd > 0) {
      let assigned=0;
      for (const u of costs) {
        const pp = delta*u.usd/totalUsd;assigned+=pp;
        const bucket = binMap.get(receiptBucket(u.atMs));
        const level = bucket?.level ?? "unclassified";
        const day = dayMap.get(dateKey(u.atMs,dateFormatter));
        if (day) {allocate(day,level,pp,b,inferred);summary.dailyPp+=pp;}
        else summary.outsidePp+=pp;
        if (bucket && !unknown && estimate) bucket.actualPp += pp;
      }
      // Floating point rounding is bounded; never manufacture a correction
      // in an unrelated date/plan to force a displayed total.
      if(Math.abs(assigned-delta)>1e-8*Math.max(1,delta))throw new RangeError('workload_allocation_invalid');
    } else {
      const da = dateKey(a.atMs,dateFormatter), db = dateKey(b.atMs,dateFormatter);
      if (da === db) {
        if(dayMap.has(da)){allocate(dayMap.get(da),'unclassified',delta,b,inferred);summary.dailyPp+=delta;}
        else summary.outsidePp+=delta;
      } else {
        const visible=da<=daily.at(-1).date&&db>=daily[0].date;
        if(!visible){summary.outsidePp+=delta;continue;}
        const reason=incompleteHistory?'history_incomplete':!priced?'price_missing':'usage_missing';
        summary.unallocatedPp+=delta;unallocatedCount++;
        let group=unallocatedPlans.get(summary.planType);
        if(!group){group={planType:summary.planType,pp:0,intervals:0};unallocatedPlans.set(summary.planType,group);}
        group.pp+=delta;group.intervals++;
        if(unallocatedRecords.length<20)unallocatedRecords.push({from:iso(a.atMs),to:iso(b.atMs),planType:summary.planType,pp:delta,reason,inferred});
      }
    }
    if (estimate && !unknown && priced && totalUsd > 0) for (const bin of bins) {
      if(bin.toMs<=a.atMs||bin.fromMs>=b.atMs)continue;
      const covered = measure(Math.max(a.atMs,bin.fromMs), Math.min(b.atMs,bin.toMs));
      if (covered > 0) { bin.coveredWorkMs += covered; bin.actualCovered = true; }
    }
  }
  const accepted = observations.filter((q) => !q.conflict && !q.stale);
  const last = observations.at(-1);
  // Current balance is independent of the availability of consumption pairs.
  const latest = last?.conflict || last?.direct===true ? last : accepted.at(-1);
  const remainingPercent = latest && !latest.conflict ? 100-latest.usedPercent : null;
  const estimateRemaining=latest&&forEstimate(latest)&&!latest.conflict&&!latest.stale?remainingPercent:null;
  const workHours = ["heavy","medium","light"].map((level) => {
    const rows = bins.filter((b) => b.level === level && b.actualCovered);
    const ms = rows.reduce((s,b) => s+b.coveredWorkMs,0), pp=rows.reduce((s,b) => s+b.actualPp,0);
    const rate = ms>0 ? pp/hours(ms) : null;
    return { level, ratePpPerHour: rate, hours: ratioHours(estimateRemaining,rate), inferred:estimateInferred };
  });
  const overallRate = estimationWorkMs>0 ? estimationPp/hours(estimationWorkMs) : null;
  workHours.push({ level:"composite", ratePpPerHour: overallRate, hours:ratioHours(estimateRemaining,overallRate), inferred:estimateInferred });
  const capacityUsd = finite(capacity?.usd) && capacity.usd>0 ? capacity.usd : null;
  // Recent rates use elapsed hours. Train their independent cuts on complete,
  // non-overlapping 15-minute receipt windows; lifecycle gaps do not define
  // these denominators. Empty windows provide no observed usage sample.
  const elapsedSamples=new Map(),sampleMs=WORKLOAD_POLICY.shortTermMs;
  for(const u of selectedUsage){
    const atMs=Math.floor((u.atMs-1)/sampleMs)*sampleMs;
    if(atMs<Math.max(fromMs,usageCoverageFromMs)||atMs+sampleMs>nowMs)continue;
    const sample=elapsedSamples.get(atMs)??{atMs,workMs:sampleMs,amounts:[],priced:true};
    sample.priced&&=hasPrice(u);if(hasPrice(u))sample.amounts.push(u.usd);
    elapsedSamples.set(atMs,sample);
  }
  const sumAmounts=amounts=>amounts.toSorted((a,b)=>a-b).reduce((sum,x)=>sum+x,0);
  const recentModel=fitWorkload([...elapsedSamples.values()].map(({amounts,...sample})=>({...sample,usd:sumAmounts(amounts)})));
  function recentLoad(windowMs) {
    const start=nowMs-windowMs, recent=usageBetween(start,nowMs);
    const candidate=sourceFresh&&start>=usageCoverageFromMs&&recent.length>0&&recent.every(hasPrice)
      ?sumAmounts(recent.map(u=>u.usd))/hours(windowMs):null;
    const usdRate=finite(candidate)&&candidate>=0?candidate:null;
    const state=usdRate===null?'unknown':'available';
    const inPeriod=estimatePlan===null||estimatePeriod!==null&&start>=estimatePeriod;
    const converted=inPeriod&&usdRate!==null&&capacityUsd!==null ? 100*usdRate/capacityUsd:null;
    const rate=finite(converted)&&converted>=0?converted:null;
    return {windowMinutes:windowMs/MINUTE,state,usdPerHour:usdRate,level:state==='available'?classify(usdRate,recentModel):null,
      ratePpPerHour:rate,hours:ratioHours(remainingPercent,rate)};
  }
  function recentQuotaTrend(){
    const empty={windowMinutes:WORKLOAD_POLICY.trendMs/MINUTE,state:'unknown',ratePpPerHour:null,usdPerHour:null,level:null,
      observedFrom:null,observedThrough:null,coveredMinutes:null,inferred:false};
    if(!sourceFresh)return empty;
    let anchor=null,end=null,inferred=false;
    // Use raw observed differences, never API-weighted daily allocations. Only
    // complete observation intervals inside the window are eligible; no edge
    // proration and no assumption that an unchanged integer reading means zero.
    for(const q of allObservations){
      if(q.atMs<nowMs-WORKLOAD_POLICY.trendMs)continue;
      if(q.stale||q.comparisonStale)continue;
      if(q.conflict||q.transition==='ambiguous'||!forEstimate(q)
        ||typeof q.planType!=='string'||q.planType==='unknown'||q.limitId!=='codex'
        ||!Number.isSafeInteger(q.resetAtMs)||q.resetAtMs<=nowMs){
        anchor=null;end=null;inferred=false;continue;
      }
      if(!anchor||q.stageKey!==anchor.stageKey||q.accountChanged){anchor=q;end=q;inferred=q.planAttribution==='inferred';}
      else {end=q;inferred ||= q.planAttribution==='inferred';}
    }
    if(!anchor||!end||end.atMs<=anchor.atMs||end.usedPercent<=anchor.usedPercent)return empty;
    const ratePpPerHour=(end.usedPercent-anchor.usedPercent)/hours(end.atMs-anchor.atMs);
    // Capacity is selected by the composition root for the current plan/basis.
    // An older account's estimate cannot grade the new account's quota suffix.
    const accountBoundary=allObservations.filter(q=>q.accountChanged&&q.atMs<=end.atMs).at(-1)?.atMs??0;
    const convertible=capacityUsd!==null&&Number.isSafeInteger(capacity?.availableAtMs)
      &&capacity.availableAtMs>=accountBoundary&&capacity.availableAtMs<=nowMs;
    const converted=convertible?ratePpPerHour*capacityUsd/100:null;
    const usdPerHour=finite(converted)&&converted>0?converted:null;
    return {...empty,state:'available',ratePpPerHour,usdPerHour,
      level:usdPerHour===null?null:classify(usdPerHour,recentModel),
      observedFrom:iso(anchor.atMs),observedThrough:iso(end.atMs),coveredMinutes:(end.atMs-anchor.atMs)/MINUTE,inferred};
  }
  const current=recentLoad(WORKLOAD_POLICY.shortTermMs),trend=recentQuotaTrend();
  // Startup totals are independent of the seven-day display window. A reset
  // starts a new pairing baseline, never a new application accumulation.
  const startedAtMs = Math.max(0,Math.min(nowMs,liveSinceMs));
  const versions=(capacityHistory.length?capacityHistory:capacity?[capacity]:[])
    .filter(c=>c.availableAtMs<=nowMs).sort((a,b)=>a.availableAtMs-b.availableAtMs);
  const initialCapacity=versions.filter(c=>c.availableAtMs<=startedAtMs).at(-1)
    ??versions.find(c=>c.availableAtMs>=startedAtMs);
  const comparisonUsd=finite(comparisonCapacityUsd)&&comparisonCapacityUsd>0?comparisonCapacityUsd
    :finite(initialCapacity?.usd)&&initialCapacity.usd>0?initialCapacity.usd:null;
  const comparisonCandidates=[...quota,...comparisonQuota.map(q=>({...q,evidence:true}))]
    .filter(q=>Number.isSafeInteger(q.atMs)&&q.atMs>=0&&q.atMs<=nowMs
      &&(comparisonAccountKey===null||q.accountKey===comparisonAccountKey)
      &&finite(q.usedPercent)&&q.usedPercent>=0&&q.usedPercent<=100);
  if(comparisonBaseline&&comparisonBaseline.atMs>=startedAtMs&&comparisonBaseline.atMs<=nowMs
    &&finite(comparisonBaseline.usedPercent)&&comparisonBaseline.usedPercent>=0&&comparisonBaseline.usedPercent<=100)
    if(!comparisonCandidates.some(q=>q.atMs===comparisonBaseline.atMs&&q.usedPercent===comparisonBaseline.usedPercent
      &&q.resetAtMs===comparisonBaseline.resetAtMs&&q.planType===comparisonBaseline.planType&&q.limitId===comparisonBaseline.limitId))
      comparisonCandidates.push({...comparisonBaseline});
  const comparisonObservations=[];
  // Share the overview's marked plan projection, not a second inheritance rule.
  // Raw labels remain available for persisting a baseline without promoting an
  // inferred label into an explicit observation on the next refresh.
  for(const q of workloadPlanPeriods(comparisonCandidates)){const last=comparisonObservations.at(-1);
    if(last&&sameQuotaObservation(last,q)){
      const compatible=last.resetKey===q.resetKey||last.planType===q.planType&&last.limitId===q.limitId
        &&Math.abs(last.resetAtMs-q.resetAtMs)<=WORKLOAD_POLICY.comparisonDeadlineUncertaintyMs
        &&q.atMs<Math.min(last.resetAtMs,q.resetAtMs);
      if(last.usedPercent!==q.usedPercent||!compatible)last.conflict=true;
    }else comparisonObservations.push({...q});
  }
  let prior=null,observedFrom=null,observedThrough=null,cumulativePp=0,baseline=null;
  const comparisonRanges=[];let comparisonConflict=false,resetGap=false,resetAmbiguous=false,blocked=false;
  let identityChanged=Number.isSafeInteger(comparisonContinuityThroughMs);
  let confirmedThrough=null,comparisonInferred=false;
  for(const q of quotaConsumptionStages(weeklyQuotaTracks(comparisonObservations,comparisonResetEvents))){
    if(Number.isSafeInteger(comparisonContinuityThroughMs)&&q.atMs>=comparisonContinuityThroughMs){blocked=true;break;}
    if(q.comparisonStale)continue;
    if(q.atMs<startedAtMs)continue;
    // A known identity at the exact comparison start is its new baseline,
    // not a switch inside that comparison. Unknown identity still blocks it.
    if(q.accountChanged&&(q.atMs>startedAtMs||q.accountKey===null)){identityChanged=true;blocked=true;break;}
    if(q.conflict){comparisonConflict=true;blocked=true;prior=null;continue;}
    if(prior&&((prior.planType&&q.planType&&prior.planType!=="unknown"&&q.planType!=="unknown"&&prior.planType!==q.planType)
      ||(prior.limitId&&q.limitId&&prior.limitId!==q.limitId))){identityChanged=true;blocked=true;break;}
    if(q.transition==="reset")blocked=false;
    if(prior && q.transition==="ambiguous"){resetAmbiguous=true;blocked=true;}
    // A recovery does not renew an already expired deadline. Keep window
    // uncertainty separate from the valid within-window stage boundary.
    if(prior&&q.transition==='same'&&q.atMs>=q.resetAtMs&&q.recovery){resetAmbiguous=true;blocked=true;}
    if(observedFrom===null){observedFrom=q.atMs;
      if(Number.isSafeInteger(q.resetAtMs)&&typeof q.planType==="string"&&typeof q.limitId==="string")
        baseline={atMs:q.atMs,usedPercent:q.usedPercent,resetAtMs:q.resetAtMs,planType:q.sourcePlanType,limitId:q.limitId};
    }
    observedThrough=q.atMs;
    if(prior?.stageKey===q.stageKey&&!blocked){
      cumulativePp+=q.usedPercent-prior.usedPercent;
      comparisonRanges.push([prior.atMs,q.atMs]);
      comparisonInferred ||= prior.planAttribution==='inferred'||q.planAttribution==='inferred';
      confirmedThrough=q.atMs;
    }else if(prior?.resetKey!==q.resetKey&&prior&&usage.some(u=>u.atMs>prior.atMs&&u.atMs<=q.atMs)){
      resetGap=true;if(q.transition!=="reset")blocked=true;
    }
    prior=q;
  }
  const comparisonUsage=[];let rangeIndex=0;
  for(const u of [...usage].sort((a,b)=>a.atMs-b.atMs)){
    while(rangeIndex<comparisonRanges.length&&u.atMs>comparisonRanges[rangeIndex][1])rangeIndex++;
    const range=comparisonRanges[rangeIndex];
    if(range&&u.atMs>range[0]&&u.atMs<=range[1])comparisonUsage.push(u);
  }
  const comparisonPriced=comparisonUsage.every(u=>u.priced&&finite(u.usd));
  const expectedKnown=comparisonPriced||comparisonUsage.some(u=>u.priced&&finite(u.usd));
  const partial=blocked||comparisonConflict||resetGap||resetAmbiguous
    ||identityChanged||comparisonEvidenceError!==null||!comparisonPriced;
  const hasConfirmed=observedFrom!==null&&(!partial||comparisonRanges.length>0);
  const comparison={startedAtMs,baseline,inferred:comparisonInferred,observedFrom:observedFrom===null?null:iso(observedFrom),
    observedThrough:observedThrough===null?null:iso(observedThrough),capacityUsd:comparisonUsd,
    coverage:observedFrom===null?"unavailable":partial?"partial":"complete",
    confirmedThrough:confirmedThrough===null?null:iso(confirmedThrough),
    actualPp:hasConfirmed?cumulativePp:null,
    expectedPp:hasConfirmed&&comparisonUsd!==null&&expectedKnown
      ?100*comparisonUsage.reduce((s,u)=>s+(u.priced&&finite(u.usd)?u.usd:0),0)/comparisonUsd:null};
  if(comparisonConflict)errors.push({code:"comparison_quota_conflict",stage:"quota"});
  if(resetGap)errors.push({code:"comparison_reset_gap",stage:"quota"});
  if(resetAmbiguous)errors.push({code:"comparison_reset_ambiguous",stage:"quota"});
  if(identityChanged)errors.push({code:"comparison_identity_changed",stage:"quota"});
  if(comparisonEvidenceError!==null)errors.push({code:["quota_history_read_failed","quota_history_too_large","quota_history_invalid"].includes(comparisonEvidenceError)?comparisonEvidenceError:"quota_history_read_failed",stage:"quota"});
  if(!comparisonPriced)errors.push({code:"price_missing",stage:"pricing"});
  if (segmentPriceMissing||selectedUsage.some(u=>!hasPrice(u))) errors.push({code:"price_missing",stage:"pricing"});
  if(pairs.some(([a])=>a.atMs<usageCoverageFromMs))errors.push({code:'workload_history_incomplete',stage:'index'});
  const allowancePoints=new Map();
  for(const q of observations)allowancePoints.set(`${Math.floor(q.atMs/WORKLOAD_POLICY.bucketMs)}:${q.stageKey??q.resetKey}`,q);
  const allowanceRows=[...allowancePoints.values()].sort((a,b)=>a.atMs-b.atMs);
  const groupedErrors=new Map();
  for(const error of errors){const key=`${error.stage}:${error.code}`,prior=groupedErrors.get(key);
    groupedErrors.set(key,{...error,count:(prior?.count??0)+(error.count??1)});}
  return { schemaVersion:"overview-workload-v9", policyVersion:WORKLOAD_POLICY.version,
    generatedAt:iso(nowMs), timeZone, status:errors.length?"partial":"available", errors:[...groupedErrors.values()],
    adjustments:{workReplayEvents:work.replayed,workDurationDifferences:work.durationDifferences,quotaStaleObservations:staleQuota},
    allowance:{ remainingPercent, observedAt:latest?iso(latest.atMs):null,
      points:allowanceRows.map((q,i)=>({at:iso(q.atMs),remainingPercent:q.conflict||q.stale?null:100-q.usedPercent,
        breakBefore:i===0||q.stageKey!==allowanceRows[i-1].stageKey||q.atMs-allowanceRows[i-1].atMs>15*MINUTE})) },
    planAttribution:{policyVersion:'observed-plan-period-v1',estimationPlanType:estimatePlan,
      inferredObservations:observations.filter(q=>q.planAttribution==='inferred').length,
      unresolvedObservations:observations.filter(q=>q.planType==='unknown').length},
    workHours, classification:{ centers, version:WORKLOAD_POLICY.version },
    recentClassification:{centers:recentModel?.centers??null,version:'elapsed-fifteen-minute-v1'},daily, current, trend,
    segmentation:{policyVersion:'quota-recovery-stages-v2',pendingSince:previous?iso(previous.atMs):null,
      plans:[...summaries.values()]},
    unallocated:{totalIntervals:unallocatedCount,plans:[...unallocatedPlans.values()],records:unallocatedRecords,
      truncated:unallocatedCount>unallocatedRecords.length},
    comparison,
    coverage:{workMs:lengthMs(intervals,fromMs,nowMs),actualWorkMs,actualPp,estimationWorkMs,estimationPp,activeTasks:work.active,unresolvedTasks:work.unresolved} };
}
