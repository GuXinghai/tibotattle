import test from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {writeFile,appendFile,readFile,rm} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {createWorkspace} from "./helpers/local-index-facts.js";
import {refreshLocalIndex} from "../src/local-index-refresh.js";
import {createLocalIndexWriter,openLocalIndexStore} from "../src/local-index-store.js";
import {readLocalIndexWorkload,readWorkloadQuotaEvidence,workloadStateStore,workloadState} from "../src/local-index-backend.js";
import {codexPrimaryAllowanceBasis} from "../src/codex-primary-allowance-basis.js";
import {commitLocalCollectorState} from "../src/local-collector-state.js";
import {createWindowsFilesystemAdapter,createWindowsProtectedStateStore} from "../src/platform/index.js";
const at=Date.parse("2026-09-01T00:00:00Z"),M=60000;
const line=(atMs,type,payload)=>JSON.stringify({timestamp:new Date(atMs).toISOString(),type,payload})+"\n";

function comparableWorkload(value){
  const copy=structuredClone(value);
  copy.pricingDetails?.records?.sort((left,right)=>
    String(left.at).localeCompare(String(right.at))||String(left.model).localeCompare(String(right.model))
    ||String(left.reason).localeCompare(String(right.reason)));
  return copy;
}

// Aggregate bucket pricing sums the same doubles in a different order. Allow
// only that binary-float reordering noise; every structure, string, integer,
// coverage flag and classification must still match exactly.
function workloadDifferences(expected,actual,path='$',out=[]){
  if(typeof expected==='number'&&typeof actual==='number'){
    if(!Object.is(expected,actual)&&Math.abs(expected-actual)>1e-9*Math.max(1,Math.abs(expected),Math.abs(actual)))
      out.push({path,expected,actual});
    return out;
  }
  if(expected===null||actual===null||typeof expected!=='object'||typeof actual!=='object'){
    if(expected!==actual)out.push({path,expected,actual});
    return out;
  }
  if(Array.isArray(expected)!==Array.isArray(actual)){
    out.push({path,expected:'array-ness',actual:'array-ness'});return out;
  }
  if(Array.isArray(expected)){
    if(expected.length!==actual.length){out.push({path:`${path}.length`,expected:expected.length,actual:actual.length});return out;}
    for(let i=0;i<expected.length;i++)workloadDifferences(expected[i],actual[i],`${path}[${i}]`,out);
    return out;
  }
  const keys=new Set([...Object.keys(expected),...Object.keys(actual)]);
  for(const key of keys)workloadDifferences(expected[key],actual[key],`${path}.${key}`,out);
  return out;
}

test('the v11 workload bucket read is exact against raw events, including a cleared last instant',async()=>{
  const w=createWorkspace({variety:true,files:6,events:180,days:4});
  try{
    const indexFile=join(w.state,'bucket-diff.sqlite');
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const read=()=>readLocalIndexWorkload({indexFile,nowMs:at,timeZone:'UTC'});
    const setStatus=(status)=>{const db=new DatabaseSync(indexFile);try{
      db.prepare("UPDATE projection_watermark SET status=? WHERE projection_name='workload_bucket'").run(status);
    }finally{db.close();}};
    setStatus('pending');
    const raw=read();
    setStatus('ready');
    const bucketed=read();
    assert.deepEqual(workloadDifferences(comparableWorkload(bucketed),comparableWorkload(raw)),[]);
    const db=new DatabaseSync(indexFile);let bucket;
    try{
      bucket=db.prepare("SELECT bucket_start_ms FROM workload_bucket WHERE events>0 ORDER BY bucket_start_ms LIMIT 1").get().bucket_start_ms;
      db.prepare("UPDATE workload_bucket SET last_at_ms=NULL WHERE bucket_start_ms=?").run(bucket);
    }finally{db.close();}
    assert.deepEqual(workloadDifferences(comparableWorkload(read()),comparableWorkload(raw)),[]);
  }finally{w.cleanup();}
});

test('adjacent raw buckets do not double count an event on their shared edge',async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const indexFile=join(w.state,'bucket-edge.sqlite'),BUCKET=5*M;
    const start=Date.parse("2026-09-01T00:00:00Z");
    const db=openLocalIndexStore(indexFile,{create:true});
    const writer=createLocalIndexWriter(db);
    try{
      writer.begin();
      const sessionId=writer.internSession(Buffer.alloc(32,1),"11111111-1111-4111-8111-111111111111");
      const modelId=writer.internModel("gpt-5.1-codex-max","recognized");
      const tierId=writer.internTier({apiServiceTier:"default",billingSurface:"chatgpt_subscription",
        codexSpeedMode:"standard",tierSource:"turn_override",providerTierRaw:"default"});
      const surfaceId=writer.internSurface({agentScope:"root",surface:"codex",threadSource:"cli",
        lineageDisposition:"standalone"});
      const accountScopeId=writer.internAccountScope({status:"available",reason:null,planType:"pro",
        scopeLocal:Buffer.alloc(32,9)});
      const source=writer.registerSource({sourceLocal:Buffer.alloc(32,2),ordinal:0,sessionId,surfaceId,
        path:"synthetic.jsonl",rolloutKey:"synthetic",sizeBytes:1000,mtimeMs:1});
      for(const [index,observedAtMs] of [start,start+BUCKET].entries())
        writer.writeUsageEvent({sourceId:source.id,sourceOffset:100+index,observedAtMs,
          eventKey:Buffer.alloc(32,3+index),sessionId,accountScopeId,modelId,tierId,surfaceId,
          reasoningEffort:1,tokensInUncached:50,tokensInCacheRead:20,tokensOutCombined:5});
      writer.commitSourceState(source.id,{sessionId,surfaceId,path:"synthetic.jsonl",rolloutKey:"synthetic",
        sizeBytes:1000,mtimeMs:1,scannedBytes:1000,diagnostics:{tokenCounts:2}});
      writer.commit();
    }finally{db.close();}
    const setStatus=(status)=>{const raw=new DatabaseSync(indexFile);try{
      raw.prepare("UPDATE projection_watermark SET status=? WHERE projection_name='workload_bucket'").run(status);
    }finally{raw.close();}};
    const options={indexFile,nowMs:start+10*M,timeZone:'UTC',declaredSpeedBaselines:[
      {mode:"standard",firstSeenAt:new Date(start).toISOString(),
        lastSeenAt:new Date(start+BUCKET).toISOString()}]};
    // Both buckets are boundary buckets, so the reader expands each to raw
    // events. The event at start+BUCKET belongs only to the second bucket.
    setStatus('pending');
    const raw=readLocalIndexWorkload(options);
    setStatus('ready');
    const bucketed=readLocalIndexWorkload(options);
    assert.equal(bucketed.pricingDetails.total,raw.pricingDetails.total);
    assert.deepEqual(workloadDifferences(comparableWorkload(bucketed),comparableWorkload(raw)),[]);
  }finally{w.cleanup();}
});

test('reader preserves old-plan history, infers unknown labels and leaves persisted occurrences unchanged',async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const file=w.receipt.sources[0],indexFile=join(w.state,'plan-periods.sqlite');
    const sessionId=JSON.parse((await readFile(file,'utf8')).split('\n')[0]).payload.id;
    const reset= Math.floor((at+10*24*60*M)/1000);
    const q=(minute,used,plan)=>line(at+minute*M,'event_msg',{type:'token_count',
      rate_limits:{limit_id:'codex',...(plan===null?{}:{plan_type:plan}),secondary:{used_percent:used,window_minutes:10080,resets_at:reset}}});
    await writeFile(file,line(at,'session_meta',{id:sessionId})+
      line(at,'event_msg',{type:'task_started',turn_id:'synthetic-plan-period-task'})+
      q(0,20,'prolite')+q(30,25,null)+q(59,30,'prolite')+q(60,0,'pro')+q(120,2,null)+
      line(at+120*M,'event_msg',{type:'task_complete',turn_id:'synthetic-plan-period-task',duration_ms:120*M}));
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const facts=()=>{const db=openLocalIndexStore(indexFile,{readOnly:true});try{return db.prepare('SELECT * FROM quota_occurrence ORDER BY source_offset,slot_order').all();}finally{db.close();}};
    const before=facts();assert.equal(before.length,5);
    const options={indexFile,nowMs:at+120*M,timeZone:'UTC',quotaWindows:[{limitId:'codex',durationMinutes:10080,
      planType:'pro',usedPercent:2,observedAt:new Date(at+119*M).toISOString(),resetAt:new Date(reset*1000).toISOString()}]};
    const v=readLocalIndexWorkload(options);
    assert.equal(v.schemaVersion,'overview-workload-v9',JSON.stringify(v.errors));
    assert.equal(v.daily.at(-1).plans.find(p=>p.planType==='prolite').unclassified,10);
    assert.equal(v.daily.at(-1).plans.find(p=>p.planType==='pro').unclassified,2);
    assert.equal(v.planAttribution.inferredObservations,2);assert.equal(v.coverage.estimationPp,2);
    assert.deepEqual(facts(),before);assert.deepEqual(readLocalIndexWorkload(options).daily,v.daily);
    assert.doesNotMatch(JSON.stringify(v),/synthetic-plan-period-task|source_offset|accountKey/);
  }finally{w.cleanup();}
});
test('startup reader shares plan inheritance without rewriting unknown source labels',async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const file=w.receipt.sources[0],indexFile=join(w.state,'comparison-plan-periods.sqlite');
    const sessionId=JSON.parse((await readFile(file,'utf8')).split('\n')[0]).payload.id;
    const reset=Math.floor((at+7*24*60*M)/1000);
    const q=(minute,used,plan)=>line(at+minute*M,'event_msg',{type:'token_count',rate_limits:{limit_id:'codex',
      ...(plan===null?{}:{plan_type:plan}),secondary:{used_percent:used,window_minutes:10080,resets_at:reset}}});
    await writeFile(file,line(at,'session_meta',{id:sessionId})+q(0,4,'pro')+q(1,4,null)+q(2,7,'pro')+q(3,11,null));
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const facts=()=>{const db=openLocalIndexStore(indexFile,{readOnly:true});
      try{return db.prepare('SELECT * FROM quota_occurrence ORDER BY source_offset,slot_order').all();}finally{db.close();}};
    const before=facts(),options={indexFile,nowMs:at+3*M,liveSinceMs:at,timeZone:'UTC',
      quotaWindows:[{limitId:'codex',durationMinutes:10080,planType:'pro',usedPercent:11,
        observedAt:new Date(at+3*M).toISOString(),resetAt:new Date(reset*1000).toISOString()}]};
    const value=readLocalIndexWorkload(options);
    assert.equal(value.comparison.actualPp,7);assert.equal(value.comparison.inferred,true);
    assert.equal(value.comparison.coverage,'complete');assert.deepEqual(facts(),before);
    assert.deepEqual(readLocalIndexWorkload({...options,previous:value}).comparison,value.comparison);
  }finally{w.cleanup();}
});

test('quota-history failure keeps the inherited-plan qualification with retained startup subtotals',async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const file=w.receipt.sources[0],indexFile=join(w.state,'comparison-retained-marker.sqlite');
    const id=JSON.parse((await readFile(file,'utf8')).split('\n')[0]).payload.id,reset=at+7*1440*M;
    const q=(minute,used)=>line(at+minute*M,'event_msg',{type:'token_count',rate_limits:{limit_id:'codex',plan_type:'pro',
      secondary:{used_percent:used,window_minutes:10080,resets_at:Math.floor(reset/1000)}}});
    await writeFile(file,line(at,'session_meta',{id})+q(0,4)+q(3,11));
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const options={indexFile,nowMs:at+3*M,liveSinceMs:at,timeZone:'UTC',quotaWindows:[{limitId:'codex',durationMinutes:10080,
      planType:'pro',usedPercent:11,observedAt:new Date(at+3*M).toISOString(),resetAt:new Date(reset).toISOString()}]};
    const inferred=readLocalIndexWorkload({...options,quotaEvidence:{observations:[{atMs:at+M,usedPercent:5,
      resetAtMs:reset,planType:'unknown',limitId:'codex',resetKey:'synthetic-reset'}]}});
    assert.equal(inferred.comparison.inferred,true);
    const observed=readLocalIndexWorkload(options);assert.equal(observed.comparison.inferred,false);
    const retained=readLocalIndexWorkload({...options,previous:inferred,quotaEvidence:{errorCode:'quota_history_read_failed'}});
    assert.equal(retained.comparison.actualPp,7);assert.equal(retained.comparison.inferred,true);
    assert.equal(retained.comparison.coverage,'partial');
    assert.ok(retained.errors.some(e=>e.code==='quota_history_read_failed'));
  }finally{w.cleanup();}
});

test("quota evidence uses only recorded direct scoped reads and never returns account handles or payloads",async()=>{
  const w=createWorkspace({files:1,events:1}),stateFile=join(w.state,"evidence.sqlite");
  const record=(minutes,scope="synthetic-account-a",source="app_server_read")=>({schemaVersion:"0.3",kind:"codex_quota_snapshot",
    eventKey:`synthetic-${minutes}-${source}`,observedAt:new Date(at+minutes*M).toISOString(),source,
    private:"synthetic-private-marker",accountScope:{status:"available",scopeId:scope},
    windows:[{limitId:"codex",slot:"secondary",planType:"prolite",usedPercent:minutes<10?51:0,
      windowDurationMins:10080,resetsAt:Math.floor((at+7*24*60*M+minutes*M)/1000)}]});
  const event={schemaVersion:"quota-reset-event-v0.1",kind:"unknown_reset",reason:"confirmed_unscheduled_quota_drop",
    precision:"observation_interval",provider:"openai_codex",planType:"prolite",limitId:"codex",windowDurationMins:10080,
    occurredAt:new Date(at+10*M).toISOString(),observedAt:new Date(at+10*M).toISOString(),intervalStartedAt:new Date(at).toISOString()};
  try{
    await commitLocalCollectorState({stateFile,checkpoint:{},records:[record(0),record(5,"synthetic-account-a","app_server_notification"),
      {...record(10),resetEvents:[event]},record(20,"synthetic-account-b"),record(30),record(99)],clock:()=>at});
    const before=await readFile(stateFile);
    const evidence=await readWorkloadQuotaEvidence({stateFile,fromMs:at,nowMs:at+40*M});
    assert.equal(evidence.observations.length,2);assert.equal(evidence.resetEvents.length,1);
    assert.equal(evidence.continuityThroughMs,at+20*M);
    assert.doesNotMatch(JSON.stringify(evidence),/synthetic-account|synthetic-private-marker|scopeId|eventKey/u);
    assert.deepEqual(await readFile(stateFile),before);
    assert.deepEqual(await readWorkloadQuotaEvidence({stateFile,fromMs:at,nowMs:at+40*M}),evidence);
  }finally{w.cleanup();}
});

test("malformed saved reset evidence fails explicitly and a missing file is not a fabricated zero",async()=>{
  const w=createWorkspace({files:1,events:1}),stateFile=join(w.state,"invalid-evidence.sqlite");
  try{
    const missing=await readWorkloadQuotaEvidence({stateFile,fromMs:at,nowMs:at+M});
    assert.equal(missing.status,"missing");assert.deepEqual(missing.observations,[]);
    await commitLocalCollectorState({stateFile,checkpoint:{},records:[{kind:"codex_quota_snapshot",eventKey:"invalid-reset",
      observedAt:new Date(at).toISOString(),source:"app_server_read",accountScope:{status:"available",scopeId:"synthetic"},
      windows:[],resetEvents:[{schemaVersion:"future"}]}],clock:()=>at});
    await assert.rejects(readWorkloadQuotaEvidence({stateFile,fromMs:at,nowMs:at+M}),{code:"quota_history_invalid"});
  }finally{w.cleanup();}
});

test('history reset lookback does not bind startup comparison to an earlier account',async()=>{
  const w=createWorkspace({files:1,events:1}),stateFile=join(w.state,'lookback.sqlite');
  const record=(minute,scope)=>({kind:'codex_quota_snapshot',eventKey:`record-${minute}`,source:'app_server_read',
    observedAt:new Date(at+minute*M).toISOString(),accountScope:{status:'available',scopeId:scope},
    windows:[{limitId:'codex',slot:'secondary',planType:'pro',usedPercent:minute,
      windowDurationMins:10080,resetsAt:Math.floor((at+7*1440*M)/1000)}]});
  const event={schemaVersion:'quota-reset-event-v0.1',kind:'unknown_reset',reason:'confirmed_unscheduled_quota_drop',
    precision:'observation_interval',provider:'openai_codex',planType:'pro',limitId:'codex',windowDurationMins:10080,
    occurredAt:new Date(at+M).toISOString(),observedAt:new Date(at+M).toISOString(),intervalStartedAt:new Date(at).toISOString()};
  try{
    await commitLocalCollectorState({stateFile,checkpoint:{},records:[{...record(1,'old'),resetEvents:[event]},record(10,'new'),record(11,'new')],clock:()=>at});
    const before=await readFile(stateFile),v=await readWorkloadQuotaEvidence({stateFile,fromMs:at+10*M,historyFromMs:at,nowMs:at+12*M});
    assert.equal(v.observations.length,2);assert.equal(v.continuityThroughMs,null);
    assert.deepEqual(v.resetEvents,[]);assert.equal(v.historyResetEvents.length,1);
    assert.deepEqual(await readFile(stateFile),before);assert.doesNotMatch(JSON.stringify(v),/scopeId|eventKey/);
  }finally{w.cleanup();}
});

test('cancelled workload reads propagate cancellation instead of a stale success',()=>{
  const controller=new AbortController();controller.abort(new Error('synthetic-cancellation'));
  assert.throws(()=>readLocalIndexWorkload({indexFile:'not-opened.sqlite',nowMs:at,signal:controller.signal}),/synthetic-cancellation/);
});

test('reader includes pre-window usage in complete crossing-interval denominators without changing the index',async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const file=w.receipt.sources[0],indexFile=join(w.state,'lookback-workload.sqlite');
    const id=JSON.parse((await readFile(file,'utf8')).split('\n')[0]).payload.id,day=1440*M;
    const q=(t,used)=>line(t,'event_msg',{type:'token_count',rate_limits:{limit_id:'codex',plan_type:'pro',
      secondary:{used_percent:used,window_minutes:10080,resets_at:Math.floor((at+7*day)/1000)}}});
    const usage=(t,n)=>line(t,'event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:1000*n,cached_input_tokens:0,
      output_tokens:100*n,reasoning_output_tokens:0,total_tokens:1100*n},last_token_usage:{input_tokens:1000,cached_input_tokens:0,
      output_tokens:100,reasoning_output_tokens:0,total_tokens:1100}}});
    await writeFile(file,line(at,'session_meta',{id})+line(at,'turn_context',{model:'gpt-5.1-codex-max'})+
      q(at,10)+usage(at+M,1)+usage(at+6*day-M,2)+q(at+6*day,12));
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const before=await readFile(indexFile),options={indexFile,nowMs:at+8*day,timeZone:'UTC'};
    const v=readLocalIndexWorkload(options);assert.equal(v.schemaVersion,'overview-workload-v9',JSON.stringify(v.errors));
    assert.equal(v.segmentation.plans[0].observedPp,2);assert.equal(v.segmentation.plans[0].outsidePp,1,JSON.stringify({unallocated:v.unallocated,errors:v.errors}));
    assert.equal(v.segmentation.plans[0].dailyPp,1);assert.equal(v.unallocated.totalIntervals,0);
    assert.deepEqual(readLocalIndexWorkload(options),v);assert.deepEqual(await readFile(indexFile),before);
  }finally{w.cleanup();}
});
test('reader preserves orphan receipts without extending work into later same-session tasks',async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const file=w.receipt.sources[0],indexFile=join(w.state,'orphan-work.sqlite');
    const id=JSON.parse((await readFile(file,'utf8')).split('\n')[0]).payload.id,next=at+36*60*M,end=next+5*M;
    const usage=(t,n)=>line(t,'event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:1000*n,cached_input_tokens:0,
      output_tokens:100*n,reasoning_output_tokens:0,total_tokens:1100*n},last_token_usage:{input_tokens:1000,cached_input_tokens:0,
      output_tokens:100,reasoning_output_tokens:0,total_tokens:1100}}});
    const quota=(t,used)=>line(t,'event_msg',{type:'token_count',rate_limits:{limit_id:'codex',plan_type:'pro',
      secondary:{used_percent:used,window_minutes:10080,resets_at:Math.floor((at+7*1440*M)/1000)}}});
    await writeFile(file,line(at,'session_meta',{id})+line(at,'turn_context',{model:'gpt-5.1-codex-max'})+
      line(at,'event_msg',{type:'task_started',turn_id:'synthetic-orphan'})+quota(at,10)+usage(at+M,1)+
      line(next,'event_msg',{type:'task_started',turn_id:'synthetic-next'})+usage(next+M,2)+
      line(end,'event_msg',{type:'turn_aborted',turn_id:'synthetic-next'})+quota(end,12));
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const facts=()=>{const db=openLocalIndexStore(indexFile,{readOnly:true});try{return {
      work:db.prepare('SELECT * FROM work_lifecycle_fact ORDER BY source_offset').all(),
      usage:db.prepare('SELECT * FROM usage_event ORDER BY source_offset').all()};}finally{db.close();}};
    const before=facts(),v=readLocalIndexWorkload({indexFile,nowMs:end,timeZone:'UTC'});
    assert.equal(v.policyVersion,'task-workload-v15');assert.equal(v.coverage.workMs,5*M);
    assert.equal(v.coverage.estimationPp,0);assert.equal(v.segmentation.plans[0].observedPp,2);
    assert.equal(v.daily.reduce((s,d)=>s+d.light+d.medium+d.heavy+d.unclassified,0),2);
    assert.ok(v.errors.some(e=>e.code==='work_boundary_incomplete'));
    assert.deepEqual(facts(),before);assert.equal(before.work.length,3);
    assert.equal(before.usage.filter(r=>r.tokens_in_uncached>0).length,2);
    assert.doesNotMatch(JSON.stringify(v),/synthetic-orphan|synthetic-next|task_key|session_id/);
  }finally{w.cleanup();}
});
test("work lifecycle survives cold, incremental, replay and reopen without leaking task identity",async()=>{
  const w=createWorkspace({files:1,events:5});
  try{
    const file=w.receipt.sources[0],indexFile=join(w.state,"work.sqlite");
    const sessionId=JSON.parse((await readFile(file,"utf8")).split("\n")[0]).payload.id;
    const options={codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1};
    await writeFile(file,line(at,"session_meta",{id:sessionId})+
      line(at,"turn_context",{model:"gpt-6-astra",effort:"high"})+
      line(at,"event_msg",{type:"task_started",turn_id:"synthetic-work-task",private:"never retained"}));
    await refreshLocalIndex(options);
    let db=openLocalIndexStore(indexFile,{readOnly:true});
    assert.equal(db.prepare("SELECT COUNT(*) n FROM work_lifecycle_fact").get().n,1);db.close();
    await appendFile(file,line(at+10*M,"event_msg",{type:"task_complete",turn_id:"synthetic-work-task",duration_ms:10*M}));
    await refreshLocalIndex(options);await refreshLocalIndex(options);
    db=openLocalIndexStore(indexFile);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM work_lifecycle_fact").get().n,2);
    assert.equal(Buffer.from(db.prepare("SELECT task_key FROM work_lifecycle_fact LIMIT 1").get().task_key).length,32);
    db.close();
    const saltBefore=await readFile(w.secretFile);
    await refreshLocalIndex(options);
    db=openLocalIndexStore(indexFile,{readOnly:true});
    assert.equal(db.prepare("PRAGMA user_version").get().user_version,11);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM work_lifecycle_fact").get().n,2);db.close();
    assert.deepEqual(await readFile(w.secretFile),saltBefore);
    const result=readLocalIndexWorkload({indexFile,nowMs:at+11*M,sourceFresh:true});
    assert.notEqual(result.status,"unavailable",JSON.stringify(result.errors));assert.equal(result.coverage.workMs,10*M);
    assert.doesNotMatch(JSON.stringify(result),/synthetic-work-task|never retained/u);
  }finally{w.cleanup();}
});
test("unreadable store retains last-good time and exposes a classified failure",()=>{
  const previous={schemaVersion:"overview-workload-v2",generatedAt:new Date(at).toISOString(),current:{state:"idle"}};
  const result=readLocalIndexWorkload({indexFile:"nonexistent-overview-test.sqlite",nowMs:at+M,previous});
  assert.equal(result.status,"stale");assert.equal(result.generatedAt,previous.generatedAt);assert.ok(result.errors.length);
});
test("projection uses retained ancestry to deduplicate paginated work without changing facts",async()=>{
  const w=createWorkspace({files:2,events:2});
  try{
    const indexFile=join(w.state,"lineage.sqlite"),files=w.receipt.sources;
    const ids=await Promise.all(files.map(async file=>JSON.parse((await readFile(file,"utf8")).split("\n")[0]).payload.id));
    const task=(t,type,turn_id,duration_ms)=>line(t,"event_msg",{type,turn_id,...(duration_ms===undefined?{}:{duration_ms})});
    await writeFile(files[0],line(at,"session_meta",{id:ids[0]})+line(at,"turn_context",{model:"gpt-6-astra"})+
      task(at,"task_started","copied")+task(at+5*M,"task_complete","copied",5*M+12000));
    await writeFile(files[1],line(at+6*M,"session_meta",{id:ids[1]})+line(at+6*M,"turn_context",{model:"gpt-6-astra"})+
      task(at+6*M,"task_started","copied")+task(at+6*M+1,"task_complete","copied",5*M+12000)+
      task(at+7*M,"task_started","own-child-work")+task(at+10*M,"task_complete","own-child-work",3*M));
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const db=openLocalIndexStore(indexFile);
    const setParent=(child,parent)=>db.prepare('UPDATE source SET lineage_json=? WHERE session_id=(SELECT id FROM session WHERE session_uuid=?)')
      .run(JSON.stringify({lineage:{isFork:true,historyMode:"paginated",parentId:parent}}),child);
    setParent(ids[1],ids[0]);
    const before=db.prepare("SELECT hex(task_key) k,kind,observed_at_ms,duration_ms FROM work_lifecycle_fact ORDER BY source_id,source_offset").all();db.close();
    const result=readLocalIndexWorkload({indexFile,nowMs:at+11*M,sourceFresh:true});
    assert.equal(result.coverage.workMs,8*M);assert.equal(result.adjustments.workReplayEvents,2);
    assert.equal(result.adjustments.workDurationDifferences,1);assert.deepEqual(result.errors,[]);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(ids.join('|')));
    const after=openLocalIndexStore(indexFile);
    assert.deepEqual(after.prepare("SELECT hex(task_key) k,kind,observed_at_ms,duration_ms FROM work_lifecycle_fact ORDER BY source_id,source_offset").all(),before);
    after.prepare('UPDATE source SET lineage_json=? WHERE session_id=(SELECT id FROM session WHERE session_uuid=?)')
      .run(JSON.stringify({lineage:{isFork:true,parentId:ids[1]}}),ids[0]);after.close();
    const cyclic=readLocalIndexWorkload({indexFile,nowMs:at+11*M});
    assert.ok(cyclic.errors.some(e=>e.code==="work_boundary_conflict"));assert.equal(cyclic.coverage.workMs,3*M);
  }finally{w.cleanup();}
});
test("rolling work reads retain older ancestor evidence without counting fork copies or uncommitted facts",async()=>{
  const w=createWorkspace({files:3,events:3});
  try{
    const indexFile=join(w.state,"rolling-lineage.sqlite"),files=w.receipt.sources;
    const ids=await Promise.all(files.map(async file=>JSON.parse((await readFile(file,"utf8")).split("\n")[0]).payload.id));
    const task=(t,type,id,duration)=>line(t,"event_msg",{type,turn_id:id,...(duration===undefined?{}:{duration_ms:duration})});
    const day=24*60*M,nowMs=at+9*day;
    await writeFile(files[0],line(at,"session_meta",{id:ids[0]})+
      task(at,"task_started","synthetic-ancestor-task")+task(at+10*M,"task_complete","synthetic-ancestor-task",10*M));
    for(let i=1;i<3;i++){
      const t=at+3*day+i*12000;
      await writeFile(files[i],line(t,"session_meta",{id:ids[i]})+
        task(t,"task_started","synthetic-ancestor-task")+task(t+1,"task_complete","synthetic-ancestor-task",10*M)+
        (i===1?task(t+M,"task_started","synthetic-owned-task")+task(t+21*M,"task_complete","synthetic-owned-task",20*M):""));
    }
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    let db=openLocalIndexStore(indexFile);
    for(const id of ids.slice(1))db.prepare("UPDATE source SET lineage_json=? WHERE session_id=(SELECT id FROM session WHERE session_uuid=?)")
      .run(JSON.stringify({lineage:{isFork:true,historyMode:"paginated",parentId:ids[0]}}),id);
    const facts=()=>db.prepare("SELECT * FROM work_lifecycle_fact ORDER BY source_id,source_offset").all();
    const before=facts();db.close();
    const result=readLocalIndexWorkload({indexFile,nowMs});
    assert.deepEqual(result.errors,[]);assert.equal(result.coverage.workMs,20*M);
    assert.equal(result.adjustments.workReplayEvents,4);
    db=openLocalIndexStore(indexFile);assert.deepEqual(facts(),before);
    // An uncommitted ancestor is not evidence, even though its rows exist.
    db.prepare("UPDATE source SET scanned_bytes=0 WHERE session_id=(SELECT id FROM session WHERE session_uuid=?)").run(ids[0]);db.close();
    const unresolved=readLocalIndexWorkload({indexFile,nowMs});
    assert.ok(unresolved.errors.some(e=>e.code==="work_boundary_conflict"));
    assert.equal(unresolved.coverage.workMs,20*M);
  }finally{w.cleanup();}
});

test('reader resolves nested branch cancellation once and retains every stored abort and usage fact',async()=>{
  const w=createWorkspace({files:3,events:3});
  try{
    const files=w.receipt.sources,indexFile=join(w.state,'branch-cancellation.sqlite');
    const ids=await Promise.all(files.map(async file=>JSON.parse((await readFile(file,'utf8')).split('\n')[0]).payload.id));
    const task=(minute,type,turn_id,duration_ms)=>line(at+minute*M,'event_msg',{type,turn_id,...(duration_ms===undefined?{}:{duration_ms})});
    for(let i=0;i<3;i++)await writeFile(files[i],line(at,'session_meta',{id:ids[i]})+line(at,'turn_context',{model:'gpt-5.6-sol'})+
      task(0,'task_started','synthetic-parent-task')+
      (i===0?task(10,'task_complete','synthetic-parent-task',10*M):task(i+1,'turn_aborted','synthetic-parent-task'))+
      (i===1?task(11,'task_started','synthetic-child-task')+task(14,'turn_aborted','synthetic-child-task'):''));
    const refresh={codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1};
    await refreshLocalIndex(refresh);
    const db=openLocalIndexStore(indexFile);
    for(let i=1;i<3;i++)db.prepare('UPDATE source SET lineage_json=? WHERE session_id=(SELECT id FROM session WHERE session_uuid=?)')
      .run(JSON.stringify({lineage:{isFork:true,historyMode:'paginated',parentId:ids[i-1]}}),ids[i]);
    db.close();
    const facts=()=>{const d=openLocalIndexStore(indexFile,{readOnly:true});try{return {
      work:d.prepare('SELECT * FROM work_lifecycle_fact ORDER BY source_id,source_offset').all(),
      usage:d.prepare('SELECT * FROM usage_event ORDER BY source_id,source_offset').all()};}finally{d.close();}};
    const before=facts(),options={indexFile,nowMs:at+15*M,sourceFresh:true,timeZone:'UTC'};
    const result=readLocalIndexWorkload(options);
    assert.equal(result.coverage.workMs,13*M);assert.deepEqual(result.errors,[]);
    assert.equal(result.adjustments.workReplayEvents,3);assert.equal(before.work.filter(e=>e.kind==='abort').length,3);
    assert.deepEqual(readLocalIndexWorkload(options),result);assert.deepEqual(facts(),before);
    await refreshLocalIndex(refresh);
    assert.deepEqual(readLocalIndexWorkload(options).coverage,result.coverage);assert.deepEqual(facts(),before);
    assert.doesNotMatch(JSON.stringify(result),/synthetic-parent-task|synthetic-child-task|task_key|session_id/);
  }finally{w.cleanup();}
});

test("v4 refresh is refused before salt access or any forward migration",async()=>{
  const w=createWorkspace({files:1,events:5});
  const indexFile=join(w.state,"identity.sqlite");
  const options={codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1};
  try{
    await refreshLocalIndex(options);
    let db=openLocalIndexStore(indexFile);db.exec("PRAGMA user_version=4");db.close();
    await rm(w.secretFile);
    await assert.rejects(refreshLocalIndex(options),{code:"local_index_family_mismatch"});
    db=new DatabaseSync(indexFile,{readOnly:true});
    assert.equal(db.prepare("PRAGMA user_version").get().user_version,4);db.close();
    await assert.rejects(readFile(w.secretFile),{code:"ENOENT"});
  }finally{w.cleanup();}
});
test("account workload state uses its new file and leaves the old unscoped state untouched",async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const legacyRoot=join(w.state,"legacy-root");
    const indexFile=join(legacyRoot,"index.sqlite"),privateRoot=join(legacyRoot,"private");
    const legacyStore=createWindowsProtectedStateStore({rootPath:privateRoot,adapter:createWindowsFilesystemAdapter()});
    legacyStore.ensureProtectedDirectory();
    const unscoped={schemaVersion:"overview-workload-state-v3",
      comparison:{startedAtMs:at,capacityUsd:100,planType:"prolite",baseline:null},capacityHistory:[]};
    legacyStore.createJson("overview-workload-state.json",unscoped);
    const oldBytes=legacyStore.read("overview-workload-state.json").data;
    const accountScopeToken="a".repeat(64),store=workloadStateStore(indexFile);
    assert.equal(await store.read(accountScopeToken),null);
    assert.deepEqual(legacyStore.read("overview-workload-state.json").data,oldBytes);
    const value={schemaVersion:"overview-workload-state-v3",comparison:{startedAtMs:at,capacityUsd:100,planType:"prolite",baseline:null},capacityHistory:[]};
    assert.equal(await store.write(accountScopeToken,value),true);
    assert.deepEqual(await store.read(accountScopeToken),value);
    await assert.rejects(store.write(accountScopeToken,{...value,private:"not allowed"}),{code:"workload_account_state_invalid"});
    assert.deepEqual(await store.read(accountScopeToken),value);
    const accountState=legacyStore.readJson("overview-workload-account-state.json").value;
    assert.equal(accountState.schemaVersion,"overview-workload-account-state-v1");
    assert.deepEqual(accountState.accounts,[{scopeToken:accountScopeToken,state:value}]);
    assert.deepEqual(legacyStore.read("overview-workload-state.json").data,oldBytes);
    const restarted=workloadStateStore(indexFile);
    assert.deepEqual(await restarted.read(accountScopeToken),value);
    assert.deepEqual(await restarted.read("b".repeat(64)),null);
    await assert.rejects(restarted.read("not-a-scope-token"),{code:"workload_account_state_scope_invalid"});
  }finally{w.cleanup();}
});

test("capacity history survives persisted plan switches without moving earlier availability",async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const indexFile=join(w.state,"capacity-plans.sqlite");
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const store=workloadStateStore(indexFile),accountScopeToken="c".repeat(64),basisId=codexPrimaryAllowanceBasis("unresolved_as_standard").basisId;
    const first={usd:100,availableAtMs:at-60*M,planType:"prolite",version:"a".repeat(64),basisId};
    await store.write(accountScopeToken,{schemaVersion:"overview-workload-state-v3",comparison:{startedAtMs:at,capacityUsd:null,planType:null,baseline:null},capacityHistory:[first]});
    const read=async(plan,usd,version,nowMs)=>{
      const value=readLocalIndexWorkload({indexFile,nowMs,timeZone:"UTC",sourceFresh:true,storedState:await store.read(accountScopeToken),
        capacity:{status:"available",computedAt:new Date(nowMs).toISOString(),planScope:{planType:plan},selectedScenario:"synthetic",
          scenarios:{synthetic:{medianCapacityUsd:usd,cohortId:version,basisId}}}});
      assert.equal(value.status,"available",JSON.stringify(value.errors));
      await store.write(accountScopeToken,workloadState(value));
      return value;
    };
    const initial=await read("prolite",100,first.version,at);
    assert.deepEqual(initial.capacityHistory,[first]);
    const second=await read("pro",200,"b".repeat(64),at+M);
    assert.deepEqual(second.capacityHistory.map(c=>c.planType),["prolite","pro"]);
    const returned=await read("prolite",100,first.version,at+2*M);
    assert.deepEqual(returned.capacityHistory,second.capacityHistory);
    assert.deepEqual((await store.read(accountScopeToken)).capacityHistory,second.capacityHistory);
    assert.equal(returned.capacityHistory[0].availableAtMs,first.availableAtMs);
  }finally{w.cleanup();}
});

test("advancing the display window preserves persisted capacity versions from every plan",async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const indexFile=join(w.state,"capacity-window.sqlite"),day=24*60*M;
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const store=workloadStateStore(indexFile),accountScopeToken="d".repeat(64),basisId=codexPrimaryAllowanceBasis("unresolved_as_standard").basisId;
    const history=[{usd:150,availableAtMs:at-40*day,planType:"pro",version:"b".repeat(64),basisId},
      {usd:100,availableAtMs:at-30*day,planType:"prolite",version:"a".repeat(64),basisId},
      {usd:110,availableAtMs:at-20*day,planType:"prolite",version:"c".repeat(64),basisId},
      {usd:120,availableAtMs:at-day,planType:"prolite",version:"d".repeat(64),basisId}];
    await store.write(accountScopeToken,{schemaVersion:"overview-workload-state-v3",comparison:{startedAtMs:at,capacityUsd:null,planType:null,baseline:null},capacityHistory:history});
    for(const nowMs of [at,at+30*day]){
      const value=readLocalIndexWorkload({indexFile,nowMs,timeZone:"UTC",sourceFresh:true,storedState:await store.read(accountScopeToken),
        capacity:{status:"unavailable",planScope:{planType:"prolite"}}});
      assert.equal(value.status,"available",JSON.stringify(value.errors));
      assert.deepEqual(value.capacityHistory,history);
      await store.write(accountScopeToken,workloadState(value));
      assert.deepEqual((await store.read(accountScopeToken)).capacityHistory,history);
    }
  }finally{w.cleanup();}
});

test("capacity history at the state bound retains last-good evidence instead of pruning",async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const indexFile=join(w.state,"capacity-bound.sqlite");
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const basisId=codexPrimaryAllowanceBasis("unresolved_as_standard").basisId;
    const history=Array.from({length:4096},(_,i)=>({usd:100,availableAtMs:at-5000+i,planType:"prolite",version:"a".repeat(64),basisId}));
    const storedState={schemaVersion:"overview-workload-state-v3",comparison:{startedAtMs:at,capacityUsd:null,planType:null,baseline:null},capacityHistory:history};
    const previous=readLocalIndexWorkload({indexFile,nowMs:at,timeZone:"UTC",storedState,capacity:{status:"unavailable",planScope:{planType:"prolite"}}});
    const value=readLocalIndexWorkload({indexFile,nowMs:at+M,timeZone:"UTC",previous,
      capacity:{status:"available",computedAt:new Date(at+M).toISOString(),planScope:{planType:"prolite"},selectedScenario:"synthetic",
        scenarios:{synthetic:{medianCapacityUsd:200,cohortId:"b".repeat(64),basisId}}}});
    assert.equal(value.status,"stale");
    assert.equal(value.errors[0].code,"workload_context_too_large");
    assert.deepEqual(value.capacityHistory,history);
  }finally{w.cleanup();}
});
