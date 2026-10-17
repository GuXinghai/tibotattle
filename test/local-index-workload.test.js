import test from "node:test";
import assert from "node:assert/strict";
import {join} from "node:path";
import {writeFile,appendFile,readFile,rm,mkdir} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {createWorkspace} from "./helpers/local-index-facts.js";
import {refreshLocalIndex} from "../src/local-index-refresh.js";
import {openLocalIndexStore} from "../src/local-index-store.js";
import {readLocalIndexWorkload,readWorkloadQuotaEvidence,workloadStateStore} from "../src/local-index-backend.js";
import {commitLocalCollectorState} from "../src/local-collector-state.js";
const at=Date.parse("2026-09-01T00:00:00Z"),M=60000;
const line=(atMs,type,payload)=>JSON.stringify({timestamp:new Date(atMs).toISOString(),type,payload})+"\n";
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
test("work lifecycle survives cold, incremental, replay and forward migration without leaking task identity",async()=>{
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
    db.exec("DROP TABLE work_lifecycle_fact; PRAGMA user_version=4");
    db.prepare("UPDATE source SET parser_version='local-index-rollout-typed-v1+unified-rollout-typed-v19'").run();db.close();
    assert.throws(()=>openLocalIndexStore(indexFile,{readOnly:true}),{code:"local_index_family_mismatch"});
    const saltBefore=await readFile(w.secretFile);
    await refreshLocalIndex(options);
    db=openLocalIndexStore(indexFile,{readOnly:true});
    assert.equal(db.prepare("PRAGMA user_version").get().user_version,6);
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

test("v4 refresh refuses a missing device salt before any forward migration",async()=>{
  const w=createWorkspace({files:1,events:5});
  const indexFile=join(w.state,"identity.sqlite");
  const options={codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1};
  try{
    await refreshLocalIndex(options);
    let db=openLocalIndexStore(indexFile);db.exec("PRAGMA user_version=4");db.close();
    await rm(w.secretFile);
    await assert.rejects(refreshLocalIndex(options),{code:"local_index_secret_unavailable"});
    db=new DatabaseSync(indexFile,{readOnly:true});
    assert.equal(db.prepare("PRAGMA user_version").get().user_version,4);db.close();
    await assert.rejects(readFile(w.secretFile),{code:"ENOENT"});
  }finally{w.cleanup();}
});
test("startup comparison state persists, legacy state reads forward and downgrade writes are refused",async()=>{
  const w=createWorkspace({files:1,events:1});
  try{
    const legacyRoot=join(w.state,"legacy-root");await mkdir(legacyRoot);
    const store=workloadStateStore(join(legacyRoot,"index.sqlite"));
    assert.equal(await store.read(),null);
    const value={schemaVersion:"overview-workload-state-v3",comparison:{startedAtMs:at,capacityUsd:100,planType:"prolite",baseline:null},capacityHistory:[]};
    assert.equal(await store.write(value),true);assert.deepEqual(await store.read(),value);
    assert.equal(JSON.parse(await readFile(join(legacyRoot,"private","overview-workload-state.json"),"utf8")).schemaVersion,value.schemaVersion);
    await assert.rejects(readFile(join(legacyRoot,"overview-workload-state.json")),{code:"ENOENT"});
    await assert.rejects(store.write({...value,private:"not allowed"}));assert.deepEqual(await store.read(),value);
    const legacy={schemaVersion:"overview-workload-state-v1",comparison:{anchorMs:at},capacityHistory:[]};
    await assert.rejects(store.write(legacy));
    await writeFile(join(legacyRoot,"private","overview-workload-state.json"),JSON.stringify(legacy));
    assert.deepEqual(await store.read(),legacy);
    const v2={schemaVersion:"overview-workload-state-v2",comparison:{startedAtMs:at,capacityUsd:100,planType:"prolite"},capacityHistory:[]};
    await writeFile(join(legacyRoot,"private","overview-workload-state.json"),JSON.stringify(v2));
    assert.deepEqual(await store.read(),v2);await assert.rejects(store.write(v2));
    const next={...value,comparison:{...value.comparison,startedAtMs:at+40*M}};await store.write(next);assert.deepEqual(await store.read(),next);
    const future={...next,schemaVersion:"overview-workload-state-v4"};
    const path=join(legacyRoot,"private","overview-workload-state.json");await writeFile(path,JSON.stringify(future));
    await assert.rejects(store.read());await assert.rejects(store.write(next));
    assert.deepEqual(JSON.parse(await readFile(path,"utf8")),future);
  }finally{w.cleanup();}
});
