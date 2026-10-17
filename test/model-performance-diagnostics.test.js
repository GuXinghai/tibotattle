import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createModelPerformanceController} from '../apps/local/model-performance-controller.js';
import {modelPerformanceProjection} from '../src/reporting/index.js';
import {createModelPerformanceSnapshotStore,modelPerformanceSourceScope,isCompleteModelPerformanceSnapshot} from '../apps/local/model-performance-snapshots.js';
import {modelPerformanceHistoryState} from '../apps/local/model-performance-worker.js';
import {mkdtemp,readFile,writeFile,rm,copyFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';

class Worker extends EventEmitter {
  unref() {}
  postMessage(message) { if(message.type==='stop')queueMicrotask(()=>this.emit('exit',0)); }
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const snapshot=()=>modelPerformanceProjection([],{now:Date.parse('2026-10-15T12:00:00Z'),period:'all',speedMode:'standard'});
function fixture(store={read:async()=>null,write:async()=>true}){
  const worker=new Worker(),controller=createModelPerformanceController({directory:'synthetic',codexHome:'synthetic',workerFactory:()=>worker,snapshotStoreFactory:()=>store});
  return {worker,controller};
}
test('collection failures retain a completed v5 snapshot and diagnostics recover independently',async()=>{
  const {worker,controller}=fixture();
  try {
    await controller.read('all');worker.emit('message',{type:'snapshots',values:[snapshot()]});
    worker.emit('message',{type:'diagnostics',codes:['timing_scan_failed','timing_store_failed']});
    assert.deepEqual(controller.diagnostics(),['timing_scan_failed','timing_store_failed']);
    assert.equal((await controller.read('all')).status,'ready');
    worker.emit('message',{type:'diagnostics',codes:[]});assert.deepEqual(controller.diagnostics(),[]);
    worker.emit('error',new Error('synthetic private content'));
    assert.deepEqual(controller.diagnostics(),['timing_worker_failed']);
    assert.equal((await controller.read('all')).stale,true);
    assert.equal(Object.hasOwn(await controller.read('all'),'diagnostics'),false);
  } finally {await controller.close();}
});
test('invalid worker diagnostic payloads fail closed without copying upstream content',async()=>{
  const {worker,controller}=fixture();
  try{await controller.read('all');worker.emit('message',{type:'diagnostics',codes:['synthetic/private/path']});
    assert.deepEqual(controller.diagnostics(),['timing_projection_failed']);
  }finally{await controller.close();}
});
test('failed persistence is visible while completed memory results remain readable',async()=>{
  const {worker,controller}=fixture({read:async()=>null,write:async()=>false});
  try{await controller.read('all');worker.emit('message',{type:'snapshots',values:[snapshot()]});await tick();
    assert.deepEqual(controller.diagnostics(),['timing_snapshot_write_failed']);
    assert.equal((await controller.read('all')).status,'ready');
  }finally{await controller.close();}
});
test('missing snapshots are normal while read failures are separately observable',async()=>{
  for(const fails of [false,true]){
    const {controller}=fixture({read:async()=>{if(fails)throw Error('synthetic');return null;},write:async()=>true});
    try{assert.equal((await controller.read('all')).status,'loading');assert.deepEqual(controller.diagnostics(),fails?['timing_snapshot_read_failed']:[]);}
    finally{await controller.close();}
  }
});
test('successful persistence clears earlier snapshot failure without rewriting the measurement DTO',async()=>{
  let fail=true;const {worker,controller}=fixture({read:async()=>null,write:async()=>!fail});
  await controller.read('all');worker.emit('message',{type:'snapshots',values:[snapshot()]});await tick();
  assert.ok(controller.diagnostics().includes('timing_snapshot_write_failed'));fail=false;
  worker.emit('message',{type:'snapshots',values:[snapshot()]});await tick();
  assert.deepEqual(controller.diagnostics(),[]);await controller.close();
});
test('intact snapshots for another source are distinct from real corruption, including repeated reads',async t=>{
  const root=await mkdtemp(join(tmpdir(),'performance-diagnostic-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const a=createModelPerformanceSnapshotStore({directory:root,codexHome:join(root,'source-a')});
  assert.equal(await a.write([snapshot()]),true);
  const file=join(root,'model-performance-snapshot.json');
  await copyFile(join(root,`model-performance-snapshot-${modelPerformanceSourceScope(join(root,'source-a'))}.json`),file);
  const codes=[],b=createModelPerformanceSnapshotStore({directory:root,codexHome:join(root,'source-b'),onDiagnostic:code=>codes.push(code)});
  assert.equal(await b.read(),null);assert.deepEqual(codes,['timing_snapshot_scope_mismatch']);
  const envelope=JSON.parse(await readFile(file,'utf8'));
  envelope.snapshot.values[0].excludedUnknownTurns=1;
  await writeFile(file,JSON.stringify(envelope));codes.length=0;
  assert.equal(await b.read(),null);assert.deepEqual(codes,['timing_snapshot_invalid']);
  assert.ok(await a.read(),'another source cannot corrupt the isolated current receipt');
});

test('source-specific writes preserve both another source and the legacy receipt; current corruption cannot fall back',async t=>{
  const root=await mkdtemp(join(tmpdir(),'performance-isolation-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const home=join(root,'source-a'),file=join(root,`model-performance-snapshot-${modelPerformanceSourceScope(home)}.json`);
  const a=createModelPerformanceSnapshotStore({directory:root,codexHome:home});await a.write([snapshot()]);
  const bytes=await readFile(file),legacy=join(root,'model-performance-snapshot.json');await copyFile(file,legacy);await rm(file);
  assert.ok(await a.read(),'matching legacy receipt remains usable');
  const b=createModelPerformanceSnapshotStore({directory:root,codexHome:join(root,'source-b')});await b.write([snapshot()]);
  assert.deepEqual(await readFile(legacy),bytes);await a.write([snapshot()]);
  const codes=[],strict=createModelPerformanceSnapshotStore({directory:root,codexHome:home,onDiagnostic:c=>codes.push(c)});
  await writeFile(file,'invalid synthetic receipt');assert.equal(await strict.read(),null);assert.deepEqual(codes,['timing_snapshot_invalid']);
  assert.deepEqual(await readFile(legacy),bytes);assert.ok(await b.read());
});

test('a finished partial scan saves its stale state and recovers the old-source warning without hiding unavailable history',async t=>{
  const root=await mkdtemp(join(tmpdir(),'performance-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const oldHome=join(root,'old-source'),home=join(root,'current-source');
  const old=createModelPerformanceSnapshotStore({directory:root,codexHome:oldHome});await old.write([snapshot()]);
  const legacy=join(root,'model-performance-snapshot.json');await copyFile(join(root,`model-performance-snapshot-${modelPerformanceSourceScope(oldHome)}.json`),legacy);
  const original=await readFile(legacy),worker=new Worker();
  const controller=createModelPerformanceController({directory:root,codexHome:home,workerFactory:()=>worker});
  await controller.read('all');assert.deepEqual(controller.diagnostics(),['timing_snapshot_scope_mismatch']);
  worker.emit('message',{type:'diagnostics',codes:['timing_history_unavailable']});
  const partial={...snapshot(),stale:true,historyProgress:{checked:1,total:1}};
  assert.equal(isCompleteModelPerformanceSnapshot(partial),false);
  worker.emit('message',{type:'snapshots',cacheable:true,values:[partial]});await controller.close();
  assert.deepEqual(controller.diagnostics(),['timing_history_unavailable']);assert.deepEqual(await readFile(legacy),original);
  const restarted=createModelPerformanceController({directory:root,codexHome:home,workerFactory:()=>new Worker()});
  try{const r=await restarted.read('all');assert.equal(r.stale,true);assert.equal(r.status,'ready');assert.deepEqual(restarted.diagnostics(),[]);}
  finally{await restarted.close();}
});

test('unfinished partial scans and undeclared failed scans do not overwrite the saved result',async()=>{
  let writes=0;const {worker,controller}=fixture({read:async()=>null,write:async()=>{writes++;return true;}});
  try{await controller.read('all');
    worker.emit('message',{type:'snapshots',cacheable:true,values:[{...snapshot(),stale:true,historyProgress:{checked:0,total:1}}]});
    worker.emit('message',{type:'snapshots',values:[{...snapshot(),stale:true}]});await tick();assert.equal(writes,0);
    worker.emit('message',{type:'snapshots',cacheable:'untrusted',values:[snapshot()]});assert.ok(controller.diagnostics().includes('timing_projection_failed'));
  }finally{await controller.close();}
});

test('history availability distinguishes discovery, pending repairs and resolved parser evidence',()=>{
  const source={digest:'synthetic',parserVersion:0,replayParserVersion:0};
  assert.deepEqual(modelPerformanceHistoryState([source],18,null),{pending:1,unavailable:0,recoveryFailed:0});
  assert.deepEqual(modelPerformanceHistoryState([source],18,new Set()),{pending:0,unavailable:1,recoveryFailed:0});
  assert.deepEqual(modelPerformanceHistoryState([source],18,new Set(['synthetic'])),{pending:1,unavailable:0,recoveryFailed:0});
  assert.deepEqual(modelPerformanceHistoryState([{...source,parserVersion:18}],18,new Set(['synthetic'])),{pending:0,unavailable:0,recoveryFailed:0});
  assert.deepEqual(modelPerformanceHistoryState([{...source,parserVersion:18,rebuilding:true}],18,new Set(['synthetic'])),{pending:1,unavailable:0,recoveryFailed:0});
  assert.deepEqual(modelPerformanceHistoryState([{...source,parserVersion:18,rebuilding:true}],18,new Set()),{pending:0,unavailable:1,recoveryFailed:1});
});


test('source recovery errors remain visible with old results and clear after recovery', async () => {
  const { worker, controller } = fixture();
  try {
    await controller.read('all');
    worker.emit('message', { type: 'snapshots', values: [snapshot()] });
    for (const code of ['timing_source_recovery_failed', 'timing_source_decode_failed', 'timing_source_read_failed', 'timing_source_limit', 'timing_source_unsupported']) {
      worker.emit('message', { type: 'diagnostics', codes: [code] });
      assert.deepEqual(controller.diagnostics(), [code]);
      assert.equal((await controller.read('all')).status, 'ready');
      worker.emit('message', { type: 'diagnostics', codes: [] });
      assert.deepEqual(controller.diagnostics(), []);
    }
  } finally { await controller.close(); }
});
