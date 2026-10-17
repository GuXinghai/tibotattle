import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,stat,rm,appendFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createResponseUsagePlan,projectCompactionUsageLine,RESPONSE_MODEL_RECOVERY_VERSION} from '../src/providers/codex/logs.js';
import {extractRolloutUsage} from '../src/local-index-extract.js';import {localCodexLogScanner} from '../src/local-node-runtime.js';
import {refreshCodexHome,withReadOnlyStore} from './helpers/local-index-rollout-store.js';import {openLocalIndexStore} from '../src/local-index-store.js';
import {createLocalIndexBackend} from '../src/local-index-backend.js';
import {createLineFrame,projectCompleteLine} from '../src/platform/line-frame-projection.js';
const at=n=>new Date(Date.UTC(2026,9,1,0,0,n)).toISOString(),rec=(n,type,payload)=>({timestamp:at(n),type,payload});
const thread='10000000-0000-4000-8000-000000000001',turn='synthetic-turn';
const raw=n=>({input_tokens:100*n,cached_input_tokens:80*n,cache_write_input_tokens:0,output_tokens:10*n,reasoning_output_tokens:4*n,total_tokens:110*n});
const meta=rec(0,'session_meta',{id:thread}),started=rec(1,'event_msg',{type:'task_started',turn_id:turn});
const ctx=(n,model='gpt-6.1-sol')=>rec(n,'turn_context',{turn_id:turn,model});
const setting=(n,model)=>rec(n,'event_msg',{type:'thread_settings_applied',thread_settings:{model}});
const response=(n,id='synthetic-response',count=1)=>rec(n,'token_usage_record',{thread_id:thread,turn_id:turn,response_id:id,usage:raw(1),turn_token_usage:raw(count)});
const checkpoint=(n,r,model='gpt-6.1-sol',extra={})=>rec(n,'compacted',{message:'',replacement_history:[],compaction_response_id:r.payload.response_id,latest_token_usage_record:r.payload,resume_metadata:{previous_turn_settings:{model}},...extra});
function replay(records){const p=createResponseUsagePlan({identityKey:v=>createHash('sha256').update(v).digest('hex')});records.forEach((r,i)=>p.observe(r,i));return p.finish();}
async function fixture(records){const root=await mkdtemp(join(tmpdir(),'response-model-'));await mkdir(join(root,'sessions'));const path=join(root,'sessions',`rollout-2026-10-01T00-00-00-${thread}.jsonl`);await writeFile(path,records.map(r=>JSON.stringify(r)).join('\n')+'\n');return{root,path};}

test('exact checkpoint joins late context without using a time tolerance or adding checkpoint spend',()=>{
 const r=response(2),records=[meta,started,r,checkpoint(3,r),ctx(10000)];const out=replay(records);
 assert.equal(out.responseAt(2).model,'gpt-6.1-sol');assert.equal(out.responseAt(3),null);assert.equal(out.diagnostics.responses,1);assert.equal(out.diagnostics.modelsRecovered,1);assert.equal(out.diagnostics.unattributedModels,0);
 assert.ok(!JSON.stringify(out.responseAt(2)).includes('synthetic-turn'));
});
test('old and replacement models differ: successful model fallback cannot be assumed',()=>{
 const r=response(2);const out=replay([meta,started,r,checkpoint(3,r),ctx(4,'gpt-6-astra')]);assert.equal(out.responseAt(2).model,null);assert.equal(out.diagnostics.unattributedModels,1);
});
test('a live model change cannot rewrite the captured compaction request context',()=>{
 const r=response(3);const out=replay([meta,started,setting(2,'gpt-6-astra'),r,checkpoint(4,r),ctx(5),setting(6,'gpt-6-astra')]);assert.equal(out.responseAt(3).model,'gpt-6.1-sol');
});
test('ordinary first request survives a live change; next response without a new request context stays unknown',()=>{
 const a=response(3,'a',1),b=response(4,'b',2);const out=replay([meta,setting(0,'gpt-6-astra'),ctx(1,'gpt-6-astra'),setting(2,'gpt-6.1-sol'),a,b]);
 assert.equal(out.responseAt(4).model,'gpt-6-astra');assert.equal(out.responseAt(5).model,null);
});
test('recovered model keeps the captured speed declaration instead of borrowing a later speed setting',()=>{
 const context=ctx(1,'gpt-6-astra');context.payload.service_tier='default';
 const updated=setting(2,'gpt-6.1-sol');updated.payload.thread_settings.service_tier='priority';
 const result=replay([meta,context,updated,response(3)]).responseAt(3);
 assert.equal(result.model,'gpt-6-astra');assert.equal(result.requestTier.rawTier,'default');
 const noTier=replay([meta,ctx(1,'gpt-6-astra'),updated,response(3)]).responseAt(3);assert.equal(noTier.requestTier,null);
});
test('context conflicting when captured and unknown earlier response prefix do not prove a frozen model',()=>{
 const out=replay([meta,setting(0,'gpt-6-astra'),ctx(1),response(2)]);assert.equal(out.responseAt(3).model,null);
 const prefix=replay([meta,ctx(1),setting(2,'gpt-6-astra'),response(3,'a',2)]);assert.equal(prefix.responseAt(3).model,null);
});

test('settings persisted after the request context retain an already coherent known model',()=>{
 const out=replay([meta,setting(0,'gpt-6-astra'),ctx(1),setting(2,'gpt-6.1-sol'),response(3)]);
 assert.equal(out.responseAt(4).model,'gpt-6.1-sol');assert.equal(out.diagnostics.modelsRecovered,0);
});
test('wrong identity, missing context, routed model, backwards time and checkpoint copies cannot supply a model',()=>{
 const r=response(2),cp=checkpoint(3,r);
 for(const records of [
  [meta,started,r,checkpoint(3,r,'gpt-6.1-sol',{compaction_response_id:'other'}),ctx(4)],
  [meta,started,r,checkpoint(3,r,'gpt-6.1-sol',{latest_token_usage_record:{...r.payload,thread_id:'foreign'}}),ctx(4)],
  [meta,started,r,cp],
  [meta,started,r,checkpoint(1,r),ctx(4)],
  [meta,started,r,cp,response(4,'ordinary',2),ctx(5)],
 ])assert.equal(replay(records).responseAt(2).model,null);
 const routed=replay([meta,ctx(1),setting(2,'gpt-6-astra'),rec(3,'event_msg',{type:'model_reroute',turn_id:turn}),response(4)]);assert.equal(routed.responseAt(4).model,null);
 const copy=replay([meta,started,r,cp,ctx(4),cp,ctx(5)]);assert.equal(copy.diagnostics.responses,1);assert.equal(copy.responseAt(2).model,'gpt-6.1-sol');
});
test('changed checkpoint quantity or turn fails explicitly even when response ID matches',()=>{
 const r=response(2);for(const changed of [{...r.payload,usage:raw(2)},{...r.payload,turn_id:'other-turn'}])assert.throws(()=>replay([meta,started,r,checkpoint(3,r,'gpt-6.1-sol',{latest_token_usage_record:changed}),ctx(4)]),{code:'codex_response_usage_checkpoint_conflict'});
});
test('bounded suffix projection cannot mistake nested or escaped history for root receipt metadata',()=>{
 const fake=JSON.stringify(rec(3,'compacted',{replacement_history_nested:checkpoint(3,response(2)).payload}));
 const projected=projectCompactionUsageLine({prefix:fake.slice(0,512),suffix:fake});assert.equal(JSON.parse(projected).payload.compaction_response_id,undefined);
 const text=JSON.stringify(rec(3,'compacted',{message:JSON.stringify(checkpoint(3,response(2)).payload)}));assert.equal(JSON.parse(projectCompactionUsageLine({prefix:text,suffix:text})).payload.compaction_response_id,undefined);
 assert.equal(projectCompactionUsageLine({prefix:'{"type":"ordinary"}',suffix:text}),undefined);
});
test('large compacted history remains bounded and both real scanner paths recover the same model once',async()=>{
 const r=response(2),cp=checkpoint(3,r,'gpt-6-luna',{replacement_history:[{type:'message',content:'synthetic-history-only-'.repeat(60000)}]});
 const f=await fixture([meta,started,r,cp,ctx(4,'gpt-6-luna')]);try{
  const events=[];const result=await extractRolloutUsage(f.path,{size:(await stat(f.path)).size,maximumLineBytes:1024,onEvent:e=>events.push(e)});
  assert.equal(events.length,1);assert.equal(events[0].model,'gpt-6-luna');assert.equal(result.diagnostics.responseModelsRecovered,1);
  const scanned=[];await localCodexLogScanner.scanCodexLogEvents({codexHome:f.root,startAt:at(0),endAt:at(59),onUsage:e=>scanned.push(e)});assert.equal(scanned.length,1);assert.equal(scanned[0].model,'gpt-6-luna');
 }finally{await rm(f.root,{recursive:true});}
});
test('old unknown source recovers automatically once, keeps identity and totals, and does not re-scan when unchanged',async()=>{
 const r=response(2),f=await fixture([meta,started,r,checkpoint(3,r),ctx(4)]),indexFile=join(f.root,'index.sqlite');try{
  await refreshCodexHome(f.root,{indexFile});const db=openLocalIndexStore(indexFile);try{db.exec("BEGIN;INSERT OR IGNORE INTO model(model_id,recognition) VALUES('unknown','missing');UPDATE usage_event SET model_id=(SELECT id FROM model WHERE model_id='unknown');DELETE FROM source_diagnostic WHERE code='responseModelRecoveryVersion';INSERT INTO source_diagnostic(source_id,code,count) SELECT id,'responseModelUnattributed',1 FROM source WHERE 1 ON CONFLICT(source_id,code) DO UPDATE SET count=1;COMMIT");}finally{db.close();}
  const before=withReadOnlyStore(indexFile,db=>db.prepare('SELECT hex(event_key) identity,total_input_context,tokens_out_combined FROM usage_event').get());
  const fixed=await refreshCodexHome(f.root,{indexFile});assert.equal(fixed.sourcesRescanned,1);
  assert.deepEqual(withReadOnlyStore(indexFile,db=>db.prepare('SELECT hex(event_key) identity,total_input_context,tokens_out_combined FROM usage_event').get()),before);
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare('SELECT m.model_id FROM usage_event u JOIN model m ON m.id=u.model_id').get().model_id),'gpt-6.1-sol');
  const again=await refreshCodexHome(f.root,{indexFile});assert.equal(again.writeTransactions,0);assert.equal(again.bytesScanned,0);
  await appendFile(f.path,JSON.stringify(setting(5,'gpt-6-astra'))+'\n');await refreshCodexHome(f.root,{indexFile});
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare('SELECT COUNT(*) n FROM usage_event').get().n),1);
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare("SELECT count FROM source_diagnostic WHERE code='responseModelRecoveryVersion'").get().count),RESPONSE_MODEL_RECOVERY_VERSION);
 }finally{await rm(f.root,{recursive:true});}
});

async function requireRecovery(indexFile){const db=openLocalIndexStore(indexFile);try{db.exec("BEGIN;DELETE FROM source_diagnostic WHERE code='responseModelRecoveryVersion';INSERT INTO source_diagnostic(source_id,code,count) SELECT id,'responseModelUnattributed',1 FROM source WHERE 1 ON CONFLICT(source_id,code) DO UPDATE SET count=1;COMMIT");}finally{db.close();}}

test('recovery batches are bounded, drain in the backend, retain lane markers and return to idle',async()=>{
 const f=await fixture([meta,started,response(2),checkpoint(3,response(2)),ctx(4)]),indexFile=join(f.root,'index.sqlite');try{
  for(let i=2;i<=9;i++){
   const tid=`10000000-0000-4000-8000-${String(i).padStart(12,'0')}`,r=response(2,`synthetic-${i}`);r.payload.thread_id=tid;
   const records=[rec(0,'session_meta',{id:tid}),started,r,checkpoint(3,r),ctx(4)];
   await writeFile(join(f.root,'sessions',`rollout-2026-10-01T00-00-00-${tid}.jsonl`),records.map(r=>JSON.stringify(r)).join('\n')+'\n');
  }
  await refreshCodexHome(f.root,{indexFile,workerCount:3});await requireRecovery(indexFile);
  const passes=[],backend=createLocalIndexBackend({indexFile,secretFile:join(f.root,'salt'),workerCount:3,
   refresh:async options=>{const r=await refreshCodexHome(f.root,options);passes.push(r);return r;}});
  const timeouts={existingTimeoutMs:300000,freshTimeoutMs:14400000};assert.equal(backend.refreshTimeoutMs(timeouts),14400000);
  const result=await backend.refreshUnifiedIndex({codexHome:f.root});assert.equal(result.status,'ingested');assert.equal(result.sourcesRescanned,9);
  assert.equal(passes.length,2);assert.equal(passes[0].sourcesRescanned,8);assert.equal(passes[0].deferred.pendingSources,1);assert.equal(passes[1].sourcesRescanned,1);
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare("SELECT COUNT(*) n FROM source_diagnostic WHERE code='responseModelRecoveryVersion' AND count=1").get().n),9);
  assert.equal(backend.refreshTimeoutMs(timeouts),300000);
  const idle=await backend.refreshUnifiedIndex({codexHome:f.root});assert.equal(idle.unchanged,true);assert.equal(idle.bytesScanned,0);assert.equal(idle.sourcesRescanned,0);
 }finally{await rm(f.root,{recursive:true});}
});

test('backend recovery rejects stalled or cancelled queues without an unbounded retry',async()=>{
 const f=await fixture([meta]),indexFile=join(f.root,'index.sqlite');try{
  let calls=0;const deferred={status:'deferred',deferred:{reason:'model_attribution_recovery',pendingSources:1}};
  const backend=createLocalIndexBackend({indexFile,refresh:async()=>{calls++;return deferred;}});
  await assert.rejects(backend.refreshUnifiedIndex({codexHome:f.root}),{code:'local_unified_index_model_recovery_stalled'});assert.equal(calls,2);
  const abort=new AbortController();calls=0;
  const cancelled=createLocalIndexBackend({indexFile,refresh:async()=>{calls++;abort.abort();return deferred;}});
  await assert.rejects(cancelled.refreshUnifiedIndex({codexHome:f.root,signal:abort.signal}),{name:'AbortError'});assert.equal(calls,1);
 }finally{await rm(f.root,{recursive:true});}
});

test('model-only recovery does not rescan an unchanged second file in the same session',async()=>{
 const r=response(2),first=[meta,started,r,checkpoint(3,r),ctx(4)],f=await fixture(first),indexFile=join(f.root,'index.sqlite');try{
  const r2=response(10,'synthetic-second');r2.payload.turn_id='second-turn';const context=ctx(9);context.payload.turn_id='second-turn';
  const nextMeta=rec(8,'session_meta',{id:thread,history_mode:'paginated',history_base:{thread_id:thread,
   end_ordinal_exclusive:first.length,end_byte_offset:Buffer.byteLength(first.map(r=>JSON.stringify(r)).join('\n')+'\n')}});nextMeta.ordinal=5;context.ordinal=6;r2.ordinal=7;
  await writeFile(join(f.root,'sessions',`rollout-2026-10-01T01-00-00-${thread}_20000000-0000-4000-8000-000000000002.jsonl`),[nextMeta,context,r2].map(r=>JSON.stringify(r)).join('\n')+'\n');
  await refreshCodexHome(f.root,{indexFile});const db=openLocalIndexStore(indexFile);try{
   const normalized=path=>path.replaceAll('\\','/').toLowerCase();
   const row=db.prepare('SELECT id,path FROM source').all().find(row=>normalized(row.path)===normalized(f.path));assert.ok(row);
   db.prepare("DELETE FROM source_diagnostic WHERE source_id=? AND code='responseModelRecoveryVersion'").run(row.id);
   db.prepare("INSERT INTO source_diagnostic(source_id,code,count) VALUES (?,'responseModelUnattributed',1) ON CONFLICT(source_id,code) DO UPDATE SET count=1").run(row.id);
  }finally{db.close();}
  const recovered=await refreshCodexHome(f.root,{indexFile});assert.equal(recovered.sourcesRescanned,1);assert.equal(recovered.sourcesSkipped,1);
  assert.equal((await refreshCodexHome(f.root,{indexFile})).bytesScanned,0);
 }finally{await rm(f.root,{recursive:true});}
});

test('line framing retains only bounded bytes and rejects invalid projection contracts',()=>{
 let seen;const frame=createLineFrame(value=>{seen=value;return '{}';});const bytes=Buffer.from('x'.repeat(300000));
 frame.append(bytes.subarray(0,100));frame.append(bytes.subarray(100));assert.equal(frame.finish(),'{}');assert.equal(Buffer.byteLength(seen.prefix),512);assert.equal(Buffer.byteLength(seen.suffix),128*1024);
 for(const value of [{},42,'x'.repeat(128*1024+1)])assert.throws(()=>projectCompleteLine(()=>value,Buffer.from('{}')),{name:'TypeError'});
 assert.equal(projectCompleteLine(()=>undefined,Buffer.from('{}')),undefined);
});
test('unresolved model is evaluated once and remains explicit without writes or scans on a second refresh',async()=>{
 const r=response(2),f=await fixture([meta,started,r,checkpoint(3,r),ctx(4,'gpt-6-astra')]),indexFile=join(f.root,'index.sqlite');try{
  await refreshCodexHome(f.root,{indexFile});await requireRecovery(indexFile);const recovered=await refreshCodexHome(f.root,{indexFile});assert.equal(recovered.sourcesRescanned,1);
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare('SELECT m.model_id FROM usage_event u JOIN model m ON m.id=u.model_id').get().model_id),'unknown');
  const stable=await refreshCodexHome(f.root,{indexFile});assert.equal(stable.writeTransactions,0);assert.equal(stable.bytesScanned,0);
 }finally{await rm(f.root,{recursive:true});}
});
test('cancelled recovery rolls back both model evaluation marker and facts, and the next pass resumes',async()=>{
 const r=response(2),f=await fixture([meta,started,r,checkpoint(3,r),ctx(4)]),indexFile=join(f.root,'index.sqlite');try{
  await refreshCodexHome(f.root,{indexFile});await requireRecovery(indexFile);const abort=new AbortController();abort.abort();
  await assert.rejects(refreshCodexHome(f.root,{indexFile,signal:abort.signal}));
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare("SELECT COUNT(*) n FROM source_diagnostic WHERE code='responseModelRecoveryVersion'").get().n),0);
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare('SELECT COUNT(*) n FROM usage_event').get().n),1);
  assert.equal((await refreshCodexHome(f.root,{indexFile})).sourcesRescanned,1);
 }finally{await rm(f.root,{recursive:true});}
});
test('checkpoint conflict does not commit a recovery marker or replace last-good usage; repaired source resumes',async()=>{
 const r=response(2),good=[meta,started,r,checkpoint(3,r),ctx(4)],f=await fixture(good),indexFile=join(f.root,'index.sqlite');try{
  await refreshCodexHome(f.root,{indexFile});await requireRecovery(indexFile);
  const changed=checkpoint(3,r);changed.payload.latest_token_usage_record={...r.payload,usage:raw(2),turn_token_usage:raw(2)};
  await writeFile(f.path,[meta,started,r,changed,ctx(4)].map(r=>JSON.stringify(r)).join('\n')+'\n');
  await assert.rejects(refreshCodexHome(f.root,{indexFile}),{code:'codex_response_usage_checkpoint_conflict'});
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare("SELECT COUNT(*) n FROM source_diagnostic WHERE code='responseModelRecoveryVersion'").get().n),0);
  assert.equal(withReadOnlyStore(indexFile,db=>db.prepare('SELECT COUNT(*) n,SUM(total_input_context) input FROM usage_event').get().input),100);
  await writeFile(f.path,good.map(r=>JSON.stringify(r)).join('\n')+'\n');await refreshCodexHome(f.root,{indexFile});assert.equal((await refreshCodexHome(f.root,{indexFile})).bytesScanned,0);
 }finally{await rm(f.root,{recursive:true});}
});
