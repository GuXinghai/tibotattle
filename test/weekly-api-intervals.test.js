import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanAttributionIndex,planAttributionContextKey } from '@app-usagemonitor/quota-analysis';
import {buildWeeklyApiIntervals,validWeeklyApiIntervals} from '../src/weekly-api-intervals.js';
import {buildCalibrationLayer} from '../src/local-index-calibration.js';
import {validateWeeklyApiIntervals,createWeeklyApiSmoother,intervalAt} from '../apps/web/public/weekly-api-intervals.js';

const start=Date.parse('2026-10-10T00:00:00Z'),minute=60_000,contextKey=planAttributionContextKey('openai_codex','codex');
const fingerprint=`generation-v2-${'a'.repeat(64)}`;
function usage(min,cost='1',options={}){
 const row=Array(21).fill(0);row[0]=new Date(start+min*minute).toISOString();row[1]=options.model??'gpt-6.1-sol';
 row[9]=options.speed??'standard';row[10]=Number(cost);row[11]=cost;row[12]=options.pricing??'fully_priced';
 row[14]=Number(cost);row[15]=Number(cost)*(options.speed==='unknown'?2:1);row[18]=['synthetic-card'];
 row[3]=1;row[13]=Number(cost)*2;row[16]=[];row[17]=[];row[19]=[];
 row[20]=[options.conflict?'conflicted':'same_record',options.plan??'plus',null,'unavailable'];
 if(options.review)Object.defineProperty(row,'weeklyApiOrigin',{value:{autoReview:true}});return row;
}
function corpus(observations,events){
 const snapshots=observations.map(([min,used,plan='plus',resetMin=10080])=>[
  new Date(start+min*minute).toISOString(),start+min*minute,'openai_codex',plan,'codex','secondary',10080,
  (start+resetMin*minute)/1000,used]);
 return {weeklyRateLimitSnapshots:snapshots,planAttribution:{index:buildPlanAttributionIndex(
  snapshots.map(q=>({contextKey,observedAtMs:q[1],planType:q[3]})))},
  forEachRetainedUsage:async consume=>{for(const e of events)await consume(e);}};
}
async function build(q,u,options={}){return buildWeeklyApiIntervals({corpus:corpus(q,u),endMs:start+200*minute,
 generation:1,fingerprint,...options});}
test('plateaus carry every exact event once; equal endpoints use (a,b] and money stays exact',async()=>{
 const rows=[usage(0,'99'),usage(2,'0.1'),usage(5,'0.2'),usage(10,'0.3'),usage(11,'0.4'),usage(20,'0.5')];
 const result=await build([[0,0],[5,0],[10,1],[15,1],[20,2]],rows);
 assert.equal(result.rows.length,2);assert.equal(result.rows[0].apiUsd,'0.6');assert.equal(result.rows[1].apiUsd,'0.9');
 assert.equal(result.rows[0].usageEvents,3);assert.equal(result.rows[1].usageEvents,2);
 assert.equal(result.rows[0].weeklyUsd,60);assert.ok(validWeeklyApiIntervals(result));validateWeeklyApiIntervals(result);
 assert.equal(result.rows[0].segment,result.rows[1].segment);
});
test('interleaved stale quota readings cannot count a rebound as a second deduction',async()=>{
 const r=await build([[0,10],[5,11],[6,10],[7,11],[8,10],[9,11],[10,12]],
  [usage(2),usage(6),usage(7),usage(9),usage(10)]);
 assert.deepEqual(r.rows.map(row=>row.quotaPp),[1,1]);
 assert.deepEqual(r.rows.map(row=>row.apiUsd),['1','4']);
 assert.equal(r.rows.reduce((sum,row)=>sum+row.quotaPp,0),2);
 assert.equal(r.rows.reduce((sum,row)=>sum+row.usageEvents,0),5);
  const conflict=await build([[0,10],[5,11],[6,10],[6,11],[7,11],[10,12],[15,13]],
    [usage(2),usage(6),usage(9),usage(12)]);
  assert.deepEqual(conflict.rows.map(row=>row.quotaPp),[1,null,1]);
  assert.deepEqual(conflict.rows.map(row=>row.reason),[null,'quota_conflict',null]);
});

test('material falls with an unchanged schedule refuse the whole rebound interval',async()=>{
 for(const readings of [[[0,91],[5,5],[10,80],[15,95],[20,96]],
   [[0,91],[5,5],[6,95],[20,96]]]){
  const result=await build(readings,[usage(2),usage(6),usage(12),usage(18)]);
  assert.equal(result.rows[0].reason,'quota_conflict');
  assert.equal(result.rows[0].weeklyUsd,null);
  assert.equal(result.rows[0].quotaPp,null);
  assert.equal(result.rows.at(-1).reason,null);
  assert.equal(result.rows.at(-1).quotaPp,1);
  assert.notEqual(result.rows[0].segment,result.rows.at(-1).segment);
  assert.ok(validWeeklyApiIntervals(result));validateWeeklyApiIntervals(result);
 }
 const pending=await build([[0,91],[5,5],[10,80]],[usage(2),usage(8)]);
 assert.equal(pending.rows[0].reason,'quota_conflict');
 assert.equal(pending.rows[0].weeklyUsd,null);
 const exactRebound=await build([[0,91],[5,5],[6,91]],[usage(2),usage(6)]);
 assert.equal(exactRebound.rows[0].reason,'quota_conflict');
});
test('free approval reviews are excluded without modifying events; unknown speed stays explicit',async()=>{
 const events=[usage(3,'4',{review:true}),usage(4,'2',{speed:'unknown'}),usage(8,'7',{model:'codex-auto-review'})];
 const before=JSON.stringify(events);const r=(await build([[0,1],[10,3]],events)).rows[0];
 assert.equal(r.apiUsd,'2');assert.equal(r.weeklyUsd,100);assert.equal(r.excludedReviewEvents,2);
 assert.equal(r.excludedReviewUsd,'11');assert.equal(r.unknownSpeedEvents,1);assert.equal(JSON.stringify(events),before);
});
test('intervals use exact speed-specific API prices, not a subscription quota multiplier',async()=>{
 const event=usage(5,'1',{speed:'fast'});event[14]=3;
 Object.defineProperty(event,'weeklyApiOrigin',{value:{apiUsd:'2.125',apiCoverage:'fully_priced',
  priceCardIds:['priority-card'],unknownSpeed:false,originKnown:true}});
 const r=(await build([[0,0],[10,1]],[event])).rows[0];
 assert.equal(r.apiUsd,'2.125');assert.equal(r.weeklyUsd,212.5);assert.deepEqual(r.priceCardIds,['priority-card']);
 const unknown=usage(5);Object.defineProperty(unknown,'weeklyApiOrigin',{value:{originKnown:false}});
 assert.equal((await build([[0,0],[10,1]],[unknown])).rows[0].reason,'review_origin_unresolved');
 const prior=(await build([[-10000,0],[-9000,1]],[usage(-9500,'3',{review:true})])).rows[0];
 assert.equal(prior.excludedReviewEvents,0);assert.equal(prior.apiUsd,'3');
 const unpriced=usage(5,'0',{review:true,pricing:'unpriced'});
 const result=await build([[0,0],[10,1]],[unpriced,usage(6)]);
 assert.equal(result.rows[0].excludedReviewUsd,null);assert.ok(validWeeklyApiIntervals(result));validateWeeklyApiIntervals(result);
});
test('mixed context tariffs remain calculable; a revision of one tariff is an explicit price boundary',async()=>{
 const priced=(min,card)=>{const e=usage(min);Object.defineProperty(e,'weeklyApiOrigin',{
  value:{apiUsd:'1',apiCoverage:'fully_priced',priceCardIds:[card],originKnown:true}});return e;};
 const q=[[0,0],[10,1]];
 assert.equal((await build(q,[priced(3,'synthetic:short-from-2026-01-01'),priced(5,'synthetic:long-from-2026-01-01')])).rows[0].reason,null);
 assert.equal((await build(q,[priced(3,'synthetic:short-from-2026-01-01'),priced(5,'synthetic:short-from-2026-10-01')])).rows[0].reason,'pricing_change');
});
test('missing, unpriced, conflicted, pending and resets are explicit, not zero capacity',async()=>{
 assert.equal((await build([[0,0],[10,1]],[])).rows[0].reason,'missing_usage');
 assert.equal((await build([[0,0],[10,1]],[usage(5,'1',{pricing:'unpriced'})])).rows[0].weeklyUsd,null);
 assert.equal((await build([[0,0],[10,1]],[usage(5,'1',{conflict:true})])).rows[0].reason,'usage_attribution_unresolved');
 assert.equal((await build([[0,0],[10,0]],[])).rows[0].reason,'awaiting_change');
 const r=await build([[0,90,'plus',10],[5,91,'plus',10],[12,0,'plus',10090],[20,1,'plus',10090]],
  [usage(3),usage(9),usage(15)]);
 assert.equal(r.rows[0].reason,null);assert.equal(r.rows[1].reason,'reset_boundary');assert.equal(r.rows[2].reason,null);
 assert.notEqual(r.rows[0].segment,r.rows[2].segment);
});
test('source/version/closed-shape validation parity and cancellation',async()=>{
 const r=await build([[0,0],[10,1]],[usage(5)]);
 for(const mutate of [v=>v.rows[0].privatePath='secret',v=>v.rows[0].weeklyUsd=0,
  v=>v.sourceFingerprint='other',v=>v.rows[0].endMs=v.rows[0].startMs,v=>v.rows[0].apiUsd=null]){
  const v=structuredClone(r);mutate(v);assert.equal(validWeeklyApiIntervals(v),false);assert.throws(()=>validateWeeklyApiIntervals(v));
 }
 const controller=new AbortController();controller.abort();await assert.rejects(build([[0,0],[10,1]],[],{signal:controller.signal}),{name:'AbortError'});
});
test('production calibration projects exact intervals before transition derivation consumes snapshot storage',async()=>{
 const events=[usage(5,'1')],c=corpus([[0,0],[10,1]],events);
 Object.assign(c,{retainedUsageEvents:events.length,usageMetadataBytes:0,usageMetadataCapacity:events.length,
  coveredAt:{startAt:new Date(start).toISOString(),endAt:new Date(start+20*minute).toISOString()},
  usageMs:Float64Array.from(events,e=>Date.parse(e[0])),readUsageSlice:async(a,b)=>events.slice(a,b),
  metrics:()=>({}),finish:async()=>{},dispose:()=>{}});
 c.planAttribution.summary={latestPlanType:'plus',planTypes:['plus'],singlePlanComparisonEligible:true};
 const layer=await buildCalibrationLayer({calibrationCorpus:c,endMs:start+20*minute,generation:1,generationFingerprint:fingerprint});
 assert.equal(c.weeklyRateLimitSnapshots.length,0,'existing ownership transfer still releases inputs');
 assert.equal(layer.weeklyApiIntervals.status,'available');assert.equal(layer.weeklyApiIntervals.rows.length,1);
 assert.equal(layer.weeklyApiIntervals.rows[0].weeklyUsd,100);
});
const row=(a,b,value,segment=1)=>({startMs:start+a*minute,endMs:start+b*minute,weeklyUsd:value,segment,reason:null});
function integrate(rows,at,sigma){
 let weight=0,sum=0;
 for(const r of rows){const n=2000,h=(r.endMs-r.startMs)/n;
  for(let i=0;i<=n;i++){const z=(r.startMs+i*h-at)/(sigma*minute),w=Math.exp(-z*z/2)*h*(i===0||i===n?1:i%2?4:2)/3;weight+=w;sum+=w*r.weeklyUsd;}}
 return sum/weight;
}
test('time-integrated Gaussian agrees with independent Simpson integration for unequal spans and every sigma',()=>{
 const rows=[row(0,2,10),row(2,90,90),row(90,180,30)];const smooth=createWeeklyApiSmoother(rows);
 for(const sigma of [15,30,60,120,240])for(const min of [0,1,60,179,180]){
  const actual=smooth(start+min*minute,sigma);assert.ok(Math.abs(actual-integrate(rows,start+min*minute,sigma))<.00003);
  assert.ok(actual>=10&&actual<=90);
 }
 assert.equal(smooth(start+minute,0),10);
});
test('constant/single intervals and segment edges renormalize; gaps never bridge; range views share full segment',()=>{
 const a=[row(0,180,7)],f=createWeeklyApiSmoother(a);for(const sigma of [15,30,60,120,240]){
  assert.ok(Math.abs(f(start,sigma)-7)<1e-12);assert.ok(Math.abs(f(start+180*minute,sigma)-7)<1e-12);}
 const rows=[row(0,10,10),{...row(10,20,null),reason:'missing_usage'},row(20,30,100,2)];
 const g=createWeeklyApiSmoother(rows);assert.equal(g(start+15*minute,240),null);assert.equal(g(start+31*minute,240),null);
 assert.ok(Math.abs(g(start+9*minute,240)-10)<1e-10);assert.ok(Math.abs(g(start+21*minute,240)-100)<1e-10);
 assert.equal(intervalAt(rows,start+10*minute).reason,'missing_usage');assert.throws(()=>g(start,5));
 assert.throws(()=>createWeeklyApiSmoother([row(0,10,1),row(5,20,2)]));
 const full=createWeeklyApiSmoother([row(0,50,10),row(50,150,100)]);
 assert.equal(full(start+100*minute,30),full(start+100*minute,30));
});
test('millisecond intervals survive a wide Gaussian kernel without CDF cancellation',()=>{
 const rows=[{...row(0,1,100),endMs:start+1},{...row(0,1,900),startMs:start+1,endMs:start+3}];
 const smooth=createWeeklyApiSmoother(rows);
 for(const sigma of [15,30,60,120,240])assert.ok(Math.abs(smooth(start+1.5,sigma)-(100+2*900)/3)<1e-8);
});
