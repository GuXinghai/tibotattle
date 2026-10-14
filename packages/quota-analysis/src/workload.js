const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const WORKLOAD_POLICY = Object.freeze({
  version: "task-workload-v1", bucketMs: 5 * MINUTE, historyMs: 168 * HOUR,
  currentMs: 15 * MINUTE, minimumBins: 9, minimumClassBins: 3, minimumClassMs: MINUTE,
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
    if (!group.some((x) => x.kind === e.kind && x.atMs === e.atMs && x.durationMs === e.durationMs)) group.push(e);
    groups.set(e.key, group);
  }
  const intervals = [], incomplete = [];
  let active = 0, unresolved = 0, conflicts = 0;
  for (const group of groups.values()) {
    group.sort((a, b) => a.atMs - b.atMs);
    const starts = group.filter((x) => x.kind === "start");
    const ends = group.filter((x) => ["complete", "abort"].includes(x.kind));
    if (starts.length > 1 || ends.length > 1) { conflicts++; continue; }
    const begin = starts[0], end = ends[0];
    if (end) {
      const startMs = begin?.atMs ?? (finite(end.durationMs) ? end.atMs - end.durationMs : null);
      if (!finite(startMs) || startMs < 0 || end.atMs < startMs
          || begin && finite(end.durationMs) && Math.abs(end.atMs - startMs - end.durationMs) > 2000) {
        conflicts++; continue;
      }
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
  return { intervals, incomplete, active, unresolved, conflicts };
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

export function analyzeWorkload({ nowMs, events = [], usage = [], quota = [], capacity = null,
  capacityHistory = [], liveSinceMs = nowMs, sourceFresh = false, timeZone = "UTC", comparisonAnchorMs = null }) {
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
    light: 0, medium: 0, heavy: 0, unclassified: 0, covered: false }));
  const dayMap = new Map(daily.map((d) => [d.date, d]));
  const observations = [];
  for (const x of [...quota].filter((q) => q.atMs <= nowMs && q.atMs >= fromMs
    && finite(q.usedPercent) && q.usedPercent >= 0 && q.usedPercent <= 100).sort((a,b) => a.atMs-b.atMs)) {
    const last = observations.at(-1);
    if (last?.atMs === x.atMs) {
      if (last.usedPercent !== x.usedPercent || last.resetKey !== x.resetKey) {
        last.conflict = true; errors.push({ code: "quota_observation_conflict", stage: "quota" });
      }
    } else observations.push({ ...x });
  }
  let actualPp = 0, actualWorkMs = 0;
  for (let i = 1; i < observations.length; i++) {
    const a = observations[i-1], b = observations[i];
    if (a.conflict || b.conflict || a.resetKey !== b.resetKey) continue;
    const delta = b.usedPercent-a.usedPercent;
    if (delta < 0) { errors.push({ code:"quota_observation_conflict", stage:"quota" }); continue; }
    const ms = measure(a.atMs, b.atMs);
    const unknown = work.incomplete.some((x) => x.startMs < b.atMs && x.endMs > a.atMs);
    if (ms > 0 && !unknown) { actualPp += delta; actualWorkMs += ms; }
    const costs = usageBetween(a.atMs,b.atMs);
    const totalUsd = costs.reduce((s,u) => s+(u.priced ? u.usd : 0),0);
    const priced = costs.every((u) => u.priced);
    if (priced && totalUsd > 0) {
      for (const u of costs) {
        const pp = delta*u.usd/totalUsd;
        const bucket = binMap.get(receiptBucket(u.atMs));
        const level = bucket?.level ?? "unclassified";
        const day = dayMap.get(dateKey(u.atMs,dateFormatter));
        if (day) { day[level] += pp; day.covered = true; }
        if (bucket && !unknown) bucket.actualPp += pp;
      }
    } else {
      const da = dateKey(a.atMs,dateFormatter), db = dateKey(b.atMs,dateFormatter);
      if (da === db && dayMap.has(da)) { const d=dayMap.get(da); d.covered=true; d.unclassified+=delta; }
    }
    if (!unknown && priced && (totalUsd > 0 || delta === 0)) for (const bin of bins) {
      if(bin.toMs<=a.atMs||bin.fromMs>=b.atMs)continue;
      const covered = measure(Math.max(a.atMs,bin.fromMs), Math.min(b.atMs,bin.toMs));
      if (covered > 0) { bin.coveredWorkMs += covered; bin.actualCovered = true; }
    }
  }
  const latest = observations.at(-1);
  const remainingPercent = latest && !latest.conflict ? 100-latest.usedPercent : null;
  const workHours = ["heavy","medium","light"].map((level) => {
    const rows = bins.filter((b) => b.level === level && b.actualCovered);
    const ms = rows.reduce((s,b) => s+b.coveredWorkMs,0), pp=rows.reduce((s,b) => s+b.actualPp,0);
    const rate = ms>0 ? pp/hours(ms) : null;
    return { level, ratePpPerHour: rate, hours: ratioHours(remainingPercent,rate) };
  });
  const overallRate = actualWorkMs>0 ? actualPp/hours(actualWorkMs) : null;
  workHours.push({ level:"composite", ratePpPerHour: overallRate, hours:ratioHours(remainingPercent,overallRate) });
  const recent = selectedUsage.filter((u) => u.atMs>nowMs-WORKLOAD_POLICY.currentMs);
  const recentMs = measure(Math.max(fromMs,nowMs-WORKLOAD_POLICY.currentMs),nowMs);
  const recentUsd = recent.reduce((s,u) => s+(u.priced?u.usd:0),0);
  const usdRate = recentMs>0 && recent.every((u) => u.priced) ? recentUsd/hours(recentMs) : null;
  const capacityUsd = finite(capacity?.usd) && capacity.usd>0 ? capacity.usd : null;
  const currentRate = usdRate!==null && capacityUsd!==null ? 100*usdRate/capacityUsd : null;
  const currentState = !sourceFresh ? "unknown" : work.active>0 ? "working" : work.unresolved>0 ? "unknown" : "idle";
  const current = { state:currentState, level: currentState==="working" ? classify(usdRate,centers) : null,
    ratePpPerHour:currentState==="working" ? currentRate : null,
    hours:currentState==="working" ? ratioHours(remainingPercent,currentRate) : null };
  const first = observations.find((q) => !q.conflict);
  let anchor = finite(comparisonAnchorMs) ? comparisonAnchorMs : first?.atMs ?? nowMs;
  // A new weekly allowance starts a new comparison, even within an hour.
  const cycleStart = observations.find((q) => !q.conflict && q.resetKey === latest?.resetKey);
  if (cycleStart) anchor = Math.max(anchor, cycleStart.atMs);
  const versions=capacityHistory.length?capacityHistory:capacity?[capacity]:[];
  if(versions.length)anchor=Math.max(anchor,versions[0].availableAtMs);
  if (nowMs-anchor>HOUR && nowMs-(latest?.atMs??0)>HOUR) anchor=nowMs;
  while (nowMs-anchor>=HOUR) anchor+=40*MINUTE;
  const base = observations.find((q) => !q.conflict && q.atMs>=anchor && q.atMs<anchor+WORKLOAD_POLICY.bucketMs);
  const comparisonCapacity=base?versions.filter(c=>c.availableAtMs<=base.atMs).at(-1):null;
  const comparisonUsd=finite(comparisonCapacity?.usd)&&comparisonCapacity.usd>0?comparisonCapacity.usd:null;
  const points=[];
  if (base && comparisonUsd!==null) {
    const grouped = new Map();
    for (const q of observations.filter((q) => !q.conflict && q.atMs>=base.atMs && q.resetKey===base.resetKey)) grouped.set(Math.floor(q.atMs/WORKLOAD_POLICY.bucketMs),q);
    for (const q of grouped.values()) {
      const us=selectedUsage.filter((u) => u.atMs>base.atMs&&u.atMs<=q.atMs);
      const e=100*us.reduce((s,u)=>s+(u.priced?u.usd:0),0)/comparisonUsd;
      const a=q.usedPercent-base.usedPercent;
      points.push({ at:iso(q.atMs), value: e>0 && a>=0 && us.every((u)=>u.priced) ? (a/e-1)*100 : null });
    }
  }
  if (selectedUsage.some((u)=>!u.priced)) errors.push({code:"price_missing",stage:"pricing"});
  const allowancePoints=new Map();
  for(const q of observations)allowancePoints.set(`${Math.floor(q.atMs/WORKLOAD_POLICY.bucketMs)}:${q.resetKey}`,q);
  const allowanceRows=[...allowancePoints.values()].sort((a,b)=>a.atMs-b.atMs);
  const groupedErrors=new Map();
  for(const error of errors){const key=`${error.stage}:${error.code}`,prior=groupedErrors.get(key);
    groupedErrors.set(key,{...error,count:(prior?.count??0)+(error.count??1)});}
  return { schemaVersion:"overview-workload-v1", policyVersion:WORKLOAD_POLICY.version,
    generatedAt:iso(nowMs), timeZone, status:errors.length?"partial":"available", errors:[...groupedErrors.values()],
    allowance:{ remainingPercent, observedAt:latest?iso(latest.atMs):null,
      points:allowanceRows.map((q,i)=>({at:iso(q.atMs),remainingPercent:q.conflict?null:100-q.usedPercent,
        breakBefore:i===0||q.resetKey!==allowanceRows[i-1].resetKey||q.atMs-allowanceRows[i-1].atMs>15*MINUTE})) },
    workHours, classification:{ centers, version:WORKLOAD_POLICY.version }, daily, current,
    comparison:{anchorMs:base?.atMs??anchor,capacityUsd:comparisonUsd,points},
    coverage:{workMs:lengthMs(intervals,fromMs,nowMs),actualWorkMs,actualPp,activeTasks:work.active,unresolvedTasks:work.unresolved} };
}
