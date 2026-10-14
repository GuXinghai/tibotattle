import test from "node:test";
import assert from "node:assert/strict";
import {analyzeWorkload,clusterWorkload,taskWorkIntervals,unionWorkIntervals} from "@app-usagemonitor/quota-analysis";
import {codexWorkLifecycle} from "../src/providers/codex/logs.js";
const M=60000,nowMs=Date.parse("2026-10-15T12:00:00Z");
const event=(kind,atMs,extra={})=>({key:"task",session:"session",kind,atMs,...extra});
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
  assert.equal(old.active,0); assert.equal(old.intervals[0].endMs,nowMs-20*M);
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
test("seconds of elapsed-timer skew retain work but reversed boundaries still fail",()=>{
  const r=taskWorkIntervals([event("start",nowMs-10*M),event("complete",nowMs,{durationMs:10*M+21518})],{nowMs});
  assert.equal(r.conflicts,0);assert.equal(r.durationDifferences,1);assert.equal(r.intervals[0].startMs,nowMs-10*M);
  assert.equal(taskWorkIntervals([event("complete",nowMs-10*M),event("start",nowMs)],{nowMs}).conflicts,1);
});
test("stale quota and rebound cannot double count consumption in any card",()=>{
  const q=(minutes,usedPercent,resetKey="r")=>({atMs:nowMs-minutes*M,usedPercent,resetKey});
  const input={nowMs,events:[event("start",nowMs-30*M),event("complete",nowMs)],
    quota:[q(30,10),q(25,16),q(20,10),q(15,16),q(10,15),q(5,17),q(0,16)],
    usage:[{atMs:nowMs-2*M,session:"session",usd:7,priced:true}],
    capacity:{usd:100,availableAtMs:nowMs-60*M},liveSinceMs:nowMs-30*M};
  const r=analyzeWorkload(input);
  assert.equal(r.coverage.actualPp,7);assert.equal(r.adjustments.quotaStaleObservations,3);
  assert.equal(r.daily.reduce((s,d)=>s+d.light+d.medium+d.heavy+d.unclassified,0),7);
  assert.equal(r.allowance.remainingPercent,83);assert.equal(r.allowance.observedAt,new Date(nowMs-5*M).toISOString());
  assert.equal(r.comparison.actualPp,7);assert.equal(r.comparison.expectedPp,0); // no API usage before the last accepted endpoint
  assert.equal(r.allowance.points.at(-1).remainingPercent,null);
  assert.deepEqual(analyzeWorkload({...input,quota:input.quota.toReversed()}).coverage,r.coverage);
});
test("watermarks honor reset identities, old display-window evidence and conflicting gaps",()=>{
  const from=nowMs-168*60*M,q=(atMs,usedPercent,resetKey="r")=>({atMs,usedPercent,resetKey});
  const r=analyzeWorkload({nowMs,events:[event("start",from),event("complete",nowMs)],
    quota:[q(from-M,16),q(from+M,10),q(from+2*M,16),q(nowMs-5*M,17),q(nowMs,1,"new")]});
  assert.equal(r.coverage.actualPp,1);assert.equal(r.allowance.remainingPercent,99);
  assert.equal(r.adjustments.quotaStaleObservations,1);assert.equal(r.allowance.points.at(-1).breakBefore,true);
  const gap=analyzeWorkload({nowMs,events:[event("start",nowMs-20*M),event("complete",nowMs)],
    quota:[q(nowMs-20*M,10),q(nowMs-15*M,11),q(nowMs-15*M,12),q(nowMs-10*M,15),q(nowMs,16)]});
  assert.ok(gap.errors.some(e=>e.code==="quota_observation_conflict"));assert.equal(gap.coverage.actualPp,1);
});
test("actual historical composite is independent of classification, pricing and API capacity",()=>{
  const v=analyzeWorkload({nowMs,events:[event("start",nowMs-120*M),event("complete",nowMs)],
    quota:[{atMs:nowMs-120*M,usedPercent:28,resetKey:"r"},{atMs:nowMs,usedPercent:34,resetKey:"r"}],sourceFresh:true});
  assert.equal(v.workHours.at(-1).ratePpPerHour,3); assert.equal(v.workHours.at(-1).hours,22);
  assert.equal(v.current.state,"idle"); assert.equal(v.current.hours,null);
});
test("a zero-token task is not idle and does not produce infinite work hours",()=>{
  const v=analyzeWorkload({nowMs,liveSinceMs:nowMs-60*M,sourceFresh:true,events:[event("start",nowMs-20*M)],capacity:{usd:100,availableAtMs:nowMs-60*M}});
  assert.equal(v.current.state,"working"); assert.equal(v.current.ratePpPerHour,0);assert.equal(v.current.hours,null);
  assert.equal(v.coverage.workMs,20*M);
});
test("three means is deterministic, duration weighted and includes zero-usage work",()=>{
  const bins=Array.from({length:12},(_,i)=>({atMs:i*5*M,workMs:5*M,usd:i<4?0:i<8?1:3,priced:true}));
  assert.deepEqual(clusterWorkload(bins),[0,12,36]);
  assert.deepEqual(clusterWorkload(bins.toReversed()),[0,12,36]);
  assert.equal(clusterWorkload(bins.slice(0,8)),null);
});
test("current API rate uses the whole work denominator including tool time",()=>{
  const input={nowMs,sourceFresh:true,liveSinceMs:nowMs-60*M,events:[event("start",nowMs-15*M)],
    usage:[{atMs:nowMs-M,session:"session",usd:1,priced:true}],capacity:{usd:100,availableAtMs:nowMs-60*M},
    quota:[{atMs:nowMs,usedPercent:34,resetKey:"r"}]};
  const a=analyzeWorkload(input);assert.equal(a.current.ratePpPerHour,4);assert.equal(a.current.hours,16.5);
  const b=analyzeWorkload({...input,events:[event("start",nowMs-5*M)]});
  assert.equal(b.current.ratePpPerHour,12);assert.equal(b.current.hours,5.5);
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

test("startup comparison tolerates bounded reset timestamp jitter only with compatible explicit metadata",()=>{
  const q=(minutes,used,offset,planType="prolite")=>({atMs:nowMs-minutes*M,usedPercent:used,
    resetAtMs:nowMs+offset,resetKey:`${offset}:${planType}`,planType,limitId:"codex"});
  const input={nowMs,liveSinceMs:nowMs-20*M,capacity:{usd:100,availableAtMs:nowMs-30*M},
    quota:[q(20,10,0),q(15,11,1000),q(10,10,0),q(5,11,2000),q(0,12,0)],
    usage:[{atMs:nowMs-12*M,usd:1,priced:true},{atMs:nowMs-M,usd:1,priced:true}]};
  const v=analyzeWorkload(input);assert.equal(v.comparison.actualPp,2);assert.equal(v.comparison.expectedPp,2);
  assert.equal(v.errors.length,0);
  const distinct=analyzeWorkload({...input,quota:[q(20,10,0),q(0,12,6000)]});
  assert.ok(distinct.errors.some(e=>e.code==="comparison_reset_gap"));
  const plan=analyzeWorkload({...input,quota:[q(20,10,0),q(0,12,0,"plus")]});
  assert.ok(plan.errors.some(e=>e.code==="comparison_reset_gap"));
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
