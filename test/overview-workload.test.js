import test from "node:test";
import assert from "node:assert/strict";
import {analyzeWorkload,clusterWorkload,taskWorkIntervals,unionWorkIntervals} from "@app-usagemonitor/quota-analysis";
import {codexWorkLifecycle} from "../src/providers/codex/logs.js";
const M=60000,nowMs=Date.parse("2026-10-15T12:00:00Z");
const event=(kind,atMs,extra={})=>({key:"task",session:"session",kind,atMs,...extra});
const planQuota=(minutes,usedPercent,planType,extra={})=>({atMs:nowMs-minutes*M,usedPercent,planType,
  limitId:'codex',resetAtMs:nowMs+10080*M,resetKey:`original-${planType}`,...extra});

function recentWindowFixture(){
  const start=nowMs-240*M;
  return {nowMs,liveSinceMs:start,sourceFresh:true,capacity:{usd:100,availableAtMs:start},
    quota:[planQuota(120,20,'pro'),planQuota(60,30,'pro'),planQuota(30,32,'pro'),planQuota(0,34,'pro')],events:[
      event('start',start,{key:'training'}),event('complete',nowMs-60*M,{key:'training'}),
      event('start',nowMs-15*M,{key:'recent'})],
    usage:[...Array.from({length:36},(_,i)=>({atMs:start+(i+1)*5*M,session:'session',usd:i<12?1:i<24?2:3,priced:true})),
      ...[[-10,1/6],[-5,1/6],[0,3]].map(([minutes,usd])=>({atMs:nowMs+minutes*M,session:'session',usd,priced:true}))]};
}

test('fifteen-minute API intensity and sixty-minute quota trend use separate observed units',()=>{
  const input=recentWindowFixture(),before=structuredClone(input),v=analyzeWorkload(input);
  assert.equal(v.current.windowMinutes,15);assert.equal(v.trend.windowMinutes,60);
  assert.ok(Math.abs(v.current.usdPerHour-40/3)<1e-10);
  assert.ok(Math.abs(v.current.ratePpPerHour-v.current.usdPerHour)<1e-10);
  assert.equal(v.trend.ratePpPerHour,4);assert.equal(v.trend.coveredMinutes,60);
  assert.equal(v.current.level,'light');assert.equal(v.trend.state,'available');
  assert.equal(v.current.hours,66/v.current.ratePpPerHour);assert.deepEqual(input,before);
  assert.deepEqual(analyzeWorkload({...input,usage:input.usage.toReversed(),events:input.events.toReversed()}),v);
  assertConserved(v);
});

test('quota trend converts observed points through current capacity and shares API workload cuts',()=>{
  const input=recentWindowFixture(),before=structuredClone(input);
  for(const [usd,level] of [[100,'light'],[600,'medium'],[1000,'heavy']]){
    const v=analyzeWorkload({...input,capacity:{usd,availableAtMs:nowMs}});
    assert.equal(v.trend.ratePpPerHour,4);
    assert.equal(v.trend.usdPerHour,4*usd/100);assert.equal(v.trend.level,level);
    assert.equal(v.trend.coveredMinutes,60);
  }
  assert.deepEqual(input,before);
  const noModel=analyzeWorkload({...input,events:[],usage:[]});
  assert.equal(noModel.trend.usdPerHour,4);assert.equal(noModel.trend.level,'unclassified');
});

test('missing, future, nonpositive or overflowing capacity never fabricates a trend grade',()=>{
  const input=recentWindowFixture();
  for(const capacity of [null,{usd:0,availableAtMs:nowMs},{usd:-1,availableAtMs:nowMs},
    {usd:Infinity,availableAtMs:nowMs},{usd:100,availableAtMs:nowMs+1},{usd:100},
    {usd:1e308,availableAtMs:nowMs},{usd:Number.MIN_VALUE,availableAtMs:nowMs}]){
    const trend=analyzeWorkload({...input,capacity}).trend;
    assert.equal(trend.ratePpPerHour,4);assert.equal(trend.usdPerHour,null);assert.equal(trend.level,null);
  }
  const stale=analyzeWorkload({...input,sourceFresh:false}).trend;
  assert.equal(stale.usdPerHour,null);assert.equal(stale.level,null);
});

test('account switch retains the observed quota suffix but refuses the previous account capacity',()=>{
  const input=recentWindowFixture();input.quota=[planQuota(60,40,'pro',{accountKey:'synthetic-a'}),
    planQuota(20,10,'pro',{accountKey:'synthetic-b'}),planQuota(0,12,'pro',{accountKey:'synthetic-b'})];
  const old=analyzeWorkload(input).trend;
  assert.equal(old.ratePpPerHour,6);assert.equal(old.usdPerHour,null);assert.equal(old.level,null);
  const current=analyzeWorkload({...input,capacity:{usd:100,availableAtMs:nowMs-20*M}}).trend;
  assert.equal(current.usdPerHour,6);assert.equal(current.level,'light');
});

test('window receipts are start-exclusive, end-inclusive and cannot look into the future',()=>{
  const input=recentWindowFixture();input.usage=[
    {atMs:nowMs-15*M,usd:100,priced:true}, {atMs:nowMs-5*M,usd:2,priced:true},
    {atMs:nowMs,usd:1,priced:true},{atMs:nowMs+M,usd:999,priced:true}];
  const v=analyzeWorkload(input);assert.equal(v.current.ratePpPerHour,12);assert.equal(v.trend.ratePpPerHour,4);
  const prefix=analyzeWorkload({...input,usage:input.usage.slice(0,-1)});
  assert.deepEqual(v,prefix);
});

test('pricing and work gaps invalidate API intensity without suppressing independent quota evidence',()=>{
  const input=recentWindowFixture();input.usage.at(-3).priced=false;input.usage.at(-3).usd=null;
  const v=analyzeWorkload(input);assert.equal(v.current.ratePpPerHour,null);assert.equal(v.trend.ratePpPerHour,4);
  assert.ok(v.errors.some(e=>e.code==='price_missing'));
  const covered=analyzeWorkload({...recentWindowFixture(),usageCoverageFromMs:nowMs-10*M});
  assert.equal(covered.current.state,'unknown');assert.equal(covered.trend.state,'available');
  const stale=analyzeWorkload({...recentWindowFixture(),sourceFresh:false});
  for(const x of [stale.current,stale.trend])assert.deepEqual([x.state,x.ratePpPerHour],['unknown',null]);
});

test('recent receipts persist in their window and absence never invents a zero rate',()=>{
  const input=recentWindowFixture();input.events.push(event('complete',nowMs,{key:'recent'}));
  const current=analyzeWorkload(input);assert.equal(current.coverage.activeTasks,0);
  assert.equal(current.current.level,'light');assert.equal(current.trend.state,'available');
  const tail=analyzeWorkload({...input,nowMs:nowMs+14*M});
  assert.equal(tail.current.state,'available');assert.equal(tail.trend.state,'available');
  const idle=analyzeWorkload({...input,nowMs:nowMs+16*M});
  assert.equal(idle.current.state,'unknown');assert.equal(idle.current.usdPerHour,null);assert.equal(idle.trend.state,'available');
  assert.equal(analyzeWorkload({...input,nowMs:nowMs+61*M}).trend.state,'unknown');
});

test('elapsed API intensity ignores task duration and retains plan-era capacity guards',()=>{
  const input=recentWindowFixture(),original=analyzeWorkload(input);
  input.events.push(event('start',nowMs-5*M,{key:'parallel',session:'other'}));
  const parallel=analyzeWorkload(input);
  assert.deepEqual(parallel.current,original.current);assert.deepEqual(parallel.trend,original.trend);
  const short=analyzeWorkload({...input,events:[event('start',nowMs-30_000)],usage:[{atMs:nowMs,usd:3,priced:true}]});
  assert.deepEqual([short.current.level,short.current.ratePpPerHour,short.current.hours],['unclassified',12,5.5]);
  assert.equal(short.trend.ratePpPerHour,4);
  const transitioned=analyzeWorkload({...recentWindowFixture(),estimationPlanType:'pro',quota:[planQuota(10,34,'pro')]});
  assert.equal(transitioned.current.ratePpPerHour,null);assert.equal(transitioned.trend.ratePpPerHour,null);
  assert.ok(transitioned.current.usdPerHour>0);
});

test('equal window intensities share their grade without a minimum task-duration floor',()=>{
  const input=recentWindowFixture();for(const u of input.usage.slice(-3))u.usd=3;
  const equal=analyzeWorkload(input);assert.equal(equal.current.ratePpPerHour,36);assert.equal(equal.trend.ratePpPerHour,4);
  assert.equal(equal.current.level,'heavy');
  for(const ms of [59_999,60_000]){
    const v=analyzeWorkload({...input,events:[event('start',nowMs-ms)],usage:[{atMs:nowMs,usd:1,priced:true}]});
    assert.equal(v.current.ratePpPerHour,4);
    assert.equal(v.trend.ratePpPerHour,4);
  }
});

test('priced receipts need no lifecycle evidence for elapsed intensity',()=>{
  const v=analyzeWorkload({...recentWindowFixture(),events:[]});
  assert.deepEqual([v.current.state,v.current.level],['available','light']);assert.ok(Math.abs(v.current.ratePpPerHour-40/3)<1e-10);
  assert.equal(v.trend.ratePpPerHour,4);
});

test('elapsed classification and recent rates are independent of orphan and conflicting work boundaries',()=>{
  const input=recentWindowFixture(),baseline=analyzeWorkload(input);
  assert.deepEqual(baseline.recentClassification.centers,[(4*12+40/3)/5,24,36]);
  for(const events of [[],[event('start',nowMs-86400000,{session:'orphan'})],
    [event('start',nowMs-10*M),event('start',nowMs-9*M),event('complete',nowMs)]]){
    const v=analyzeWorkload({...input,events});
    assert.deepEqual(v.current,baseline.current);assert.deepEqual(v.trend,baseline.trend);
    assert.deepEqual(v.recentClassification,baseline.recentClassification);
  }
});

test('absent receipts, explicit zero, invalid prices and arithmetic overflow remain distinct',()=>{
  const input=recentWindowFixture(),history=input.usage.filter(u=>u.atMs<=nowMs-15*M);
  for(const [usd,priced,expected] of [[0,true,0],[1,true,4],[null,false,null],[-1,true,null],
    [Infinity,true,null],[NaN,true,null],[Number.MAX_VALUE,true,null]]){
    const v=analyzeWorkload({...input,quota:[],usage:[...history,{atMs:nowMs,usd,priced}]});
    assert.equal(v.current.usdPerHour,expected);
    assert.equal(v.current.state,expected===null?'unknown':'available');
    if(expected===null)assert.equal(v.current.level,null);
  }
  const absent=analyzeWorkload({...input,usage:history});
  assert.equal(absent.current.usdPerHour,null);assert.equal(absent.current.state,'unknown');
});

test('elapsed training excludes incomplete and unpriced samples and cannot borrow a task classifier',()=>{
  const input=recentWindowFixture();
  const sparse=analyzeWorkload({...input,usageCoverageFromMs:nowMs-45*M});
  assert.ok(sparse.current.usdPerHour>0);assert.equal(sparse.current.level,'unclassified');
  assert.equal(sparse.recentClassification.centers,null);
  const unpriced=input.usage.map((u,i)=>({...u,...(i<36&&i%3===0?{priced:false,usd:null}:{})}));
  const v=analyzeWorkload({...input,usage:unpriced});
  assert.ok(v.current.usdPerHour>0);assert.equal(v.current.level,'unclassified');
  assert.equal(v.recentClassification.centers,null);
});

test('elapsed sums and fitted grades are deterministic for equal timestamps and do not mutate inputs',()=>{
  const input=recentWindowFixture();input.usage.push(...[1e14,0.01,0.02].map(usd=>({atMs:nowMs,usd,priced:true})));
  const before=structuredClone(input),v=analyzeWorkload(input);
  const reversed=analyzeWorkload({...input,usage:input.usage.toReversed()});
  assert.deepEqual(v.current,reversed.current);assert.deepEqual(v.recentClassification,reversed.recentClassification);
  assert.deepEqual(input,before);
});

test('quota trend uses a shorter observed span without API costs, future data or edge proration',()=>{
  const input={nowMs,sourceFresh:true,quota:[planQuota(20,4,'pro'),planQuota(0,6,'unknown')]};
  const before=structuredClone(input),v=analyzeWorkload(input);
  assert.equal(v.trend.ratePpPerHour,6);assert.equal(v.trend.coveredMinutes,20);assert.equal(v.trend.inferred,true);
  assert.deepEqual(input,before);
  assert.deepEqual(analyzeWorkload({...input,quota:[...input.quota,...input.quota].toReversed()}).trend,v.trend);
  assert.deepEqual(analyzeWorkload({...input,quota:[...input.quota,planQuota(-1,90,'plus')]}).trend,v.trend);
  assert.equal(analyzeWorkload({...input,quota:[planQuota(61,4,'pro'),planQuota(0,6,'pro')]}).trend.ratePpPerHour,null);
  assert.equal(analyzeWorkload({...input,quota:[planQuota(60,4,'pro'),planQuota(0,6,'pro')]}).trend.ratePpPerHour,2);
});

test('unchanged quota is unknown and recovery starts the current trend baseline',()=>{
  const input={nowMs,sourceFresh:true};
  assert.equal(analyzeWorkload({...input,quota:[planQuota(60,4,'pro'),planQuota(0,4,'pro')]}).trend.ratePpPerHour,null);
  const v=analyzeWorkload({...input,quota:[planQuota(60,4,'pro'),planQuota(40,6,'pro'),planQuota(20,5,'pro'),planQuota(0,6,'pro')]});
  assert.equal(v.trend.ratePpPerHour,3);assert.equal(v.trend.coveredMinutes,20);
  assert.equal(v.adjustments.quotaStaleObservations,0);
});

test('quota trend uses only the current plan, account and reset suffix and preserves concrete conflicts',()=>{
  const input={nowMs,sourceFresh:true};
  const switched=analyzeWorkload({...input,quota:[planQuota(60,40,'prolite'),planQuota(30,0,'pro'),planQuota(0,2,'pro')]});
  assert.equal(switched.trend.ratePpPerHour,4);assert.equal(switched.trend.coveredMinutes,30);
  const changed=analyzeWorkload({...input,quota:[planQuota(60,40,'pro',{accountKey:'synthetic-a'}),
    planQuota(20,10,'pro',{accountKey:'synthetic-b'}),planQuota(0,12,'pro',{accountKey:'synthetic-b'})]});
  assert.equal(changed.trend.ratePpPerHour,6);assert.doesNotMatch(JSON.stringify(changed),/synthetic-[ab]/);
  const quota=[planQuota(60,4,'pro'),planQuota(20,6,'pro'),planQuota(20,8,'pro'),planQuota(10,8,'pro'),planQuota(0,9,'pro')];
  const conflict=analyzeWorkload({...input,quota});
  assert.equal(conflict.trend.ratePpPerHour,6);assert.equal(conflict.trend.coveredMinutes,10);
  assert.ok(conflict.errors.some(e=>e.code==='quota_observation_conflict'));
  const ended=analyzeWorkload({...input,quota:[...quota,planQuota(0,10,'pro')]});
  assert.equal(ended.trend.ratePpPerHour,null);assert.ok(ended.errors.some(e=>e.code==='quota_observation_conflict'));
  const expiry=nowMs-30*M,next=expiry+7*1440*M;
  const renewal=analyzeWorkload({...input,quota:[planQuota(60,90,'pro',{resetAtMs:expiry}),
    planQuota(30,0,'pro',{resetAtMs:next}),planQuota(0,2,'pro',{resetAtMs:next})]});
  assert.equal(renewal.trend.ratePpPerHour,4);
  const ambiguous=analyzeWorkload({...input,quota:[planQuota(60,4,'pro'),planQuota(0,6,'pro',{resetAtMs:next})]});
  assert.equal(ambiguous.trend.ratePpPerHour,null);assert.ok(ambiguous.errors.some(e=>e.code==='quota_reset_ambiguous'));
});

const sumDaily=v=>v.daily.reduce((s,d)=>s+d.light+d.medium+d.heavy+d.unclassified,0);
function assertConserved(v){for(const p of v.segmentation.plans)
  assert.ok(Math.abs(p.observedPp-p.dailyPp-p.outsidePp-p.unallocatedPp)<1e-8,JSON.stringify(p));}

test('equal balances retain the first-change anchor, freshness and closed work time only',()=>{
  const quota=[planQuota(60,10,'pro'),planQuota(51,10,'pro'),planQuota(50,12,'pro'),planQuota(0,12,'pro')];
  const input={nowMs,quota,usage:[{atMs:nowMs-55*M,usd:1,priced:true,session:'session'}],
    events:[event('start',nowMs-60*M),event('complete',nowMs)]};
  const before=structuredClone(input),v=analyzeWorkload(input);
  assert.deepEqual(input,before);assert.equal(sumDaily(v),2);assertConserved(v);
  assert.equal(v.coverage.estimationWorkMs,10*M);assert.equal(v.workHours.at(-1).ratePpPerHour,12);
  assert.equal(v.segmentation.pendingSince,new Date(nowMs-50*M).toISOString());
  assert.equal(v.allowance.observedAt,new Date(nowMs).toISOString());
  assert.deepEqual(analyzeWorkload({...input,quota:[...quota,...quota].toReversed()}),v);
  const closed=analyzeWorkload({...input,quota:[...quota,planQuota(0,13,'pro')].filter(q=>q!==quota.at(-1))});
  assert.equal(closed.coverage.estimationWorkMs,60*M);assert.equal(sumDaily(closed),3);assertConserved(closed);
});

test('history shares anchored deadline jitter, renewal, retired-cycle and explicit reset rules',()=>{
  const day=1440*M,old=nowMs-2*day;
  const q=(atMs,usedPercent,resetAtMs)=>({atMs,usedPercent,resetAtMs,planType:'pro',limitId:'codex',resetKey:String(resetAtMs)});
  const quota=[q(old-60*M,10,old),q(old-30*M,10,old+1000),q(old-M,12,old),
    q(old+M,2,old+7*day),q(old+2*M,99,old),q(nowMs,3,old+7*day+1000)];
  const v=analyzeWorkload({nowMs,quota});assert.equal(v.segmentation.plans[0].observedPp,3);assertConserved(v);
  assert.equal(v.adjustments.quotaStaleObservations,1);
  const chained=analyzeWorkload({nowMs,quota:[q(nowMs-20*M,10,nowMs+day),
    q(nowMs-10*M,11,nowMs+day+4*M),q(nowMs,12,nowMs+day+8*M)]});
  assert.equal(sumDaily(chained),1);assert.ok(chained.errors.some(e=>e.code==='quota_reset_ambiguous'));
  const t=nowMs-10*M,reset={schemaVersion:'quota-reset-event-v0.1',kind:'unknown_reset',
    reason:'confirmed_unscheduled_quota_drop',precision:'observation_interval',provider:'openai_codex',
    planType:'pro',limitId:'codex',windowDurationMins:10080,occurredAt:new Date(t).toISOString(),
    observedAt:new Date(t).toISOString(),intervalStartedAt:new Date(nowMs-20*M).toISOString()};
  const early=analyzeWorkload({nowMs,quota:[q(nowMs-20*M,80,nowMs+day),q(t,0,t+7*day),q(nowMs,2,t+7*day)],quotaResetEvents:[reset]});
  assert.equal(sumDaily(early),2);assert.ok(!early.errors.some(e=>e.code==='quota_reset_ambiguous'));assertConserved(early);
});

test('conflicting simultaneous readings cut history and are input-order independent',()=>{
  const quota=[planQuota(30,10,'pro'),planQuota(20,11,'pro'),planQuota(20,12,'pro'),planQuota(10,13,'pro'),planQuota(0,14,'pro')];
  const a=analyzeWorkload({nowMs,quota}),b=analyzeWorkload({nowMs,quota:quota.toReversed()});
  assert.equal(sumDaily(a),1);assert.deepEqual(a,b);assert.ok(a.errors.some(e=>e.code==='quota_observation_conflict'));assertConserved(a);
});

test('cross-day gaps and incomplete pricing preserve consumption separately from daily bars',()=>{
  const end=Date.parse('2026-11-01T09:30:00Z'),start=Date.parse('2026-11-01T06:30:00Z');
  const quota=[{atMs:start,usedPercent:10,resetKey:'r'},{atMs:end,usedPercent:13,resetKey:'r'}];
  const input={nowMs:end,timeZone:'America/Los_Angeles',quota};
  const missing=analyzeWorkload(input);assert.equal(sumDaily(missing),0);assert.equal(missing.unallocated.totalIntervals,1);
  assert.equal(missing.unallocated.records[0].reason,'usage_missing');assertConserved(missing);
  const partial=analyzeWorkload({...input,usage:[{atMs:start+M,usd:1,priced:true},{atMs:end,usd:null,priced:false}]});
  assert.equal(sumDaily(partial),0);assert.equal(partial.unallocated.plans[0].pp,3);
  assert.equal(partial.unallocated.records[0].reason,'price_missing');assertConserved(partial);
  const full=analyzeWorkload({...input,usage:[{atMs:start+M,usd:1,priced:true},{atMs:end,usd:2,priced:true}]});
  assert.equal(full.daily.find(d=>d.date==='2026-10-31').unclassified,1);
  assert.equal(full.daily.find(d=>d.date==='2026-11-01').unclassified,2);
  assert.equal(full.unallocated.totalIntervals,0);assertConserved(full);
  const sameDay=analyzeWorkload({...input,timeZone:'UTC'});assert.equal(sumDaily(sameDay),3);assert.equal(sameDay.unallocated.totalIntervals,0);
});

test('complete interval denominators include usage outside the display and reject incomplete history',()=>{
  const end=Date.parse('2026-10-21T12:00:00Z'),start=end-8*1440*M;
  const input={nowMs:end,quota:[{atMs:start,usedPercent:10,resetKey:'r'},{atMs:end,usedPercent:18,resetKey:'r'}],
    usage:[{atMs:start+M,usd:3,priced:true},{atMs:end,usd:1,priced:true}],
    events:[event('start',start),event('complete',end)]};
  const v=analyzeWorkload(input);assert.equal(sumDaily(v),2);assert.equal(v.segmentation.plans[0].outsidePp,6);assertConserved(v);
  const partial=analyzeWorkload({...input,usageCoverageFromMs:start+M});
  assert.equal(sumDaily(partial),0);assert.equal(partial.unallocated.plans[0].pp,8);
  assert.equal(partial.unallocated.records[0].reason,'history_incomplete');assert.equal(partial.coverage.estimationPp,0);
  assert.ok(partial.errors.some(e=>e.code==='workload_history_incomplete'));assertConserved(partial);
});

test('cross-month unallocated intervals aggregate without pooling plans',()=>{
  const end=Date.parse('2026-11-03T12:00:00Z');
  const quota=Array.from({length:7},(_,i)=>({atMs:end-(7-i)*1440*M,usedPercent:i,
    resetKey:i<4?'old':'new',planType:i<4?'prolite':'pro'}));
  const v=analyzeWorkload({nowMs:end,quota});
  assert.equal(v.unallocated.totalIntervals,5);assert.equal(sumDaily(v),0);
  assert.deepEqual(v.unallocated.plans,[{planType:'prolite',pp:3,intervals:3},{planType:'pro',pp:2,intervals:2}]);
  assert.equal(v.unallocated.records.length,5);assertConserved(v);
});

test('conflicting task boundaries do not inflate the composite rate of other work',()=>{
  const events=[event('start',nowMs-30*M),event('start',nowMs-25*M),event('complete',nowMs),
    event('start',nowMs-30*M,{key:'other'}),event('complete',nowMs,{key:'other'})];
  const v=analyzeWorkload({nowMs,events,quota:[planQuota(30,10,'pro'),planQuota(0,12,'pro')]});
  assert.equal(sumDaily(v),2);assert.equal(v.coverage.estimationPp,0);assert.equal(v.workHours.at(-1).hours,null);
  assert.ok(v.errors.some(e=>e.code==='work_boundary_conflict'));assertConserved(v);
});

test('plan periods recover old-plan history and mark inference without borrowing old rates',()=>{
  const quota=[planQuota(120,20,'prolite'),planQuota(90,25,'unknown'),planQuota(61,30,'prolite'),
    planQuota(60,0,'pro'),planQuota(0,2,'unknown')],before=structuredClone(quota);
  const input={nowMs,quota,estimationPlanType:'pro',events:[event('start',nowMs-120*M),event('complete',nowMs)]};
  const v=analyzeWorkload(input),daily=v.daily.at(-1);
  assert.deepEqual(quota,before);assert.equal(v.schemaVersion,'overview-workload-v9');
  assert.equal(daily.plans.find(p=>p.planType==='prolite').unclassified,10);
  assert.equal(daily.plans.find(p=>p.planType==='pro').unclassified,2);
  assert.ok(daily.plans.every(p=>p.inferred));assert.equal(v.planAttribution.inferredObservations,2);
  assert.equal(v.coverage.actualPp,12);assert.equal(v.coverage.estimationPp,2);
  assert.equal(v.coverage.estimationWorkMs,60*M);assert.equal(v.workHours.at(-1).hours,49);
  assert.equal(v.workHours.at(-1).inferred,true);
  assert.deepEqual(analyzeWorkload({...input,quota:quota.toReversed()}).daily,v.daily);
});

test('unknown observations never backfill the first anchor or cross conflicting labels',()=>{
  const v=analyzeWorkload({nowMs,quota:[planQuota(60,10,'unknown'),planQuota(50,11,'prolite'),
    planQuota(40,12,'prolite'),planQuota(30,13,'prolite'),planQuota(30,13,'pro'),planQuota(20,14,'unknown'),
    planQuota(10,15,'pro'),planQuota(0,16,'unknown')]});
  assert.equal(v.planAttribution.unresolvedObservations,3);
  assert.equal(v.daily.at(-1).unclassified,2);
  assert.ok(v.errors.some(e=>e.code==='quota_observation_conflict'));
});

test('explicit account changes break inference and same-plan estimation continuity',()=>{
  const v=analyzeWorkload({nowMs,events:[event('start',nowMs-120*M),event('complete',nowMs)],quota:[
    planQuota(120,10,'pro',{accountKey:'private-account-a'}),planQuota(60,30,'pro',{accountKey:'private-account-a'}),
    planQuota(50,31,'unknown',{accountKey:'private-account-b'}),planQuota(40,0,'pro',{accountKey:'private-account-b'}),
    planQuota(0,2,'pro',{accountKey:'private-account-b'})]});
  assert.equal(v.planAttribution.unresolvedObservations,1);assert.equal(v.coverage.estimationPp,2);
  assert.equal(v.coverage.estimationWorkMs,40*M);assert.doesNotMatch(JSON.stringify(v),/private-account/);
});

test('returning to a previous plan starts a new rate sample period',()=>{
  const v=analyzeWorkload({nowMs,estimationPlanType:'prolite',events:[event('start',nowMs-180*M),event('complete',nowMs)],
    quota:[planQuota(180,0,'prolite'),planQuota(125,40,'prolite'),planQuota(120,0,'pro'),planQuota(65,2,'pro'),
      planQuota(60,0,'prolite'),planQuota(0,3,'prolite')]});
  assert.equal(v.coverage.actualPp,45);assert.equal(v.coverage.estimationPp,3);
  assert.equal(v.workHours.at(-1).ratePpPerHour,3);assert.equal(v.workHours.at(-1).hours,97/3);
});

test('a new plan cannot borrow historical hours or a trend rate crossing its boundary',()=>{
  const v=analyzeWorkload({nowMs,estimationPlanType:'pro',sourceFresh:true,liveSinceMs:nowMs-120*M,
    events:[event('start',nowMs-120*M)],usage:[{session:'session',atMs:nowMs-M,priced:true,usd:1}],
    capacity:{usd:100,availableAtMs:nowMs-120*M},quota:[planQuota(120,10,'prolite'),planQuota(30,40,'prolite'),planQuota(5,0,'pro')]});
  assert.ok(v.workHours.every(r=>r.hours===null));assert.equal(v.trend.ratePpPerHour,null);
  assert.equal(v.current.ratePpPerHour,null);assert.equal(v.current.usdPerHour,4);
});

test('an explicit label wins over its identical unknown duplicate regardless of input order',()=>{
  const quota=[planQuota(10,0,'pro'),planQuota(0,1,'unknown'),planQuota(0,1,'pro')];
  for(const values of[quota,quota.toReversed()]){
    const v=analyzeWorkload({nowMs,quota:values});
    assert.equal(v.planAttribution.inferredObservations,0);assert.equal(v.daily.at(-1).inferred,false);
    assert.equal(v.daily.at(-1).unclassified,1);
  }
});
test("task work includes model, tools and necessary waiting, including failed and cancelled tasks",()=>{
  for(const kind of ["complete","abort"]){
    const result=taskWorkIntervals([event("start",nowMs-10*M),event(kind,nowMs)],{nowMs});
    assert.deepEqual(result.intervals,[{startMs:nowMs-10*M,endMs:nowMs}]);
  }
});
test("parallel parent and children count once; inter-task breaks are excluded",()=>{
  assert.deepEqual(unionWorkIntervals([{startMs:0,endMs:10*M},{startMs:5*M,endMs:15*M},{startMs:45*M,endMs:50*M}],0,60*M),
    [{startMs:0,endMs:15*M},{startMs:45*M,endMs:50*M}]);
});
test("provider task duration recovers a missing start independently of inference timing",()=>{
  const result=taskWorkIntervals([event("complete",nowMs,{durationMs:10*M})],{nowMs});
  assert.equal(result.intervals[0].startMs,nowMs-10*M);
  const observed=taskWorkIntervals([event("start",nowMs-5*M),event("complete",nowMs,{durationMs:10*M})],{nowMs});
  assert.equal(observed.conflicts,0);assert.equal(observed.durationDifferences,1);
  assert.deepEqual(observed.intervals,[{startMs:nowMs-5*M,endMs:nowMs}]);
});
test("fresh open tasks with no tokens are working; old unfinished tasks do not grow forever",()=>{
  const events=[event("start",nowMs-20*M)];
  const fresh=taskWorkIntervals(events,{nowMs,liveSinceMs:nowMs-30*M,sourceFresh:true});
  assert.equal(fresh.active,1); assert.equal(fresh.intervals[0].endMs,nowMs);
  const old=taskWorkIntervals(events,{nowMs,liveSinceMs:nowMs,sourceFresh:true});
  assert.equal(old.active,0); assert.deepEqual(old.intervals,[]);
  assert.deepEqual(old.incomplete,[{startMs:nowMs-20*M,endMs:nowMs}]);
});
test('orphan tasks cannot borrow later independent session activity or become active again',()=>{
  const start=nowMs-36*60*M,next=nowMs-5*M;
  const events=[event('start',start),event('start',next,{key:'next'}),event('complete',nowMs,{key:'next'})];
  const usage=[{session:'session',atMs:start+M,usd:1,priced:true},{session:'session',atMs:nowMs-M,usd:2,priced:true}];
  for(const values of[events,events.toReversed()]){
    const input={nowMs,liveSinceMs:nowMs-10*M,sourceFresh:true,usage},before=structuredClone(input);
    const r=taskWorkIntervals(values,input);
    assert.deepEqual(r.intervals,[{startMs:next,endMs:nowMs}]);
    assert.deepEqual(r.incomplete,[{startMs:start,endMs:next}]);
    assert.equal(r.active,0);assert.equal(r.unresolved,0);assert.deepEqual(input,before);
  }
  const recent=taskWorkIntervals([event('start',start)],{nowMs,liveSinceMs:nowMs-10*M,sourceFresh:true,usage});
  assert.deepEqual(recent.intervals,[]);assert.equal(recent.active,0);assert.equal(recent.unresolved,1);
});
test('a newer context retires only orphan ownership, not a fabricated task ending',()=>{
  const events=[event('start',nowMs-20*M),event('start',nowMs-5*M,{key:'next'}),event('abort',nowMs,{key:'next'})];
  const r=taskWorkIntervals(events,{nowMs,liveSinceMs:nowMs-30*M,sourceFresh:true});
  assert.equal(r.active,0);
  assert.deepEqual(r.intervals,[{startMs:nowMs-5*M,endMs:nowMs}]);
  assert.deepEqual(r.incomplete,[{startMs:nowMs-20*M,endMs:nowMs-5*M}]);
  const ended=taskWorkIntervals([...events,event('abort',nowMs-15*M)],{nowMs});
  assert.deepEqual(unionWorkIntervals(ended.intervals,0,nowMs),[
    {startMs:nowMs-20*M,endMs:nowMs-15*M},{startMs:nowMs-5*M,endMs:nowMs}]);
  assert.deepEqual(ended.incomplete,[]);
});
test('proven parallel work qualifies union time but cannot hide explicit boundary conflicts',()=>{
  const known=[event('start',nowMs-20*M,{key:'known',session:'other'}),event('complete',nowMs,{key:'known',session:'other'})];
  const r=taskWorkIntervals([event('start',nowMs-20*M),...known],{nowMs});
  assert.deepEqual(r.incomplete,[]);
  const partial=taskWorkIntervals([event('start',nowMs-30*M),...known],{nowMs});
  assert.deepEqual(partial.incomplete,[{startMs:nowMs-30*M,endMs:nowMs-20*M}]);
  const conflicting=taskWorkIntervals([event('start',nowMs-20*M),event('start',nowMs-15*M),...known],{nowMs});
  assert.equal(conflicting.conflicts,1);assert.deepEqual(conflicting.incomplete,[{startMs:nowMs-20*M,endMs:nowMs}]);
});
test('a lineage-proven copied start cannot supersede an independent live task context',()=>{
  const events=[event('start',nowMs-30*M,{session:'parent',key:'copy'}),
    event('complete',nowMs-25*M,{session:'parent',key:'copy'}),
    event('start',nowMs-20*M,{session:'child',key:'own'}),
    event('start',nowMs-10*M,{session:'child',key:'copy',ancestors:['parent']}),
    event('complete',nowMs-5*M,{session:'child',key:'copy',ancestors:['parent']})];
  const r=taskWorkIntervals(events,{nowMs,liveSinceMs:nowMs-60*M,sourceFresh:true});
  assert.equal(r.replayed,2);assert.equal(r.active,1);assert.deepEqual(r.incomplete,[]);
  assert.deepEqual(unionWorkIntervals(r.intervals,0,nowMs),[
    {startMs:nowMs-30*M,endMs:nowMs-25*M},{startMs:nowMs-20*M,endMs:nowMs}]);
});
test("duplicates are replay safe; conflicting starts are rejected",()=>{
  const a=event("start",nowMs-10*M),b=event("complete",nowMs);
  assert.equal(taskWorkIntervals([a,a,b,b],{nowMs}).intervals.length,1);
  assert.equal(taskWorkIntervals([a,event("start",nowMs-5*M),b],{nowMs}).conflicts,1);
});
test("lineage-proven replay is removed while unrelated and differing completions remain conflicts",()=>{
  const start=event("start",nowMs-10*M),end=event("complete",nowMs-5*M,{durationMs:5*M});
  const copies=[event("start",nowMs-4*M,{session:"child",ancestors:["session"]}),
    event("complete",nowMs-4*M+1,{session:"child",ancestors:["session"],durationMs:5*M})];
  for(const events of [[start,end,...copies],[...copies,end,start]]){
    const r=taskWorkIntervals(events,{nowMs});assert.equal(r.conflicts,0);assert.equal(r.replayed,2);
    assert.deepEqual(r.intervals,[{startMs:nowMs-10*M,endMs:nowMs-5*M}]);
  }
  assert.equal(taskWorkIntervals([start,end,...copies.map(({ancestors,...e})=>e)],{nowMs}).conflicts,1);
  assert.equal(taskWorkIntervals([start,end,{...copies[1],durationMs:6*M}],{nowMs}).conflicts,1);
  const continued=taskWorkIntervals([start,copies[0],event("complete",nowMs,{session:"child",ancestors:["session"]})],{nowMs});
  assert.equal(continued.conflicts,0);assert.deepEqual(continued.intervals,[{startMs:nowMs-10*M,endMs:nowMs}]);
});
test('identical unrelated boundaries and a foreign completion cannot establish task ownership',()=>{
  const start=event('start',nowMs-10*M),end=event('complete',nowMs);
  const copies=[{...start,session:'unrelated'},{...end,session:'unrelated'}];
  for(const events of[[start,end,...copies],[...copies,end,start]]){
    const r=taskWorkIntervals(events,{nowMs});
    assert.equal(r.conflicts,1);assert.equal(r.replayed,0);assert.deepEqual(r.intervals,[]);
  }
  const foreign=taskWorkIntervals([start,{...end,session:'unrelated'}],{nowMs});
  assert.equal(foreign.conflicts,1);assert.deepEqual(foreign.intervals,[]);
  assert.deepEqual(foreign.incomplete,[{startMs:start.atMs,endMs:nowMs}]);
  const child=taskWorkIntervals([start,{...end,session:'child',ancestors:['session']}],{nowMs});
  assert.equal(child.conflicts,0);assert.deepEqual(child.intervals,[{startMs:start.atMs,endMs:nowMs}]);
});

test('completed parent timing survives nested branch aborts while own child cancellation remains work',()=>{
  const start=event('start',nowMs-20*M),end=event('complete',nowMs-10*M,{durationMs:10*M});
  const events=[start,end,
    {...start,session:'child',ancestors:['session']},event('abort',nowMs-18*M,{session:'child',ancestors:['session']}),
    {...start,session:'nested',ancestors:['child','session']},event('abort',nowMs-17*M,{session:'nested',ancestors:['child','session']}),
    event('start',nowMs-5*M,{key:'child-own',session:'child',ancestors:['session']}),
    event('abort',nowMs-M,{key:'child-own',session:'child',ancestors:['session']})];
  const before=structuredClone(events);
  for(const values of [events,events.toReversed(),[...events,...events].toReversed()]){
    const result=taskWorkIntervals(values,{nowMs});
    assert.equal(result.conflicts,0);assert.deepEqual(result.incomplete,[]);assert.equal(result.replayed,3);
    assert.deepEqual(unionWorkIntervals(result.intervals,0,nowMs),[
      {startMs:start.atMs,endMs:end.atMs},{startMs:nowMs-5*M,endMs:nowMs-M}]);
  }
  assert.deepEqual(events,before);
});

test('branch abort resolution retains ambiguous ownership, real terminal conflicts and child continuation',()=>{
  const start=event('start',nowMs-10*M),end=event('complete',nowMs,{durationMs:10*M});
  const abort=event('abort',nowMs-5*M,{session:'child',ancestors:['session']});
  const cases=[
    [start,end,{...abort,session:'session',ancestors:[]}],
    [start,end,{...abort,ancestors:[]}],
    [start,end,event('start',nowMs-9*M),abort],
    [start,end,event('complete',nowMs-M),abort],
    [start,end,{...end,session:'child',ancestors:['session'],durationMs:9*M},abort],
    [{...start,ancestors:['child']},{...end,ancestors:['child']},
      {...start,session:'child',ancestors:['session']},{...end,session:'child',ancestors:['session']},abort],
    [{...start,ancestors:['child']},{...end,ancestors:['child']},
      {...start,session:'child',ancestors:['session']},{...end,session:'child',ancestors:['session']}],
    [{...start,ancestors:['child']},{...end,ancestors:['child']},
      {...start,session:'child',ancestors:['nested']},{...end,session:'child',ancestors:['nested']},
      {...start,session:'nested',ancestors:['session']},{...end,session:'nested',ancestors:['session']}],
    [start,end,{...abort,ancestors:['session','child']}],
    [{...start,ancestors:['grandparent']},{...end,ancestors:['grandparent']},abort],
  ];
  for(const events of cases)for(const values of [events,events.toReversed()]){
    const result=taskWorkIntervals(values,{nowMs});assert.equal(result.conflicts,1);assert.deepEqual(result.intervals,[]);
  }
  for(const terminal of [abort,{...abort,kind:'complete',durationMs:5*M}]){
    const result=taskWorkIntervals([start,terminal],{nowMs});
    assert.equal(result.conflicts,0);assert.deepEqual(result.intervals,[{startMs:start.atMs,endMs:terminal.atMs}]);
  }
});

test('one ownership repair feeds current load, daily allocation and historical rate without changing quota totals',()=>{
  const input=recentWindowFixture();input.events.push(event('complete',nowMs,{key:'recent',durationMs:15*M}));
  const expected=analyzeWorkload(input),events=[...input.events,
    event('start',nowMs-15*M,{key:'recent',session:'child',ancestors:['session']}),
    event('abort',nowMs-10*M,{key:'recent',session:'child',ancestors:['session']})];
  for(const values of [events,events.toReversed()]){
    const actual=analyzeWorkload({...input,events:values});
    for(const key of ['current','trend','daily','workHours','coverage','comparison','errors'])assert.deepEqual(actual[key],expected[key],key);
    assertConserved(actual);
  }
});
test("seconds of elapsed-timer skew retain work but reversed boundaries still fail",()=>{
  const r=taskWorkIntervals([event("start",nowMs-10*M),event("complete",nowMs,{durationMs:10*M+21518})],{nowMs});
  assert.equal(r.conflicts,0);assert.equal(r.durationDifferences,1);assert.equal(r.intervals[0].startMs,nowMs-10*M);
  assert.equal(taskWorkIntervals([event("complete",nowMs-10*M),event("start",nowMs)],{nowMs}).conflicts,1);
});
test("each quota recovery starts a new consumption stage in every card",()=>{
  const q=(minutes,usedPercent,resetKey="r")=>({atMs:nowMs-minutes*M,usedPercent,resetKey});
  const input={nowMs,events:[event("start",nowMs-30*M),event("complete",nowMs)],
    quota:[q(30,10),q(25,16),q(20,10),q(15,16),q(10,15),q(5,17),q(0,16)],
    usage:[{atMs:nowMs-2*M,session:"session",usd:7,priced:true}],
    capacity:{usd:100,availableAtMs:nowMs-60*M},liveSinceMs:nowMs-30*M};
  const r=analyzeWorkload(input);
  assert.equal(r.coverage.actualPp,14);assert.equal(r.adjustments.quotaStaleObservations,0);
  assert.equal(r.daily.reduce((s,d)=>s+d.light+d.medium+d.heavy+d.unclassified,0),14);
  assert.equal(r.allowance.remainingPercent,84);assert.equal(r.allowance.observedAt,new Date(nowMs).toISOString());
  assert.equal(r.comparison.actualPp,14);assert.equal(r.comparison.expectedPp,0); // no API receipt inside a closed consumption stage
  assert.equal(r.allowance.points.at(-1).remainingPercent,84);
  assert.equal(r.allowance.points.at(-1).breakBefore,true);
  assert.deepEqual(analyzeWorkload({...input,quota:input.quota.toReversed()}).coverage,r.coverage);
});
test("current direct quota displays a rebound without changing historical consumption",()=>{
  const quota=[planQuota(30,30,'pro'),planQuota(20,36,'pro'),planQuota(0,21,'pro',{direct:true})];
  const input={nowMs,quota,events:[event('start',nowMs-30*M),event('complete',nowMs)]};
  const r=analyzeWorkload(input),historical=analyzeWorkload({...input,quota:quota.map(({direct,...q})=>q)});
  assert.equal(r.allowance.remainingPercent,79);
  assert.equal(r.allowance.observedAt,new Date(nowMs).toISOString());
  assert.deepEqual(r.coverage,historical.coverage);
  assert.equal(r.workHours.at(-1).hours,79/36);
  assert.equal(analyzeWorkload({...input,quota:quota.toReversed()}).allowance.remainingPercent,79);
  const duplicate=analyzeWorkload({...input,quota:[...quota,{...quota.at(-1),direct:false}]});
  assert.equal(duplicate.allowance.remainingPercent,79);
  const conflict=analyzeWorkload({...input,quota:[...quota,{...quota.at(-1),usedPercent:22}]});
  assert.equal(conflict.allowance.remainingPercent,null);
});

test('unknown account identity cuts a same-plan, same-reset consumption interval',()=>{
  const quota=[planQuota(30,10,'pro',{accountKey:'a'}),planQuota(20,12,'pro',{accountKey:null}),
    planQuota(10,50,'pro',{accountKey:'a'}),planQuota(0,52,'pro',{accountKey:'a'})];
  const value=analyzeWorkload({nowMs,quota});
  assert.equal(value.segmentation.plans[0].observedPp,2);
  assert.equal(value.allowance.remainingPercent,48);
});

test('ordered reads at the same millisecond can recover and accumulate without a timestamp conflict',()=>{
  const quota=[30,36,21,30].map((usedPercent,i)=>planQuota(0,usedPercent,'pro',
    {accountKey:'synthetic-ordered-account',observationOrder:i+1}));
  const input={nowMs,liveSinceMs:nowMs,quota};
  const value=analyzeWorkload(input);
  assert.equal(value.comparison.actualPp,15);
  assert.equal(value.segmentation.plans[0].observedPp,15);
  assert.equal(value.allowance.remainingPercent,70);
  assert.ok(!value.errors.some(e=>e.code.includes('quota_conflict')||e.code==='quota_observation_conflict'));
  assert.deepEqual(analyzeWorkload({...input,quota:[...quota,...quota].toReversed()}),value);
  assert.doesNotMatch(JSON.stringify(value),/observationOrder|accountKey|synthetic-ordered-account/);
});

test('quota stage replay conserves positive within-stage changes across repeated recoveries',()=>{
  for(let seed=0;seed<20;seed++){
    const readings=Array.from({length:16},(_,i)=>(seed*7+i*13)%57);
    const quota=readings.map((used,i)=>planQuota(16-i,used,'pro',{observationOrder:i+1}));
    const input={nowMs,liveSinceMs:nowMs-16*M,quota};
    const value=analyzeWorkload(input);
    const expected=readings.slice(1).reduce((sum,used,i)=>sum+Math.max(0,used-readings[i]),0);
    assert.equal(value.comparison.actualPp,expected);
    assert.equal(value.segmentation.plans.reduce((sum,p)=>sum+p.observedPp,0),expected);
    assert.deepEqual(analyzeWorkload({...input,quota:quota.toReversed()}),value);
    assertConserved(value);
  }
});

test('first confirmed plan at 97 percent remaining establishes a baseline without backfilling earlier consumption',()=>{
  const quota=[planQuota(30,1,'unknown'),planQuota(20,3,'pro'),planQuota(10,5,'pro'),
    planQuota(5,1,'pro'),planQuota(0,2,'pro')];
  const value=analyzeWorkload({nowMs,liveSinceMs:nowMs-20*M,quota});
  assert.equal(value.comparison.baseline.usedPercent,3);
  assert.equal(value.comparison.baseline.atMs,nowMs-20*M);
  assert.equal(value.comparison.actualPp,3); // 3->5 plus 1->2; neither earlier 3% nor recovery counts.
  assert.equal(value.segmentation.plans.find(p=>p.planType==='pro').observedPp,3);
  assert.equal(value.allowance.remainingPercent,98);
});

test("recovery stages honor reset identities, old display-window evidence and conflicting gaps",()=>{
  const from=nowMs-168*60*M,q=(atMs,usedPercent,resetKey="r")=>({atMs,usedPercent,resetKey});
  const r=analyzeWorkload({nowMs,events:[event("start",from),event("complete",nowMs)],
    quota:[q(from-M,16),q(from+M,10),q(from+2*M,16),q(nowMs-5*M,17),q(nowMs,1,"new")]});
  assert.equal(r.coverage.actualPp,7);assert.equal(r.allowance.remainingPercent,99);
  assert.equal(r.adjustments.quotaStaleObservations,0);assert.equal(r.allowance.points.at(-1).breakBefore,true);
  const gap=analyzeWorkload({nowMs,events:[event("start",nowMs-20*M),event("complete",nowMs)],
    quota:[q(nowMs-20*M,10),q(nowMs-15*M,11),q(nowMs-15*M,12),q(nowMs-10*M,15),q(nowMs,16)]});
  assert.ok(gap.errors.some(e=>e.code==="quota_observation_conflict"));assert.equal(gap.coverage.actualPp,1);
});
test("actual historical composite is independent of classification, pricing and API capacity",()=>{
  const v=analyzeWorkload({nowMs,events:[event("start",nowMs-120*M),event("complete",nowMs)],
    quota:[{atMs:nowMs-120*M,usedPercent:28,resetKey:"r"},{atMs:nowMs,usedPercent:34,resetKey:"r"}],sourceFresh:true});
  assert.equal(v.workHours.at(-1).ratePpPerHour,3); assert.equal(v.workHours.at(-1).hours,22);
  assert.equal(v.current.state,"unknown"); assert.equal(v.current.hours,null);
});
test("a task without usage does not invent a zero rate or infinite hours",()=>{
  const v=analyzeWorkload({nowMs,liveSinceMs:nowMs-60*M,sourceFresh:true,events:[event("start",nowMs-20*M)],capacity:{usd:100,availableAtMs:nowMs-60*M}});
  assert.equal(v.current.state,"unknown"); assert.equal(v.current.ratePpPerHour,null);assert.equal(v.current.hours,null);
  assert.equal(v.coverage.workMs,20*M);
});
test("three means is deterministic, duration weighted and includes zero-usage work",()=>{
  const bins=Array.from({length:12},(_,i)=>({atMs:i*5*M,workMs:5*M,usd:i<4?0:i<8?1:3,priced:true}));
  assert.deepEqual(clusterWorkload(bins),[0,12,36]);
  assert.deepEqual(clusterWorkload(bins.toReversed()),[0,12,36]);
  assert.equal(clusterWorkload(bins.slice(0,8)),null);
});
test('equal values stay atomic and unsupported three-class fits remain unavailable',()=>{
  const make=rates=>rates.map((x,i)=>({atMs:i*5*M,workMs:5*M,usd:x/12,priced:true}));
  const bins=make([1,1,1,2,2,2,2,2,100]),before=structuredClone(bins);
  assert.equal(clusterWorkload(bins),null);assert.equal(clusterWorkload(bins.toReversed()),null);
  assert.deepEqual(bins,before);
  const short=make([1,1,1,2,2,2,3,3,3]).map(b=>({...b,workMs:1000}));
  assert.equal(clusterWorkload(short),null);
  const complete=make([0,0,0,12,12,12,36,36,36]);
  assert.deepEqual(clusterWorkload([...complete,{atMs:0,workMs:M,usd:1000,priced:true,complete:false}]),[0,12,36]);
  assert.deepEqual(clusterWorkload([...complete,{atMs:0,workMs:Infinity,usd:1,priced:true}]),[0,12,36]);
});
test('historical fitted partitions keep their minimum size with independent recent classification',()=>{
  const rates=[1,2,3,4,5,6,100,7,7,7],start=nowMs-rates.length*5*M;
  const events=[event('start',start),event('complete',nowMs-15*M),event('start',nowMs-15*M,{key:'current'})];
  const usage=rates.map((x,i)=>({atMs:start+(i+1)*5*M,session:'session',usd:x/12,priced:true}));
  const quota=Array.from({length:rates.length+1},(_,i)=>({atMs:start+i*5*M,usedPercent:i,resetKey:'r'}));
  const input={nowMs,liveSinceMs:start,sourceFresh:true,events,usage,quota,capacity:{usd:100,availableAtMs:start}};
  const v=analyzeWorkload(input),day=v.daily.at(-1);
  assert.equal(day.light,3);assert.equal(day.medium,3);assert.equal(day.heavy,4);assert.equal(day.unclassified,0);
  assert.equal(v.current.level,'unclassified');assert.ok(Math.abs(v.current.ratePpPerHour-7)<1e-12);
  assert.deepEqual(analyzeWorkload({...input,usage:usage.toReversed(),events:events.toReversed()}),v);
  assertConserved(v);
});
test('incomplete work preserves historical refusal without blocking elapsed recent usage',()=>{
  const start=nowMs-65*M;
  const events=[event('start',start,{session:'known'}),event('start',nowMs-5*M,{key:'bad'}),
    event('start',nowMs-4*M,{key:'bad'}),event('complete',nowMs,{key:'bad'})];
  const usage=Array.from({length:13},(_,i)=>({atMs:start+(i+1)*5*M,session:'session',usd:i<4?1:i<8?2:i<12?3:1000,priced:true}));
  const quota=Array.from({length:14},(_,i)=>({atMs:start+i*5*M,usedPercent:i,resetKey:'r'}));
  const v=analyzeWorkload({nowMs,liveSinceMs:start,sourceFresh:true,events,usage,quota,capacity:{usd:100,availableAtMs:start}});
  assert.deepEqual(v.classification.centers,[12,24,36]);
  assert.equal(v.daily.at(-1).unclassified,1);assert.equal(sumDaily(v),13);assertConserved(v);
  assert.equal(v.current.state,'available');assert.equal(v.current.level,'unclassified');
  assert.equal(v.current.ratePpPerHour,4024);assert.ok(v.current.hours>0);
  assert.equal(v.coverage.estimationPp,12);
});
test('unread usage history cannot masquerade as known zero-cost work for training or current pace',()=>{
  const start=nowMs-60*M,usage=Array.from({length:12},(_,i)=>({atMs:start+(i+1)*5*M,session:'session',usd:i<4?1:i<8?2:3,priced:true}));
  const input={nowMs,liveSinceMs:start,sourceFresh:true,events:[event('start',start)],usage,
    capacity:{usd:100,availableAtMs:start}};
  assert.deepEqual(analyzeWorkload(input).classification.centers,[12,24,36]);
  const v=analyzeWorkload({...input,usageCoverageFromMs:nowMs-10*M});
  assert.equal(v.classification.centers,null);assert.equal(v.trend.ratePpPerHour,null);
  assert.equal(v.current.ratePpPerHour,null);assert.equal(v.current.usdPerHour,null);
  assert.equal(analyzeWorkload({...input,usageCoverageFromMs:nowMs-15*M}).current.ratePpPerHour,36);
});
test("current API rate uses the fixed elapsed denominator regardless of task length",()=>{
  const input={nowMs,sourceFresh:true,liveSinceMs:nowMs-60*M,events:[event("start",nowMs-15*M)],
    usage:[{atMs:nowMs-M,session:"session",usd:1,priced:true}],capacity:{usd:100,availableAtMs:nowMs-60*M},
    quota:[{atMs:nowMs,usedPercent:34,resetKey:"r"}]};
  const a=analyzeWorkload(input);assert.equal(a.current.ratePpPerHour,4);assert.equal(a.current.hours,16.5);
  assert.equal(a.trend.ratePpPerHour,null);assert.ok(!Object.hasOwn(a.trend,'hours'));
  const b=analyzeWorkload({...input,events:[event("start",nowMs-5*M)]});
  assert.equal(b.current.ratePpPerHour,4);assert.equal(b.current.hours,16.5);
});
test("daily allocation conserves measured quota and unknown pricing is not zero",()=>{
  const v=analyzeWorkload({nowMs,events:[event("start",nowMs-10*M),event("complete",nowMs)],
    quota:[{atMs:nowMs-10*M,usedPercent:29,resetKey:"r"},{atMs:nowMs,usedPercent:34,resetKey:"r"}],
    usage:[{atMs:nowMs-M,session:"session",usd:null,priced:false}]});
  assert.equal(v.daily.at(-1).unclassified,5);assert.ok(v.errors.some(x=>x.code==="price_missing"));
});
test("resets are never subtracted; conflicting quota remains explicit",()=>{
  const v=analyzeWorkload({nowMs,quota:[{atMs:nowMs-5*M,usedPercent:90,resetKey:"old"},{atMs:nowMs,usedPercent:1,resetKey:"new"}]});
  assert.equal(v.coverage.actualPp,0);assert.equal(v.allowance.points.at(-1).breakBefore,true);
  const conflict=analyzeWorkload({nowMs,quota:[{atMs:nowMs,usedPercent:1,resetKey:"r"},{atMs:nowMs,usedPercent:2,resetKey:"r"}]});
  assert.equal(conflict.allowance.remainingPercent,null);assert.ok(conflict.errors.length);
});
test("comparison uses cumulative consumption, with no work-hour denominator",()=>{
  const v=analyzeWorkload({nowMs,liveSinceMs:nowMs-10*M,capacity:{usd:100,availableAtMs:nowMs-60*M},
    quota:[{atMs:nowMs-10*M,usedPercent:29,resetKey:"r"},{atMs:nowMs,usedPercent:34,resetKey:"r"}],
    usage:[{atMs:nowMs-M,session:"session",usd:4,priced:true}]});
  assert.equal(v.comparison.actualPp,5);assert.equal(v.comparison.expectedPp,4);
});
test("weekly resets preserve startup totals and never subtract across cycles",()=>{
  const v=analyzeWorkload({nowMs,liveSinceMs:nowMs-30*M,capacity:{usd:100,availableAtMs:nowMs-60*M},
    quota:[{atMs:nowMs-30*M,usedPercent:90,resetKey:"old"},
      {atMs:nowMs-20*M,usedPercent:94,resetKey:"old"},
      {atMs:nowMs-10*M,usedPercent:0,resetKey:"new"},{atMs:nowMs,usedPercent:5,resetKey:"new"}],
    usage:[{atMs:nowMs-25*M,session:"session",usd:3,priced:true},{atMs:nowMs-M,session:"session",usd:4,priced:true}]});
  assert.equal(v.comparison.startedAtMs,nowMs-30*M);
  assert.equal(v.comparison.actualPp,9);assert.equal(v.comparison.expectedPp,7);
});

test("startup accumulation does not slide after an hour or seven days and excludes prelaunch usage",()=>{
  const start=nowMs-8*24*60*M;
  const input={nowMs,liveSinceMs:start,capacity:{usd:100,availableAtMs:start-M},
    quota:[{atMs:start-M,usedPercent:4,resetKey:"r"},{atMs:start,usedPercent:5,resetKey:"r"},
      {atMs:start+10*M,usedPercent:6,resetKey:"r"},{atMs:nowMs,usedPercent:9,resetKey:"r"}],
    usage:[{atMs:start-M,usd:99,priced:true},{atMs:start+5*M,usd:1,priced:true},{atMs:nowMs-M,usd:2,priced:true}]};
  const v=analyzeWorkload(input);assert.equal(v.comparison.startedAtMs,start);
  assert.equal(v.comparison.actualPp,4);assert.equal(v.comparison.expectedPp,3);
  const refreshed=analyzeWorkload({...input,nowMs:nowMs+5*M,comparisonCapacityUsd:100,
    capacity:{usd:200,availableAtMs:nowMs+M}});
  assert.deepEqual(refreshed.comparison,v.comparison);
  const restarted=analyzeWorkload({...input,liveSinceMs:nowMs});
  assert.equal(restarted.comparison.actualPp,0);assert.equal(restarted.comparison.expectedPp,0);
});

test("startup comparison identifies a pending common expiry beyond the old five-second boundary",()=>{
  const expiry=nowMs+5*24*60*M;
  const q=(minutes,used,offset,planType="prolite")=>({atMs:nowMs-minutes*M,usedPercent:used,
    resetAtMs:expiry+offset,resetKey:`${offset}:${planType}`,planType,limitId:"codex"});
  const input={nowMs,liveSinceMs:nowMs-20*M,capacity:{usd:100,availableAtMs:nowMs-30*M},
    quota:[q(20,10,0),q(15,11,6000),q(10,10,0),q(5,11,22000),q(0,12,0)],
    usage:[{atMs:nowMs-12*M,usd:1,priced:true},{atMs:nowMs-M,usd:1,priced:true}]};
  const v=analyzeWorkload(input);assert.equal(v.comparison.actualPp,3);assert.equal(v.comparison.expectedPp,1);
  assert.equal(v.errors.length,0);
  const distinct=analyzeWorkload({...input,quota:[q(20,10,0),q(0,12,6*M)]});
  assert.ok(distinct.errors.some(e=>e.code==="comparison_reset_ambiguous"));
  const plan=analyzeWorkload({...input,quota:[q(20,10,0),q(0,12,0,"plus")]});
  assert.ok(plan.errors.some(e=>e.code==="comparison_identity_changed"));
});

test("comparison distinguishes missing evidence, unpriced usage and ambiguous reset gaps from zero",()=>{
  const quota=[{atMs:nowMs-20*M,usedPercent:10,resetKey:"old"},{atMs:nowMs-10*M,usedPercent:1,resetKey:"new"},{atMs:nowMs,usedPercent:2,resetKey:"new"}];
  const input={nowMs,liveSinceMs:nowMs-20*M,quota,capacity:{usd:100,availableAtMs:nowMs-30*M}};
  const gap=analyzeWorkload({...input,usage:[{atMs:nowMs-15*M,usd:1,priced:true}]});
  assert.equal(gap.comparison.actualPp,null);assert.equal(gap.comparison.expectedPp,null);
  assert.ok(gap.errors.some(e=>e.code==="comparison_reset_gap"));
  const unpriced=analyzeWorkload({...input,usage:[{atMs:nowMs-M,usd:null,priced:false}]});
  assert.equal(unpriced.comparison.actualPp,1);assert.equal(unpriced.comparison.expectedPp,null);
  assert.equal(analyzeWorkload({...input,capacity:null}).comparison.expectedPp,null);
  assert.equal(analyzeWorkload({...input,quota:[]}).comparison.actualPp,null);
  const conflict=analyzeWorkload({...input,quota:[...quota,{atMs:nowMs,usedPercent:3,resetKey:"new"}]});
  assert.equal(conflict.comparison.actualPp,null);assert.ok(conflict.errors.some(e=>e.code==="comparison_quota_conflict"));
});

test("confirmed weekly renewal preserves totals, skips late old-cycle readings, and does not require a percentage drop",()=>{
  const expiry=nowMs-10*M,week=7*24*60*M;
  const q=(minutes,used,reset)=>({atMs:nowMs-minutes*M,usedPercent:used,resetAtMs:reset,
    resetKey:`${reset}:prolite:codex`,planType:"prolite",limitId:"codex"});
  const input={nowMs,liveSinceMs:nowMs-30*M,capacity:{usd:100,availableAtMs:nowMs-60*M},
    quota:[q(30,90,expiry),q(20,94,expiry),q(9,0,expiry+week),q(8,94,expiry),q(0,5,expiry+week)],
    usage:[{atMs:nowMs-25*M,usd:3,priced:true},{atMs:nowMs-M,usd:4,priced:true}]};
  const value=analyzeWorkload(input);
  assert.equal(value.comparison.actualPp,9);assert.equal(value.comparison.expectedPp,7);
  assert.equal(value.errors.length,0);
  const alreadyBusy=analyzeWorkload({...input,quota:[q(30,90,expiry),q(20,94,expiry),q(9,96,expiry+week),q(0,98,expiry+week)]});
  assert.equal(alreadyBusy.comparison.actualPp,6);assert.equal(alreadyBusy.comparison.expectedPp,7);
  const gap=analyzeWorkload({...input,usage:[...input.usage,{atMs:nowMs-15*M,usd:2,priced:true}]});
  assert.equal(gap.comparison.actualPp,9);assert.equal(gap.comparison.expectedPp,7);
  assert.equal(gap.comparison.coverage,"partial");
  assert.ok(gap.errors.some(e=>e.code==="comparison_reset_gap"));
});

test("expiry boundary, early renewal and large rescheduling remain ambiguous instead of being smoothed",()=>{
  const q=(at,used,reset)=>({atMs:at,usedPercent:used,resetAtMs:reset,resetKey:`${reset}`,
    planType:"prolite",limitId:"codex"});
  const input={nowMs,liveSinceMs:nowMs-20*M,capacity:{usd:100,availableAtMs:nowMs-30*M}};
  for(const [oldReset,newReset,newUsed] of [[nowMs-1000,nowMs+6000,1],
    [nowMs-1000,nowMs-1000,1],[nowMs+60*M,nowMs+8*24*60*M,1],
    [nowMs+60*M,nowMs+70*M,12]]) {
    const value=analyzeWorkload({...input,quota:[q(nowMs-20*M,10,oldReset),q(nowMs,newUsed,newReset)]});
    assert.equal(value.comparison.actualPp,null);assert.equal(value.comparison.expectedPp,null);
    assert.ok(value.errors.some(e=>e.code==="comparison_reset_ambiguous"));
  }
});

test("deadline jitter cannot chain indefinitely or bridge explicit plans or quota families",()=>{
  const reset=nowMs+5*24*60*M;
  const q=(minutes,offset,used)=>({atMs:nowMs-minutes*M,usedPercent:used,resetAtMs:reset+offset,
    resetKey:`${offset}`,planType:"prolite",limitId:"codex"});
  const input={nowMs,liveSinceMs:nowMs-20*M,capacity:{usd:100,availableAtMs:nowMs-30*M},
    usage:[{atMs:nowMs-M,usd:2,priced:true}]};
  const chained=analyzeWorkload({...input,quota:[q(20,0,10),q(10,4*M,11),q(0,8*M,12)]});
  assert.equal(chained.comparison.actualPp,1);assert.equal(chained.comparison.coverage,"partial");
  assert.ok(chained.errors.some(e=>e.code==="comparison_reset_ambiguous"));
  for(const change of [{planType:"plus"},{limitId:"other"}]) {
    const value=analyzeWorkload({...input,quota:[q(20,0,10),{...q(0,6000,12),...change}]});
    assert.equal(value.comparison.actualPp,null);
    assert.ok(value.errors.some(e=>e.code==="comparison_identity_changed"));
  }
});

test('startup comparison reuses preceding observed plan periods without freezing on missing labels',()=>{
  const quota=[planQuota(20,4,'pro'),planQuota(19,4,'pro'),planQuota(18,4,'unknown'),
    planQuota(17,4,'pro'),planQuota(10,7,'pro'),planQuota(0,11,'unknown')];
  const input={nowMs,liveSinceMs:nowMs-20*M,quota,capacity:{usd:100,availableAtMs:nowMs-30*M},
    usage:[{atMs:nowMs-18.5*M,usd:1,priced:true},{atMs:nowMs-5*M,usd:5,priced:true}]};
  const before=structuredClone(input),value=analyzeWorkload(input);
  assert.equal(value.comparison.actualPp,7);assert.equal(value.comparison.expectedPp,6);
  assert.equal(value.comparison.coverage,'complete');assert.equal(value.comparison.inferred,true);
  assert.equal(value.comparison.confirmedThrough,new Date(nowMs).toISOString());
  assert.ok(!value.errors.some(e=>e.code==='comparison_reset_gap'));
  assert.deepEqual(input,before);
  for(const rows of [quota.toReversed(),[...quota,...quota]])
    assert.deepEqual(analyzeWorkload({...input,quota:rows}).comparison,value.comparison);
});

test('startup plan inference uses direct observations too and does not turn an inferred baseline into an observation',()=>{
  const anchor=planQuota(30,4,'pro'),quota=[planQuota(20,4,'unknown'),planQuota(0,7,'unknown')];
  const input={nowMs,liveSinceMs:nowMs-20*M,quota,comparisonQuota:[anchor],
    capacity:{usd:100,availableAtMs:nowMs-30*M},usage:[{atMs:nowMs-M,usd:2,priced:true}]};
  const value=analyzeWorkload(input);
  assert.equal(value.comparison.actualPp,3);assert.equal(value.comparison.expectedPp,2);
  assert.equal(value.comparison.inferred,true);assert.equal(value.comparison.baseline.planType,'unknown');
  assert.deepEqual(analyzeWorkload({...input,comparisonBaseline:{...value.comparison.baseline,resetKey:'saved'}}).comparison,value.comparison);
  const noAnchor=analyzeWorkload({...input,comparisonQuota:[],quota:[...quota,planQuota(0,7,'pro')]});
  assert.equal(noAnchor.comparison.actualPp,null);assert.equal(noAnchor.comparison.inferred,false);
});

test('startup plan inference retains same-time conflicts and stops at explicit account changes',()=>{
  const input={nowMs,liveSinceMs:nowMs-30*M,capacity:{usd:100,availableAtMs:nowMs-40*M},
    usage:[{atMs:nowMs-25*M,usd:1,priced:true},{atMs:nowMs-M,usd:5,priced:true}]};
  const prefix=[planQuota(30,4,'pro',{accountKey:'synthetic-a'}),planQuota(20,5,'pro',{accountKey:'synthetic-a'})];
  const changed=analyzeWorkload({...input,quota:[...prefix,
    planQuota(10,5,'unknown',{accountKey:'synthetic-b'}),planQuota(0,11,'pro',{accountKey:'synthetic-b'})]});
  assert.equal(changed.comparison.actualPp,1);assert.equal(changed.comparison.expectedPp,1);
  assert.equal(changed.comparison.coverage,'partial');
  assert.ok(changed.errors.some(e=>e.code==='comparison_identity_changed'));
  assert.doesNotMatch(JSON.stringify(changed),/synthetic-[ab]/);
  const quota=[...prefix,planQuota(10,6,'pro'),planQuota(10,6,'plus'),planQuota(0,11,'unknown')];
  const conflict=analyzeWorkload({...input,quota});
  assert.equal(conflict.comparison.actualPp,1);assert.equal(conflict.comparison.inferred,false);
  assert.ok(conflict.errors.some(e=>e.code==='comparison_quota_conflict'));
  assert.deepEqual(analyzeWorkload({...input,quota:quota.toReversed()}).comparison,conflict.comparison);
});

test('an inferred plan label cannot authorize an otherwise ambiguous early reset',()=>{
  const expiry=nowMs+5*24*60*M,newExpiry=nowMs-10*M+7*24*60*M;
  const start=nowMs-30*M,resetAt=nowMs-10*M;
  const row=(minutes,used,plan,reset)=>planQuota(minutes,used,plan,{resetAtMs:reset});
  const reset={schemaVersion:'quota-reset-event-v0.1',kind:'unknown_reset',reason:'confirmed_unscheduled_quota_drop',
    precision:'observation_interval',provider:'openai_codex',planType:'pro',limitId:'codex',windowDurationMins:10080,
    occurredAt:new Date(resetAt).toISOString(),observedAt:new Date(resetAt).toISOString(),
    intervalStartedAt:new Date(nowMs-20*M).toISOString()};
  const input={nowMs,liveSinceMs:start,quota:[row(30,50,'pro',expiry),row(20,51,'pro',expiry),row(0,1,'pro',newExpiry)],
    capacity:{usd:100,availableAtMs:start-M},comparisonResetEvents:[reset]};
  const observed=analyzeWorkload({...input,comparisonQuota:[row(10,0,'pro',newExpiry)]});
  assert.equal(observed.comparison.actualPp,2);
  const inferred=analyzeWorkload({...input,comparisonQuota:[row(10,0,'unknown',newExpiry)]});
  assert.equal(inferred.comparison.actualPp,1);assert.equal(inferred.comparison.coverage,'partial');
  assert.ok(inferred.errors.some(e=>e.code==='comparison_reset_ambiguous'));
});

test("chronological cycle resolution is replay stable, does not mutate observations, and uses no future relabeling",()=>{
  const reset=nowMs+5*24*60*M;
  const quota=[0,6000,22000,1000,0].map((offset,i)=>({atMs:nowMs-(4-i)*5*M,
    usedPercent:[48,49,48,49,50][i],resetAtMs:reset+offset,resetKey:`${offset}`,planType:"prolite",limitId:"codex"}));
  const input={nowMs,liveSinceMs:nowMs-20*M,capacity:{usd:100,availableAtMs:nowMs-30*M},quota,
    usage:[{atMs:nowMs-12*M,usd:1,priced:true},{atMs:nowMs-M,usd:1,priced:true}]};
  const saved=structuredClone(input),value=analyzeWorkload(input);
  assert.deepEqual(input,saved);
  assert.equal(value.comparison.actualPp,3);assert.equal(value.comparison.expectedPp,1);
  assert.deepEqual(analyzeWorkload({...input,quota:quota.toReversed()}).comparison,value.comparison);
  const prefix=analyzeWorkload({...input,nowMs:nowMs-10*M});
  const prefixOnly=analyzeWorkload({...input,nowMs:nowMs-10*M,quota:quota.slice(0,3)});
  assert.deepEqual(prefix.comparison,prefixOnly.comparison);
  assert.deepEqual(analyzeWorkload({...input,comparisonBaseline:{...value.comparison.baseline,resetKey:"direct"},
    comparisonCapacityUsd:value.comparison.capacityUsd}).comparison,value.comparison);
});

test("startup live quota baseline survives later refreshes without a matching indexed occurrence",()=>{
  const start=nowMs-20*M,reset=nowMs+7*24*60*M;
  const q=(atMs,usedPercent)=>({atMs,usedPercent,resetAtMs:reset,planType:"prolite",limitId:"codex",resetKey:"r"});
  const input={nowMs,liveSinceMs:start,capacity:{usd:100,availableAtMs:start-M},
    usage:[{atMs:start+M,usd:1,priced:true},{atMs:nowMs-M,usd:1,priced:true}]};
  const initial=analyzeWorkload({...input,quota:[q(start,10),q(nowMs,12)]});
  const baseline={...initial.comparison.baseline,resetKey:"r"};
  const next=analyzeWorkload({...input,quota:[q(start+10*M,11),q(nowMs,12)],comparisonBaseline:baseline});
  assert.equal(next.comparison.observedFrom,new Date(start).toISOString());
  assert.deepEqual(next.comparison,initial.comparison);
  assert.deepEqual(analyzeWorkload({...input,quota:[q(start,10),q(nowMs,12)],comparisonBaseline:baseline}).comparison,next.comparison);
});

test("retained direct observations and an early-reset event join old and new cumulative consumption",()=>{
  const week=7*24*60*M,start=nowMs-5*60*M,oldExpiry=nowMs+5*24*60*M;
  const oldLast=nowMs-60*M,resetAt=oldLast+5*M,firstUse=nowMs-20*M;
  const q=(atMs,usedPercent,reset)=>({atMs,usedPercent,resetAtMs:reset,resetKey:String(reset),planType:"prolite",limitId:"codex"});
  const reset={schemaVersion:"quota-reset-event-v0.1",kind:"unknown_reset",reason:"confirmed_unscheduled_quota_drop",
    precision:"observation_interval",provider:"openai_codex",planType:"prolite",limitId:"codex",windowDurationMins:10080,
    occurredAt:new Date(resetAt).toISOString(),observedAt:new Date(resetAt).toISOString(),intervalStartedAt:new Date(oldLast).toISOString()};
  const history=[q(start,50,oldExpiry),q(start+10*M,51,oldExpiry),q(oldLast,51,oldExpiry),
    q(resetAt,0,resetAt+week),q(resetAt+10*M,0,resetAt+10*M+week),q(firstUse,0,firstUse+week),
    q(firstUse+M,51,oldExpiry),q(nowMs,1,firstUse+week)];
  const input={nowMs,liveSinceMs:start,capacity:{usd:100,availableAtMs:start-M},
    quota:[history[0],history[1],history.at(-1)],comparisonQuota:history,comparisonResetEvents:[reset],
    usage:[{atMs:start+5*M,usd:1,priced:true},{atMs:nowMs-10*M,usd:2,priced:true}]};
  const before=structuredClone(input),value=analyzeWorkload(input);
  assert.deepEqual(input,before);
  // History deliberately lacks the direct reset observation supplied to the
  // strict comparison. It must qualify that gap instead of borrowing coverage.
  assert.deepEqual(value.errors,[{code:'quota_reset_ambiguous',stage:'quota',count:1}]);
  assert.equal(value.comparison.actualPp,2);assert.equal(value.comparison.expectedPp,3);
  assert.equal(value.comparison.coverage,"complete");
  assert.deepEqual(analyzeWorkload({...input,comparisonQuota:[...history,...history],comparisonResetEvents:[reset,reset]}).comparison,value.comparison);
  for(const invalid of [{...reset,planType:"plus"},{...reset,limitId:"other"},{...reset,reason:"invented"}]){
    const result=analyzeWorkload({...input,comparisonResetEvents:[invalid]});
    assert.equal(result.comparison.actualPp,1);assert.equal(result.comparison.coverage,"partial");
    assert.ok(result.errors.some(e=>e.code==="comparison_reset_ambiguous"));
  }
  const missing=analyzeWorkload({...input,comparisonQuota:[],comparisonResetEvents:[]});
  assert.equal(missing.comparison.actualPp,1);assert.equal(missing.comparison.coverage,"partial");
});

test("identity discontinuity retains only the confirmed prefix and missing pricing preserves known expected cost",()=>{
  const start=nowMs-20*M;
  const input={nowMs,liveSinceMs:start,capacity:{usd:100,availableAtMs:start-M},
    quota:[{atMs:start,usedPercent:50,resetKey:"r"},{atMs:start+10*M,usedPercent:51,resetKey:"r"},{atMs:nowMs,usedPercent:52,resetKey:"r"}],
    usage:[{atMs:start+5*M,usd:2,priced:true},{atMs:nowMs-M,usd:3,priced:true}]};
  const changed=analyzeWorkload({...input,comparisonContinuityThroughMs:start+15*M});
  assert.equal(changed.comparison.actualPp,1);assert.equal(changed.comparison.expectedPp,2);
  assert.equal(changed.comparison.coverage,"partial");assert.ok(changed.errors.some(e=>e.code==="comparison_identity_changed"));
  const missing=analyzeWorkload({...input,usage:[input.usage[0],{...input.usage[1],usd:null,priced:false}]});
  assert.equal(missing.comparison.actualPp,2);assert.equal(missing.comparison.expectedPp,2);
  assert.equal(missing.comparison.coverage,"partial");assert.ok(missing.errors.some(e=>e.code==="price_missing"));
  const historyFailure=analyzeWorkload({...input,comparisonEvidenceError:"quota_history_read_failed"});
  assert.equal(historyFailure.comparison.actualPp,2);assert.equal(historyFailure.comparison.coverage,"partial");
  assert.ok(historyFailure.errors.some(e=>e.code==="quota_history_read_failed"));
});
test("receipts at five-minute boundaries use the preceding completed work bucket",()=>{
  const usage=Array.from({length:12},(_,i)=>({atMs:nowMs-(11-i)*5*M,session:"session",usd:i<4?1:i<8?2:3,priced:true}));
  const v=analyzeWorkload({nowMs,events:[event("start",nowMs-60*M),event("complete",nowMs)],usage,
    quota:[{atMs:nowMs-60*M,usedPercent:0,resetKey:"r"},{atMs:nowMs,usedPercent:24,resetKey:"r"}]});
  assert.deepEqual(v.classification.centers,[12,24,36]);
  assert.deepEqual(v.workHours.slice(0,3).map(x=>x.ratePpPerHour),[36,24,12]);
});
test("lifecycle whitelist discards contents and malformed identifiers",()=>{
  assert.deepEqual(codexWorkLifecycle({type:"event_msg",timestamp:new Date(nowMs).toISOString(),payload:{type:"task_complete",turn_id:"synthetic",duration_ms:600000,private:"never retain"}}),
    {kind:"complete",taskId:"synthetic",observedAtMs:nowMs,durationMs:600000});
  assert.equal(codexWorkLifecycle({type:"event_msg",timestamp:"bad",payload:{type:"task_started",turn_id:"synthetic"}}),null);
});
