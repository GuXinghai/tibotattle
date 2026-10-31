import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {createWorkspace} from './helpers/local-index-facts.js';
import {refreshLocalIndex} from '../src/local-index-refresh.js';
import {commitLocalCollectorState} from '../src/local-collector-state.js';
import {readWorkloadQuotaEvidence,readLocalIndexWorkload,workloadState,workloadStateStore} from '../src/local-index-backend.js';
const at=Date.parse('2026-10-15T12:00:00Z'),M=60_000;
const token=scope=>createHash('sha256').update(scope).digest('hex');
const scopes=['synthetic-connection-a','synthetic-connection-b'];
const snapshot=(minute,scope,used)=>({schemaVersion:'0.3',kind:'codex_quota_snapshot',provider:'openai_codex',
  eventKey:`connection-${minute}-${scope}-${used}`,source:'app_server_read',observedAt:new Date(at+minute*M).toISOString(),
  accountScope:scope===null?{status:'unavailable'}:{status:'available',version:'openai-account-v1',scopeId:scope},
  windows:[{limitId:'codex',slot:'secondary',planType:'pro',usedPercent:used,windowDurationMins:10080,resetsAt:Math.floor((at+7*1440*M)/1000)}]});

test('current/history connection isolates A-B-A epochs and keeps private handles out of DTOs',async()=>{
  const w=createWorkspace({files:1,events:1}),stateFile=join(w.state,'scope-history.sqlite'),indexFile=join(w.state,'scope-index.sqlite');
  try{
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    // An older A row is deliberately appended after the B row.
    const records=[snapshot(0,scopes[0],10),snapshot(2,scopes[1],80),snapshot(1,scopes[0],12),
      snapshot(3,scopes[1],85),snapshot(4,null,13),snapshot(5,scopes[0],14),snapshot(6,scopes[0],16)];
    await commitLocalCollectorState({stateFile,checkpoint:{},records,clock:()=>at+6*M});
    const quotaEvidence=await readWorkloadQuotaEvidence({stateFile,fromMs:at,historyFromMs:at,nowMs:at+6*M});
    const base={indexFile,quotaEvidence,nowMs:at+6*M,liveSinceMs:at,timeZone:'UTC',accountScopeToken:token(scopes[0]),
      quotaWindows:[{limitId:'codex',durationMinutes:10080,planType:'pro',usedPercent:16,
        resetAt:new Date(at+7*1440*M).toISOString(),observedAt:new Date(at+6*M).toISOString()}]};
    const value=readLocalIndexWorkload(base);
    assert.equal(value.allowance.remainingPercent,84,JSON.stringify(value.errors));
    assert.equal(value.segmentation.plans[0].observedPp,4);
    assert.equal(value.comparison.startedAtMs,at+5*M);
    assert.equal(value.comparison.actualPp,2);
    const serialized=JSON.stringify(value);
    for(const scope of scopes){assert.ok(!serialized.includes(scope));assert.ok(!serialized.includes(token(scope)));}
    assert.doesNotMatch(serialized,/accountKey|scopeToken|scopeId/);
    const unknown=readLocalIndexWorkload({...base,accountScopeToken:null,previous:value});
    assert.equal(unknown.allowance.remainingPercent,84);
    assert.equal(unknown.coverage.actualPp,0);
    assert.ok(unknown.workHours.every(x=>x.hours===null));
  }finally{w.cleanup();}
});

test('ordered same-time direct records remain attributable to their own accounts',async()=>{
  const w=createWorkspace({files:1,events:1}),stateFile=join(w.state,'conflict.sqlite'),indexFile=join(w.state,'conflict-index.sqlite');
  try{
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    await commitLocalCollectorState({stateFile,checkpoint:{},records:[snapshot(0,scopes[0],10),snapshot(0,scopes[1],10)],clock:()=>at});
    const quotaEvidence=await readWorkloadQuotaEvidence({stateFile,fromMs:at,nowMs:at});
    const value=readLocalIndexWorkload({indexFile,quotaEvidence,nowMs:at,liveSinceMs:at,accountScopeToken:token(scopes[0]),
      quotaWindows:[{limitId:'codex',durationMinutes:10080,planType:'pro',usedPercent:10,
        resetAt:new Date(at+7*1440*M).toISOString(),observedAt:new Date(at).toISOString()}]});
    assert.equal(value.allowance.remainingPercent,90);
    assert.ok(!value.errors.some(e=>e.code==='quota_observation_conflict'));
  }finally{w.cleanup();}
});

test('account-bound recovery stages replay after restart without duplicating consumed quota',async()=>{
  const w=createWorkspace({files:1,events:1}),stateFile=join(w.state,'recovery.sqlite'),indexFile=join(w.state,'recovery-index.sqlite');
  try{
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const records=[snapshot(0,scopes[0],30),snapshot(1,scopes[0],36),snapshot(2,scopes[0],21),snapshot(3,scopes[0],30)];
    await commitLocalCollectorState({stateFile,checkpoint:{},records,clock:()=>at+3*M});
    const options={indexFile,nowMs:at+3*M,liveSinceMs:at,timeZone:'UTC',accountScopeToken:token(scopes[0])};
    const read=async extra=>readLocalIndexWorkload({...options,...extra,
      quotaEvidence:await readWorkloadQuotaEvidence({stateFile,fromMs:at,nowMs:at+3*M})});
    const value=await read({});
    assert.equal(value.allowance.remainingPercent,70);
    assert.equal(value.segmentation.plans[0].observedPp,15);
    assert.equal(value.comparison.actualPp,15);
    const store=workloadStateStore(indexFile);
    await store.write(token(scopes[0]),workloadState(value));
    await commitLocalCollectorState({stateFile,checkpoint:{},records,clock:()=>at+3*M});
    const restarted=await read({storedState:await workloadStateStore(indexFile).read(token(scopes[0]))});
    assert.deepEqual(restarted.comparison,value.comparison);
    assert.deepEqual(restarted.segmentation,value.segmentation);
    assert.doesNotMatch(JSON.stringify(restarted),/observationOrder|recordOrder|scopeToken|scopeId|accountKey/);
  }finally{w.cleanup();}
});

test('same-millisecond A-B-A comparison uses only the final epoch and ignores the old saved baseline',async()=>{
  const w=createWorkspace({files:1,events:1}),stateFile=join(w.state,'tied-epochs.sqlite'),indexFile=join(w.state,'tied-epochs-index.sqlite');
  try{
    await refreshLocalIndex({codexHome:w.codexHome,indexFile,secretFile:w.secretFile,workerCount:1});
    const records=[snapshot(0,scopes[0],10),snapshot(0,scopes[0],12),snapshot(0,scopes[1],80),
      snapshot(0,scopes[0],20),snapshot(0,scopes[0],23)];
    await commitLocalCollectorState({stateFile,checkpoint:{},records,clock:()=>at});
    const quotaEvidence=await readWorkloadQuotaEvidence({stateFile,fromMs:at,nowMs:at});
    const value=readLocalIndexWorkload({indexFile,quotaEvidence,nowMs:at,liveSinceMs:at,accountScopeToken:token(scopes[0]),
      storedState:{schemaVersion:'overview-workload-state-v3',comparison:{startedAtMs:at,capacityUsd:999,planType:'pro',
        baseline:{atMs:at,usedPercent:10,resetAtMs:at+7*1440*M,planType:'pro',limitId:'codex'}},capacityHistory:[]}});
    assert.equal(value.segmentation.plans[0].observedPp,5);
    assert.equal(value.comparison.actualPp,3);
    assert.equal(value.comparison.baseline.usedPercent,20);
    assert.equal(value.comparison.capacityUsd,null);
  }finally{w.cleanup();}
});
