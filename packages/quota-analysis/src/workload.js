import { normalizeQuotaResetEvent } from "./reset-events.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const WORKLOAD_POLICY = Object.freeze({
  version: "task-workload-v6", bucketMs: 5 * MINUTE, historyMs: 168 * HOUR,
  currentMs: 15 * MINUTE, minimumBins: 9, minimumClassBins: 3, minimumClassMs: MINUTE,
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
  const intervals = [], incomplete = [];
  let active = 0, unresolved = 0, conflicts = 0, replayed = 0, durationDifferences = 0;
  for (const candidates of groups.values()) {
    // Only explicit ancestry establishes replay. Unrelated sessions with the
    // same key remain conflicting; a genuine child completion may close an
    // ancestor's open task. Different terminal durations are not deduplicated.
    const owned = candidates.filter((e) => {
      const copied = candidates.some((a) => e.ancestors?.includes(a.session)
        && a.kind === e.kind && (e.kind !== "complete" || a.durationMs === e.durationMs));
      if (copied) replayed++;
      return !copied;
    });
    const group=owned.filter((e,i)=>owned.findIndex(x=>x.kind===e.kind&&x.atMs===e.atMs&&x.durationMs===e.durationMs)===i);
    group.sort((a, b) => a.atMs - b.atMs);
    const starts = group.filter((x) => x.kind === "start");
    const ends = group.filter((x) => ["complete", "abort"].includes(x.kind));
    if (starts.length > 1 || ends.length > 1) { conflicts++; continue; }
    const begin = starts[0], end = ends[0];
    if (end) {
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
    const activity = (usageBySession.get(begin.session)??[]).filter((u) => u.atMs >= begin.atMs && u.atMs <= nowMs);
    const previous = activity.filter((u) => u.atMs < liveSinceMs).at(-1)?.atMs ?? begin.atMs;
    const recent = activity.find((u) => u.atMs >= liveSinceMs)?.atMs;
    if (sourceFresh && begin.atMs >= liveSinceMs) {
      intervals.push({ startMs: begin.atMs, endMs: nowMs }); active++;
    } else {
      intervals.push({ startMs: begin.atMs, endMs: previous });
      if (sourceFresh && finite(recent)) {
        intervals.push({ startMs: recent, endMs: nowMs }); active++;
      } else {
        const last = activity.at(-1)?.atMs ?? begin.atMs;
        // An old orphan does not make all later, independent completed work
        // unusable. Only its last observation bucket has unresolved coverage.
        incomplete.push({ startMs: last, endMs: Math.min(nowMs,last+WORKLOAD_POLICY.bucketMs) });
        if (last >= nowMs - WORKLOAD_POLICY.currentMs) unresolved++;
      }
    }
  }
  return { intervals, incomplete, active, unresolved, conflicts, replayed, durationDifferences };
}

// Exact weighted 1-D three-means; O(3*n*n), O(3*n) memory, no random seed.
export function clusterWorkload(bins) {
  const rows = bins.filter((b) => b.workMs > 0 && b.priced && finite(b.usd) && b.usd >= 0)
    .map((b) => ({ ...b, x: b.usd / hours(b.workMs) }))
    .sort((a, b) => a.x - b.x || a.atMs - b.atMs);
  const n = rows.length;
  if (n < WORKLOAD_POLICY.minimumBins || new Set(rows.map((b) => b.x)).size < 3) return null;
  const w = new Float64Array(n + 1), s = new Float64Array(n + 1), q = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    w[i + 1] = w[i] + rows[i].workMs;
    s[i + 1] = s[i] + rows[i].workMs * rows[i].x;
    q[i + 1] = q[i] + rows[i].workMs * rows[i].x ** 2;
  }
  let prev = new Float64Array(n + 1).fill(Infinity); prev[0] = 0;
  const splits = [];
  for (let k = 1; k <= 3; k++) {
    const next = new Float64Array(n + 1).fill(Infinity), split = new Int32Array(n + 1).fill(-1);
    for (let i = k * 3; i <= n; i++) {
      for (let j = (k - 1) * 3; j <= i - 3; j++) {
        const weight = w[i] - w[j];
        if (!finite(prev[j]) || weight < WORKLOAD_POLICY.minimumClassMs) continue;
        const score = prev[j] + Math.max(0, q[i] - q[j] - (s[i] - s[j]) ** 2 / weight);
        if (score < next[i]) { next[i] = score; split[i] = j; }
      }
    }
    splits.push(split); prev = next;
  }
  if (!finite(prev[n])) return null;
  const centers = [];
  let stop = n;
  for (let k = 2; k >= 0; k--) {
    const start = splits[k][stop];
    centers.unshift((s[stop] - s[start]) / (w[stop] - w[start])); stop = start;
  }
  if (!centers.every(finite) || !(centers[0] < centers[1] && centers[1] < centers[2])) return null;
  return centers;
}
function classify(x, centers) {
  if (!centers || !finite(x)) return "unclassified";
  let best = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(x - centers[i]) < Math.abs(x - centers[best])) best = i;
  return LEVELS[best];
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
  const ordered=quota.map(q=>({...q})).sort((a,b)=>a.atMs-b.atMs);
  const states=new Map(), result=[];
  for(let i=0;i<ordered.length;){
    let end=i+1;while(end<ordered.length&&ordered[end].atMs===ordered[i].atMs)end++;
    const groups=new Map();
    for(const q of ordered.slice(i,end)){const key=q.limitId??'codex',group=groups.get(key)??[];group.push(q);groups.set(key,group);}
    for(const [family,group] of groups){
      const state=states.get(family)??{plan:null,period:null,account:null};states.set(family,state);
      const accounts=new Set(group.map(q=>q.accountKey).filter(x=>typeof x==='string'&&x.length));
      const account=accounts.size===1?[...accounts][0]:null;
      const identityConflict=accounts.size>1;
      if(identityConflict||account!==null&&state.account!==null&&account!==state.account){state.plan=null;state.period=null;}
      if(account!==null)state.account=account;
      const plans=new Set(group.map(q=>q.planType).filter(p=>typeof p==='string'&&p!=='unknown'&&/^[a-z][a-z0-9_]{0,63}$/u.test(p)));
      const conflict=identityConflict||plans.size>1;
      if(conflict){state.plan=null;state.period=null;}
      else if(plans.size===1){const plan=[...plans][0];if(plan!==state.plan){state.plan=plan;state.period=group[0].atMs;}}
      const seen=new Set();
      group.sort((a,b)=>Number(plans.has(b.planType))-Number(plans.has(a.planType)));
      for(const q of group){
        const legacy=!Object.hasOwn(q,'planType');
        const observed=plans.has(q.planType);
        const plan=conflict?null:observed?q.planType:state.plan;
        q.planAttribution=legacy?'unresolved':observed?'observed':plan?'inferred':'unresolved';
        q.planType=legacy?undefined:plan??'unknown';q.planPeriod=legacy?null:state.period;
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

// Resolve only the startup comparison's weekly cycles. Deadlines are evidence,
// not exact IDs: while both deadlines are still in the future, nearby readings
// describe the same pending expiry. At/after expiry that inference is forbidden.
// Process chronologically; future observations never relabel earlier evidence.
function startupQuotaTracks(observations, resetEvents) {
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
    if (!Number.isSafeInteger(q.resetAtMs) || q.resetAtMs < 0 || typeof q.planType !== "string"
        || !q.planType || q.planType === "unknown" || typeof q.limitId !== "string" || !q.limitId) {
      return { ...q, resetKey: `opaque:${q.resetKey}`, transition: "opaque" };
    }
    const scope = `${q.planType}:${q.limitId}`;
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
      const reset=q.evidence===true?resets.get(`${iso(q.atMs)}:${q.planType}:${q.limitId}`):null;
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
  comparisonContinuityThroughMs = null, comparisonEvidenceError = null, estimationPlanType = null }) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("workload_clock_invalid");
  const fromMs = Math.max(0, nowMs - WORKLOAD_POLICY.historyMs);
  const dateFormatter=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"});
  const errors = [];
  const work = taskWorkIntervals(events, { nowMs, liveSinceMs, sourceFresh, usage });
  if (work.conflicts) errors.push({ code: "work_boundary_conflict", stage: "work", count: work.conflicts });
  const intervals = unionWorkIntervals(work.intervals, fromMs, nowMs);
  const selectedUsage = usage.filter((u) => u.atMs >= fromMs && u.atMs <= nowMs).sort((a,b) => a.atMs-b.atMs);
  const byBucket=new Map();
  for(const u of selectedUsage){const key=receiptBucket(u.atMs);
    const list=byBucket.get(key)??[];list.push(u);byBucket.set(key,list);}
  const starts=intervals.map(i=>i.startMs),prefix=[0];
  for(const x of intervals)prefix.push(prefix.at(-1)+x.endMs-x.startMs);
  function integral(at){let lo=0,hi=starts.length;while(lo<hi){const mid=(lo+hi)>>1;if(starts[mid]<at)lo=mid+1;else hi=mid;}
    if(lo===0)return 0;const i=lo-1;return prefix[i]+Math.max(0,Math.min(at,intervals[i].endMs)-intervals[i].startMs);}
  const measure=(a,b)=>b>a?integral(b)-integral(a):0;
  function usageBetween(a,b){let lo=0,hi=selectedUsage.length;while(lo<hi){const mid=(lo+hi)>>1;if(selectedUsage[mid].atMs<=a)lo=mid+1;else hi=mid;}
    const values=[];for(let i=lo;i<selectedUsage.length&&selectedUsage[i].atMs<=b;i++)values.push(selectedUsage[i]);return values;}
  const bins = [];
  for (let atMs = Math.floor(fromMs / WORKLOAD_POLICY.bucketMs) * WORKLOAD_POLICY.bucketMs; atMs < nowMs; atMs += WORKLOAD_POLICY.bucketMs) {
    const to = Math.min(nowMs, atMs + WORKLOAD_POLICY.bucketMs), from = Math.max(fromMs, atMs);
    const values = byBucket.get(atMs)??[];
    bins.push({ atMs, fromMs: from, toMs: to, workMs: measure(from, to),
      usd: values.reduce((sum, u) => sum + (u.priced ? u.usd : 0), 0), priced: values.every((u) => u.priced),
      actualPp: 0, coveredWorkMs: 0, actualCovered: false });
  }
  const centers = clusterWorkload(bins);
  const binMap=new Map(bins.map(b=>[b.atMs,b]));
  for (const b of bins) b.level = b.workMs > 0 && b.priced ? classify(b.usd / hours(b.workMs), centers) : "unclassified";
  const today = dateKey(nowMs, dateFormatter), todayUtc = Date.parse(`${today}T00:00:00Z`);
  const daily = Array.from({ length: 7 }, (_, i) => ({ date: iso(todayUtc - (6 - i) * 24 * HOUR).slice(0,10),
    light: 0, medium: 0, heavy: 0, unclassified: 0, covered: false, inferred:false, plans:[] }));
  const dayMap = new Map(daily.map((d) => [d.date, d]));
  const allObservations = [];
  const resolvedQuota=workloadPlanPeriods(quota.filter((q)=>finite(q.atMs)&&q.atMs<=nowMs&&q.atMs>=0
    &&finite(q.usedPercent)&&q.usedPercent>=0&&q.usedPercent<=100));
  for (const x of resolvedQuota) {
    const last = allObservations.at(-1);
    if (last?.atMs === x.atMs) {
      if (x.conflict || last.usedPercent !== x.usedPercent || last.resetKey !== x.resetKey) {
        last.conflict = true;
        if(x.atMs>=fromMs)errors.push({ code: "quota_observation_conflict", stage: "quota" });
      }
    } else {allObservations.push({ ...x });if(x.conflict&&x.atMs>=fromMs)errors.push({code:'quota_observation_conflict',stage:'quota'});}
  }
  const observations=allObservations.filter(q=>q.atMs>=fromMs);
  const latestPlanObservation=allObservations.filter(q=>!q.conflict&&q.planType&&q.planType!=='unknown').at(-1);
  const estimatePlan=estimationPlanType??latestPlanObservation?.planType??null;
  const estimatePeriod=latestPlanObservation?.planType===estimatePlan?latestPlanObservation.planPeriod:null;
  const forEstimate=q=>estimatePlan===null?!Object.hasOwn(q,'planType')||q.planType===undefined
    :q.planType===estimatePlan&&estimatePeriod!==null&&q.planPeriod===estimatePeriod;
  const watermark = new Map(), pairs = [];
  for(const q of allObservations.filter(q=>q.atMs<fromMs&&!q.conflict))
    watermark.set(q.resetKey,Math.max(watermark.get(q.resetKey)??0,q.usedPercent));
  let previous = null, staleQuota = 0;
  for (const b of observations) {
    if (b.conflict) { previous = null; continue; }
    const high = watermark.get(b.resetKey);
    if (high !== undefined && b.usedPercent < high) {
      b.stale = true; staleQuota++; continue;
    }
    if (previous?.resetKey === b.resetKey) pairs.push([previous,b,b.usedPercent-(high??previous.usedPercent)]);
    watermark.set(b.resetKey,b.usedPercent);
    previous = b;
  }
  let actualPp = 0, actualWorkMs = 0, estimationPp=0, estimationWorkMs=0, estimateInferred=false;
  function allocate(day,level,pp,q,inferred){
    day[level]+=pp;day.covered=true;day.inferred ||= inferred;
    const planType=q.planType??'unknown';let group=day.plans.find(p=>p.planType===planType);
    if(!group){group={planType,light:0,medium:0,heavy:0,unclassified:0,covered:true,inferred:false};day.plans.push(group);}
    group[level]+=pp;group.inferred ||= inferred;
  }
  for (const [a,b,delta] of pairs) {
    const ms = measure(a.atMs, b.atMs);
    const unknown = work.incomplete.some((x) => x.startMs < b.atMs && x.endMs > a.atMs);
    if (ms > 0 && !unknown) { actualPp += delta; actualWorkMs += ms; }
    const estimate=forEstimate(a)&&forEstimate(b),inferred=a.planAttribution==='inferred'||b.planAttribution==='inferred';
    if(estimate&&ms>0&&!unknown){estimationPp+=delta;estimationWorkMs+=ms;estimateInferred ||= inferred;}
    const costs = usageBetween(a.atMs,b.atMs);
    const totalUsd = costs.reduce((s,u) => s+(u.priced ? u.usd : 0),0);
    const priced = costs.every((u) => u.priced);
    if (priced && totalUsd > 0) {
      for (const u of costs) {
        const pp = delta*u.usd/totalUsd;
        const bucket = binMap.get(receiptBucket(u.atMs));
        const level = bucket?.level ?? "unclassified";
        const day = dayMap.get(dateKey(u.atMs,dateFormatter));
        if (day) allocate(day,level,pp,b,inferred);
        if (bucket && !unknown && estimate) bucket.actualPp += pp;
      }
    } else {
      const da = dateKey(a.atMs,dateFormatter), db = dateKey(b.atMs,dateFormatter);
      if (da === db && dayMap.has(da)) allocate(dayMap.get(da),'unclassified',delta,b,inferred);
    }
    if (estimate && !unknown && priced && (totalUsd > 0 || delta === 0)) for (const bin of bins) {
      if(bin.toMs<=a.atMs||bin.fromMs>=b.atMs)continue;
      const covered = measure(Math.max(a.atMs,bin.fromMs), Math.min(b.atMs,bin.toMs));
      if (covered > 0) { bin.coveredWorkMs += covered; bin.actualCovered = true; }
    }
  }
  const accepted = observations.filter((q) => !q.conflict && !q.stale);
  const last = observations.at(-1);
  const latest = last?.conflict ? last : accepted.at(-1);
  const remainingPercent = latest && !latest.conflict ? 100-latest.usedPercent : null;
  const estimateRemaining=latest&&forEstimate(latest)&&!latest.conflict?remainingPercent:null;
  const workHours = ["heavy","medium","light"].map((level) => {
    const rows = bins.filter((b) => b.level === level && b.actualCovered);
    const ms = rows.reduce((s,b) => s+b.coveredWorkMs,0), pp=rows.reduce((s,b) => s+b.actualPp,0);
    const rate = ms>0 ? pp/hours(ms) : null;
    return { level, ratePpPerHour: rate, hours: ratioHours(estimateRemaining,rate), inferred:estimateInferred };
  });
  const overallRate = estimationWorkMs>0 ? estimationPp/hours(estimationWorkMs) : null;
  workHours.push({ level:"composite", ratePpPerHour: overallRate, hours:ratioHours(estimateRemaining,overallRate), inferred:estimateInferred });
  const recent = selectedUsage.filter((u) => u.atMs>nowMs-WORKLOAD_POLICY.currentMs);
  const recentMs = measure(Math.max(fromMs,nowMs-WORKLOAD_POLICY.currentMs),nowMs);
  const recentUsd = recent.reduce((s,u) => s+(u.priced?u.usd:0),0);
  const usdRate = recentMs>0 && recent.every((u) => u.priced) ? recentUsd/hours(recentMs) : null;
  const capacityUsd = finite(capacity?.usd) && capacity.usd>0 ? capacity.usd : null;
  const recentInPeriod=estimatePlan===null||estimatePeriod!==null&&nowMs-WORKLOAD_POLICY.currentMs>=estimatePeriod;
  const currentRate = recentInPeriod && usdRate!==null && capacityUsd!==null ? 100*usdRate/capacityUsd : null;
  const currentState = !sourceFresh ? "unknown" : work.active>0 ? "working" : work.unresolved>0 ? "unknown" : "idle";
  const current = { state:currentState, level: currentState==="working" ? classify(usdRate,centers) : null,
    ratePpPerHour:currentState==="working" ? currentRate : null,
    hours:currentState==="working" ? ratioHours(remainingPercent,currentRate) : null };
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
      &&finite(q.usedPercent)&&q.usedPercent>=0&&q.usedPercent<=100);
  if(comparisonBaseline&&comparisonBaseline.atMs>=startedAtMs&&comparisonBaseline.atMs<=nowMs
    &&finite(comparisonBaseline.usedPercent)&&comparisonBaseline.usedPercent>=0&&comparisonBaseline.usedPercent<=100)
    comparisonCandidates.push({...comparisonBaseline});
  comparisonCandidates.sort((a,b)=>a.atMs-b.atMs||Number(b.evidence===true)-Number(a.evidence===true));
  const comparisonObservations=[];
  for(const q of comparisonCandidates){const last=comparisonObservations.at(-1);
    if(last?.atMs===q.atMs){
      const compatible=last.resetKey===q.resetKey||last.planType===q.planType&&last.limitId===q.limitId
        &&Math.abs(last.resetAtMs-q.resetAtMs)<=WORKLOAD_POLICY.comparisonDeadlineUncertaintyMs
        &&q.atMs<Math.min(last.resetAtMs,q.resetAtMs);
      if(last.usedPercent!==q.usedPercent||!compatible)last.conflict=true;
    }else comparisonObservations.push({...q});
  }
  const startupHigh=new Map();let prior=null,observedFrom=null,observedThrough=null,cumulativePp=0,baseline=null;
  const comparisonRanges=[];let comparisonConflict=false,resetGap=false,resetAmbiguous=false,blocked=false;
  let identityChanged=Number.isSafeInteger(comparisonContinuityThroughMs);
  let confirmedThrough=null;
  for(const q of startupQuotaTracks(comparisonObservations,comparisonResetEvents)){
    if(Number.isSafeInteger(comparisonContinuityThroughMs)&&q.atMs>=comparisonContinuityThroughMs){blocked=true;break;}
    if(q.comparisonStale)continue;
    if(q.atMs<startedAtMs){if(!q.conflict)startupHigh.set(q.resetKey,Math.max(startupHigh.get(q.resetKey)??0,q.usedPercent));continue;}
    if(q.conflict){comparisonConflict=true;blocked=true;prior=null;continue;}
    if(prior&&((prior.planType&&q.planType&&prior.planType!=="unknown"&&q.planType!=="unknown"&&prior.planType!==q.planType)
      ||(prior.limitId&&q.limitId&&prior.limitId!==q.limitId))){identityChanged=true;blocked=true;break;}
    if(q.transition==="reset")blocked=false;
    if(prior && q.transition==="ambiguous"){resetAmbiguous=true;blocked=true;}
    const high=startupHigh.get(q.resetKey);
    if(prior && q.transition==="same" && q.atMs>=q.resetAtMs && high!==undefined && q.usedPercent<high){resetAmbiguous=true;blocked=true;}
    if(high!==undefined&&q.usedPercent<high)continue;
    if(observedFrom===null){observedFrom=q.atMs;
      if(Number.isSafeInteger(q.resetAtMs)&&typeof q.planType==="string"&&typeof q.limitId==="string")
        baseline={atMs:q.atMs,usedPercent:q.usedPercent,resetAtMs:q.resetAtMs,planType:q.planType,limitId:q.limitId};
    }
    if(prior?.atMs===q.atMs&&prior.usedPercent!==q.usedPercent){comparisonConflict=true;blocked=true;prior=null;continue;}
    observedThrough=q.atMs;
    if(prior?.resetKey===q.resetKey&&!blocked){
      cumulativePp+=q.usedPercent-(high??prior.usedPercent);
      comparisonRanges.push([prior.atMs,q.atMs]);
      confirmedThrough=q.atMs;
    }else if(prior?.resetKey!==q.resetKey&&prior&&usage.some(u=>u.atMs>prior.atMs&&u.atMs<=q.atMs)){
      resetGap=true;if(q.transition!=="reset")blocked=true;
    }
    startupHigh.set(q.resetKey,q.usedPercent);prior=q;
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
  const comparison={startedAtMs,baseline,observedFrom:observedFrom===null?null:iso(observedFrom),
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
  if (selectedUsage.some((u)=>!u.priced)) errors.push({code:"price_missing",stage:"pricing"});
  const allowancePoints=new Map();
  for(const q of observations)allowancePoints.set(`${Math.floor(q.atMs/WORKLOAD_POLICY.bucketMs)}:${q.resetKey}`,q);
  const allowanceRows=[...allowancePoints.values()].sort((a,b)=>a.atMs-b.atMs);
  const groupedErrors=new Map();
  for(const error of errors){const key=`${error.stage}:${error.code}`,prior=groupedErrors.get(key);
    groupedErrors.set(key,{...error,count:(prior?.count??0)+(error.count??1)});}
  return { schemaVersion:"overview-workload-v4", policyVersion:WORKLOAD_POLICY.version,
    generatedAt:iso(nowMs), timeZone, status:errors.length?"partial":"available", errors:[...groupedErrors.values()],
    adjustments:{workReplayEvents:work.replayed,workDurationDifferences:work.durationDifferences,quotaStaleObservations:staleQuota},
    allowance:{ remainingPercent, observedAt:latest?iso(latest.atMs):null,
      points:allowanceRows.map((q,i)=>({at:iso(q.atMs),remainingPercent:q.conflict||q.stale?null:100-q.usedPercent,
        breakBefore:i===0||q.resetKey!==allowanceRows[i-1].resetKey||q.atMs-allowanceRows[i-1].atMs>15*MINUTE})) },
    planAttribution:{policyVersion:'observed-plan-period-v1',estimationPlanType:estimatePlan,
      inferredObservations:observations.filter(q=>q.planAttribution==='inferred').length,
      unresolvedObservations:observations.filter(q=>q.planType==='unknown').length},
    workHours, classification:{ centers, version:WORKLOAD_POLICY.version }, daily, current,
    comparison,
    coverage:{workMs:lengthMs(intervals,fromMs,nowMs),actualWorkMs,actualPp,estimationWorkMs,estimationPp,activeTasks:work.active,unresolvedTasks:work.unresolved} };
}
