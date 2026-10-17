// Closed derived contract. No provider parsing or independent accounting here.
const REASONS = new Set([null,'reset_boundary','quota_conflict','plan_conflict','missing_usage',
  'unpriced','usage_attribution_unresolved','review_origin_unresolved','pricing_change','awaiting_change']);
const KEYS = ['startMs','endMs','planType','segment','quotaPp','apiUsd','weeklyUsd','reason',
  'usageEvents','unknownSpeedEvents','excludedReviewEvents','excludedReviewUsd','priceCardIds'];
export const SIGMAS = Object.freeze([0,15,30,60,120,240]);
const failure = code => Object.assign(new Error(code),{code});
export function validateWeeklyApiIntervals(value) {
  if(!value || Object.keys(value).sort().join()!==['schemaVersion','status','reason','generatedAt','sourceGeneration','sourceFingerprint','rows'].sort().join()
    ||value.schemaVersion!=='weekly-api-interval-v1'||!Array.isArray(value.rows)||value.rows.length>100_000)throw failure('weekly_api_validation_failed');
  if(value.status==='unavailable'){
    if(typeof value.reason!=='string'||!/^weekly_api_[a-z_]{1,64}$/.test(value.reason)||value.generatedAt!==null
      ||value.sourceGeneration!==null||value.sourceFingerprint!==null||value.rows.length)throw failure('weekly_api_validation_failed');
    return value;
  }
  if(value.status!=='available'||value.reason!==null||typeof value.generatedAt!=='string'
    ||!Number.isFinite(Date.parse(value.generatedAt))||new Date(value.generatedAt).toISOString()!==value.generatedAt
    ||typeof value.sourceGeneration!=='string'||!/^[1-9][0-9]{0,19}$/.test(value.sourceGeneration)
    ||typeof value.sourceFingerprint!=='string'||!/^generation-v2-[a-f0-9]{64}$/.test(value.sourceFingerprint))throw failure('weekly_api_validation_failed');
  let last=-Infinity;const ends=new Map();
  for(const r of value.rows){
    if(!r||Object.keys(r).sort().join()!==[...KEYS].sort().join()||!Number.isSafeInteger(r.startMs)||!Number.isSafeInteger(r.endMs)
      ||r.startMs<last||r.endMs<=r.startMs||r.endMs>Date.parse(value.generatedAt)
      ||!Number.isFinite(new Date(r.startMs).getTime())||!Number.isFinite(new Date(r.endMs).getTime())
      ||!(r.quotaPp===null||(Number.isFinite(r.quotaPp)&&r.quotaPp>=0&&r.quotaPp<=100))
      ||typeof r.planType!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(r.planType)||r.planType==='unknown'
      ||r.startMs<(ends.get(r.planType)??-Infinity)||!REASONS.has(r.reason)
      ||![r.segment,r.usageEvents,r.unknownSpeedEvents,r.excludedReviewEvents].every(n=>Number.isSafeInteger(n)&&n>=0)
      ||r.unknownSpeedEvents>r.usageEvents
      ||![r.apiUsd,...(r.excludedReviewUsd===null?[]:[r.excludedReviewUsd])].every(n=>typeof n==='string'&&/^\d+(?:\.\d{1,20})?$/.test(n)&&Number.isFinite(Number(n)))
      ||!Array.isArray(r.priceCardIds)||r.priceCardIds.length>256||!r.priceCardIds.every(s=>typeof s==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(s))
      ||(r.reason===null?!(Number.isFinite(r.quotaPp)&&r.quotaPp>0&&r.quotaPp<=100&&Number.isFinite(r.weeklyUsd)&&r.weeklyUsd>=0
        &&Math.abs(r.weeklyUsd-Number(r.apiUsd)/(r.quotaPp/100))<=1e-10*Math.max(1,r.weeklyUsd)):r.weeklyUsd!==null))throw failure('weekly_api_validation_failed');
    ends.set(r.planType,r.endMs);last=r.startMs;
  }
  return value;
}
export function normalizeWeeklyApiIntervals(value) {
  if(value===undefined)return {status:'unavailable',reason:'weekly_api_intervals_unavailable',rows:[]};
  try{return validateWeeklyApiIntervals(value);}catch(error){return {status:'unavailable',reason:error.code,rows:[]};}
}

// Integrate the CDF difference directly: subtracting two approximate CDFs
// loses short intervals, especially across zero. Eight-point Gauss-Legendre
// panels of at most 0.5 sigma retain positive weights without cancellation.
// The common normalizing constant cancels in the weighted mean. Eight-sigma
// support omits <1.3e-15 probability before segment-edge renormalization.
const NODES=[.1834346424956498,.5255324099163290,.7966664774136267,.9602898564975363];
const WEIGHTS=[.3626837833783620,.3137066458778873,.2223810344533745,.1012285362903763];
function mass(a,b){
  const panels=Math.max(1,Math.ceil((b-a)/.5)),step=(b-a)/panels,half=step/2;
  let value=0;
  for(let i=0;i<panels;i++){
    const mid=a+(i+.5)*step;
    for(let j=0;j<NODES.length;j++){
      const left=mid-half*NODES[j],right=mid+half*NODES[j];
      value+=half*WEIGHTS[j]*(Math.exp(-left*left/2)+Math.exp(-right*right/2));
    }
  }
  return value;
}
export function intervalAt(rows,at){
  let lo=0,hi=rows.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(rows[mid].endMs<=at)lo=mid+1;else hi=mid;}
  const row=rows[lo]??(at===rows.at(-1)?.endMs?rows.at(-1):null);
  return row&&at>=row.startMs&&at<=row.endMs?row:null;
}
export function createWeeklyApiSmoother(rows){
  const segments=new Map();let previous=null;
  for(const row of rows){
    if(!Number.isFinite(row.startMs)||!Number.isFinite(row.endMs)||row.endMs<=row.startMs
      ||(previous&&row.startMs<previous.endMs))throw failure('weekly_api_smoothing_invalid');
    if(row.reason===null){
      if(!Number.isFinite(row.weeklyUsd)||row.weeklyUsd<0)throw failure('weekly_api_smoothing_invalid');
      const list=segments.get(row.segment)??[];
      if(list.length&&list.at(-1).endMs!==row.startMs)throw failure('weekly_api_smoothing_invalid');
      list.push(row);segments.set(row.segment,list);
    }
    previous=row;
  }
  return (at,sigmaMinutes)=>{
    if(!SIGMAS.includes(sigmaMinutes)||!Number.isFinite(at))throw failure('weekly_api_smoothing_invalid');
    const selected=intervalAt(rows,at);
    if(!selected||selected.reason!==null)return null;
    if(sigmaMinutes===0)return selected.weeklyUsd;
    const sigma=sigmaMinutes*60_000,list=segments.get(selected.segment);
    let lo=0,hi=list.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(list[mid].endMs<at-8*sigma)lo=mid+1;else hi=mid;}
    let weight=0,sum=0;
    for(let i=lo;i<list.length&&list[i].startMs<at+8*sigma;i++){
      const r=list[i],w=mass(Math.max(-8,(r.startMs-at)/sigma),Math.min(8,(r.endMs-at)/sigma));
      weight+=w;sum+=w*r.weeklyUsd;
    }
    if(!(weight>0)||!Number.isFinite(sum))throw failure('weekly_api_smoothing_failed');
    return sum/weight;
  };
}
export function weeklyApiDomain(period,endMs,startMs){
  const duration={'24h':86_400_000,'7d':7*86_400_000,'30d':30*86_400_000}[period];
  return {start:duration?endMs-duration:Math.min(startMs,endMs-1),end:endMs};
}
