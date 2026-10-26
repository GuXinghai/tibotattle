import test from 'node:test';import assert from 'node:assert/strict';
import {join} from 'node:path';import {writeFile,rename} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';
import {projectRuntimeModelEvidence} from '../src/providers/codex/logs.js';
import {captureRuntimeModelEvidence,reconcileRuntimeModelEvidence,readRuntimeModelEvidenceStatus,createRuntimeModelEvidenceCapture} from '../src/local-index-runtime-model-evidence.js';
import {readCodexRuntimeLogBatch} from '../src/platform/index.js';
import {openLocalIndexStore,LOCAL_INDEX_STORE_USER_VERSION} from '../src/local-index-store.js';
import {refreshLocalIndex} from '../src/local-index-refresh.js';import {auditRollups} from '../src/local-index-rollup.js';import {auditPairing} from '../src/local-index-pairing.js';
import {createWorkspace} from './helpers/local-index-facts.js';
import {readLocalIndexGenerationIdentity} from '../src/local-index-companion-source.js';
const thread='10000000-0000-4000-8000-000000000002',at=Date.parse('2026-10-01T00:00:00.000Z'),identity='a'.repeat(64);
const usage={input_tokens:100,cached_input_tokens:80,cache_write_input_tokens:0,output_tokens:10,reasoning_output_tokens:4,total_tokens:110};
const line=(n,type,payload)=>JSON.stringify({timestamp:new Date(at+n).toISOString(),type,payload})+'\n';
const row=(id=1,model='gpt-6-astra')=>({id,ts:at/1000,ts_nanos:0,thread_id:thread,target:'codex_api::sse::responses',body:'SSE event: '+JSON.stringify({type:'response.completed',response:{id:'synthetic-response',status:'completed',model}}),bytes:200});
async function fixture(){const w=createWorkspace({files:1,events:1});
 const r={thread_id:thread,turn_id:'synthetic-turn',response_id:'synthetic-response',usage,turn_token_usage:usage};
 const path=w.receipt.sources[0].replace(/[0-9a-f-]{36}\.jsonl$/u,thread+'.jsonl');await rename(w.receipt.sources[0],path);
 await writeFile(path,line(0,'session_meta',{id:thread})+line(1,'event_msg',{type:'task_started',turn_id:r.turn_id})+
  line(2,'token_usage_record',r)+line(3,'compacted',{compaction_response_id:r.response_id,latest_token_usage_record:r,resume_metadata:{previous_turn_settings:{model:'gpt-6.1-sol'}},replacement_history:[]})+
  line(4,'turn_context',{turn_id:r.turn_id,model:'gpt-6-astra'}));
 const indexFile=join(w.state,'index.sqlite');await refreshLocalIndex({indexFile,codexHome:w.codexHome,secretFile:w.secretFile,workerCount:1});
 return {...w,indexFile};
}
function facts(file){const db=openLocalIndexStore(file,{readOnly:true});try{return db.prepare(`SELECT hex(event_key) identity,observed_at_ms,tokens_in_uncached,tokens_in_cache_read,tokens_in_cache_write,tokens_out_text,tokens_out_reasoning,tokens_out_combined FROM usage_event ORDER BY source_id,source_offset`).all();}finally{db.close();}}
const options=(w,rows)=>({indexFile:w.indexFile,codexHome:w.codexHome,secretFile:w.secretFile,now:()=>at+1000,
 readBatch:async({afterId})=>({identity,lastId:Math.max(afterId,...rows.map(r=>r.id),0),rows:rows.filter(r=>r.id>afterId),more:false})});

test('context, exact success and explicit fallback remain different evidence classes',()=>{
 assert.equal(projectRuntimeModelEvidence(row()).kind,'response_completed');
 const fallback={...row(),target:'codex_core::compact_model_fallback',body:`thread_id=${thread} turn_id=synthetic-turn previous_model=gpt-6.1-sol current_model=gpt-6-astra outcome=succeeded previous-model compaction failed; retried with current model`};
 assert.equal(projectRuntimeModelEvidence(fallback).kind,'fallback_succeeded');
 assert.equal(projectRuntimeModelEvidence({...fallback,body:fallback.body.replace('succeeded','failed')}).kind,'fallback_failed');
 assert.equal(projectRuntimeModelEvidence({...row(),body:'turn_id=synthetic-turn model=gpt-6.1-sol response.completed'}).kind,'request_context');
 const fake=JSON.stringify({type:'response.output_text.delta',delta:row().body});
 assert.equal(projectRuntimeModelEvidence({...row(),body:'SSE event: '+fake}),null);
 assert.equal(projectRuntimeModelEvidence({...row(),target:'untrusted'}),null);
 assert.equal(projectRuntimeModelEvidence({...row(),body:row().body+' response_model=gpt-6.1-sol'}),null);
 assert.equal(projectRuntimeModelEvidence({...row(),body:row().body+'\nprivate text'}),null);
 assert.equal(projectRuntimeModelEvidence({...row(),target:'feedback_tags',body:'last_model_response_id=synthetic-response'}).kind,'response_reference');
 const nested={type:'response.completed',response:{id:'synthetic-response',model:'gpt-6-astra',status:'completed',output:[{text:' thread_id=untrusted turn_id=untrusted response_model=gpt-6.1-sol '}]}};
 assert.equal(projectRuntimeModelEvidence({...row(),body:'SSE event: '+JSON.stringify(nested)}).model,'gpt-6-astra');
});

test('exact receipt persists, reprices once, retains tokens and repairs rollups without replay',async()=>{
 const w=await fixture();try{
  const originalIdentity=readLocalIndexGenerationIdentity({indexFile:w.indexFile});
  const before=facts(w.indexFile);const first=await captureRuntimeModelEvidence(options(w,[row()]));assert.equal(first.applied,0);assert.equal(first.capturedNow,1);
  assert.deepEqual(readLocalIndexGenerationIdentity({indexFile:w.indexFile}),originalIdentity,
   'queued receipts do not change the published accounting inputs');
  assert.equal(reconcileRuntimeModelEvidence({indexFile:w.indexFile}).applied,1);
  const repairedIdentity=readLocalIndexGenerationIdentity({indexFile:w.indexFile});
  assert.ok(repairedIdentity.calculationRevision>originalIdentity.calculationRevision);
  assert.ok(repairedIdentity.id>originalIdentity.id);
  assert.notEqual(repairedIdentity.fingerprint,originalIdentity.fingerprint);
  assert.deepEqual(facts(w.indexFile),before);
  const db=openLocalIndexStore(w.indexFile,{readOnly:true});try{
   assert.equal(db.prepare('SELECT m.model_id FROM usage_event u JOIN model m ON m.id=u.model_id').get().model_id,'gpt-6-astra');
   assert.equal(db.prepare('PRAGMA user_version').get().user_version,LOCAL_INDEX_STORE_USER_VERSION);
   assert.equal(auditRollups(db),0);assert.equal(auditPairing(db),0);
   assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM runtime_model_evidence').all()),/synthetic-response|synthetic-turn|10000000-0000/);
  }finally{db.close();}
  const repeat=await captureRuntimeModelEvidence(options(w,[row()]));assert.equal(repeat.readRows,0);assert.equal(repeat.applied,0);assert.equal(repeat.capturedNow,0);
 }finally{w.cleanup();}
});

test('later conflicting success retracts only the model inferred from runtime evidence',async()=>{
 const w=await fixture();try{const before=facts(w.indexFile);
  await captureRuntimeModelEvidence(options(w,[row()]));reconcileRuntimeModelEvidence({indexFile:w.indexFile});
  const repairedIdentity=readLocalIndexGenerationIdentity({indexFile:w.indexFile});
  await captureRuntimeModelEvidence(options(w,[row(),row(2,'gpt-6.1-sol')]));const result=reconcileRuntimeModelEvidence({indexFile:w.indexFile});
  assert.ok(readLocalIndexGenerationIdentity({indexFile:w.indexFile}).calculationRevision>repairedIdentity.calculationRevision,
   'retracting an applied repair still invalidates calculations');
  assert.equal(result.errorCode,'runtime_evidence_conflict');assert.deepEqual(facts(w.indexFile),before);
  const db=openLocalIndexStore(w.indexFile,{readOnly:true});try{
   assert.equal(db.prepare('SELECT m.model_id FROM usage_event u JOIN model m ON m.id=u.model_id').get().model_id,'unknown');
   assert.equal(auditRollups(db),0);assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_model_evidence').get().n,2);
  }finally{db.close();}
 }finally{w.cleanup();}
});

test('fallback with no response identity is retained but never fills a model',async()=>{
 const w=await fixture();try{
  const fallback={...row(),target:'codex_core::compact_model_fallback',body:'turn_id=synthetic-turn previous_model=gpt-6.1-sol current_model=gpt-6-astra outcome=succeeded previous-model compaction failed; retried with current model'};
  assert.equal((await captureRuntimeModelEvidence(options(w,[fallback]))).applied,0);
  const db=openLocalIndexStore(w.indexFile,{readOnly:true});try{assert.equal(db.prepare('SELECT kind FROM runtime_model_evidence').get().kind,'fallback_succeeded');}finally{db.close();}
 }finally{w.cleanup();}
});

test('a conflicting native receipt cannot overwrite a model recorded by the rollout',async()=>{
 const w=await fixture();try{
  const db=openLocalIndexStore(w.indexFile);db.exec("INSERT OR IGNORE INTO model(model_id,recognition) VALUES ('gpt-6.1-sol','recognized'); UPDATE usage_event SET model_id=(SELECT id FROM model WHERE model_id='gpt-6.1-sol')");db.close();
  await captureRuntimeModelEvidence(options(w,[row()]));assert.equal(reconcileRuntimeModelEvidence({indexFile:w.indexFile}).errorCode,'runtime_evidence_conflict');
  const checked=openLocalIndexStore(w.indexFile,{readOnly:true});try{assert.equal(checked.prepare('SELECT m.model_id FROM usage_event u JOIN model m ON m.id=u.model_id').get().model_id,'gpt-6.1-sol');}finally{checked.close();}
 }finally{w.cleanup();}
});

test('cancellation leaves the evidence and saved read cursor unchanged',async()=>{
 const w=await fixture();try{const c=new AbortController();const opt=options(w,[row()]);opt.signal=c.signal;opt.readBatch=async()=>{c.abort();return {identity,lastId:1,rows:[row()]};};
  await assert.rejects(captureRuntimeModelEvidence(opt),{name:'AbortError'});
  const db=openLocalIndexStore(w.indexFile,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) n FROM runtime_model_evidence').get().n,0);assert.equal(readRuntimeModelEvidenceStatus(db).status,'pending');}finally{db.close();}
 }finally{w.cleanup();}
});

test('background evidence writes never recover or delete a foreground provisional batch',async()=>{
 const w=await fixture();try{
  const db=openLocalIndexStore(w.indexFile);db.exec('UPDATE source SET scanned_bytes=0');db.close();
  const before=facts(w.indexFile);assert.equal(before.length,1);
  await captureRuntimeModelEvidence(options(w,[row()]));
  assert.deepEqual(facts(w.indexFile),before);
 }finally{w.cleanup();}
});

test('v5 forward migration preserves facts and adds only the new evidence store',async()=>{
 const w=await fixture();try{const before=facts(w.indexFile),db=openLocalIndexStore(w.indexFile);
  // Reconstruct the actual predecessor on synthetic state: v5 did not have
  // v8 calculation triggers or its revision column.
  for(const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'calculation_%'").all())db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec('ALTER TABLE store_state DROP COLUMN calculation_revision; ALTER TABLE source DROP COLUMN carry_tier_source; DROP TABLE runtime_model_evidence; PRAGMA user_version=5');db.close();
  assert.throws(()=>openLocalIndexStore(w.indexFile,{readOnly:true}),{code:'local_index_family_mismatch'});
  const migrated=openLocalIndexStore(w.indexFile);migrated.close();assert.deepEqual(facts(w.indexFile),before);
 }finally{w.cleanup();}
});

test('runtime reader obeys its row bound, detects replacement, and exposes committed WAL style rows',async()=>{
 const filesystem={guardDatabase:async()=>({identity:'synthetic-file',databasePath:'synthetic',validate:async()=>true,release:async()=>{}})};
 const databaseFactory=()=>{const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE _sqlx_migrations(installed_on TEXT); CREATE TABLE logs(id INTEGER,ts INTEGER,ts_nanos INTEGER,target TEXT,thread_id TEXT,feedback_log_body TEXT)');
 const s=db.prepare('INSERT INTO logs VALUES(?,?,0,?,?,?)');for(let i=1;i<=1001;i++)s.run(i,at/1000,'synthetic',thread,'safe');return db;};
 const r=await readCodexRuntimeLogBatch({codexHome:'synthetic',filesystem,databaseFactory});assert.equal(r.rows.length,1000);assert.equal(r.more,true);assert.equal(r.lastId,1000);
 const next=await readCodexRuntimeLogBatch({codexHome:'synthetic',filesystem,databaseFactory,identity:r.identity,afterId:1000});assert.equal(next.rows.length,1);
 const changed=await readCodexRuntimeLogBatch({codexHome:'synthetic',filesystem,databaseFactory,identity:'b'.repeat(64),afterId:1000});assert.equal(changed.restarted,true);assert.equal(changed.lastId,1000);
});

test('source validation failures remain errors; collector can close and deduplicate active work',async()=>{
 await assert.rejects(readCodexRuntimeLogBatch({codexHome:'synthetic',filesystem:{guardDatabase:async()=>({validate:async()=>false,release:async()=>{}})}}),{code:'runtime_evidence_source_changed'});
 const capture=createRuntimeModelEvidenceCapture({indexFile:join('does-not-exist','index.sqlite'),codexHome:'synthetic'});
 const [a,b]=await Promise.all([capture.tick(),capture.tick()]);assert.equal(a.status,'pending');assert.equal(b.status,'pending');await capture.close();
});
