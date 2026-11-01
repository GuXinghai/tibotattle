import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {readCodexRuntimeLogBatch} from './platform/index.js';
import {projectRuntimeModelEvidence} from './providers/codex/logs.js';
import {recognizedExportModelId} from './export/index.js';
import {readExistingDeviceSalt,localDigest} from './local-index-identity.js';
import {openLocalIndexStore,openLocalIndexEvidenceStore,createLocalIndexWriter,EVENT_FLAG_RUNTIME_MODEL} from './local-index-store.js';
import {pruneEmptyRollups} from './local-index-rollup.js';
import {sourceImpactSummary} from './local-index-impact.js';

const CURSOR='runtime_model_capture_v1';
const error=code=>Object.assign(new Error(code),{code});
const responseKey=(salt,thread,response)=>localDigest(salt,'unified-index-response',createHash('sha256')
  .update('codex-response-usage/v1\0').update(JSON.stringify([thread,response])).digest('hex'));
function checkpoint(db){
  const raw=db.prepare('SELECT value FROM meta WHERE key=?').get(CURSOR)?.value;
  if(!raw)return {identity:null,lastId:0,status:'pending',errorCode:null};
  let c;try{c=JSON.parse(raw);}catch{throw error('runtime_evidence_checkpoint_invalid');}
  if(!c||Object.keys(c).some(k=>!['identity','lastId','status','errorCode','checkedAt','coverageGap','captured'].includes(k))
    ||!Number.isSafeInteger(c.lastId)||c.lastId<0||!(c.identity===null||/^[a-f0-9]{64}$/u.test(c.identity))
    ||!['pending','available','catching_up','unavailable','partial'].includes(c.status)
    ||!(c.errorCode===null||['runtime_evidence_conflict','runtime_evidence_oversized'].includes(c.errorCode))
    ||typeof c.coverageGap!=='boolean'||!Number.isSafeInteger(c.captured)||c.captured<0
    ||typeof c.checkedAt!=='string'||!Number.isFinite(Date.parse(c.checkedAt)))throw error('runtime_evidence_checkpoint_invalid');
  return c;
}
export function readRuntimeModelEvidenceStatus(db){
  const c=checkpoint(db);
  return {status:c.status,checkedAt:c.checkedAt??null,errorCode:c.errorCode??null,
    coverageGap:c.coverageGap===true,captured:c.captured??0};
}

/** No raw log body is retained. Evidence and high-water mark commit together. */
export async function captureRuntimeModelEvidence({indexFile,codexHome,secretFile=join(dirname(indexFile),'local-unified-index-device-salt-v1'),
  readBatch=readCodexRuntimeLogBatch,signal,now=()=>Date.now()}={}){
  signal?.throwIfAborted();if(!existsSync(indexFile))return {status:'pending',errorCode:null};
  const salt=await readExistingDeviceSalt(secretFile);let db;
  try{
    db=openLocalIndexEvidenceStore(indexFile);const c=checkpoint(db);
    const batch=await readBatch({codexHome,afterId:c.lastId,identity:c.identity,signal});
    signal?.throwIfAborted();
    const writer=createLocalIndexWriter(db);writer.begin();let captured=0,applied=0,oversized=0;
    try{
      const insert=db.prepare(`INSERT OR IGNORE INTO runtime_model_evidence
        (evidence_key,response_key,thread_key,turn_key,observed_at_ms,kind,model,previous_model,digest) VALUES (?,?,?,?,?,?,?,?,?)`);
      const find=db.prepare('SELECT digest FROM runtime_model_evidence WHERE evidence_key=?');
      for(const row of batch.rows){
        signal?.throwIfAborted();if(row.bytes>1048576){oversized++;continue;}
        const p=projectRuntimeModelEvidence(row);if(!p)continue;
        const model=p.kind==='response_reference'?'unknown':recognizedExportModelId(p.model),previous=p.previousModel===null?null:recognizedExportModelId(p.previousModel);
        if(!model||p.previousModel!==null&&!previous)continue;
        const subject=JSON.stringify([p.kind,p.thread,p.turn,p.response,model,previous]);
        const key=localDigest(salt,'runtime-model-evidence',subject),digest=createHash('sha256').update(subject).digest();
        const existing=find.get(key);if(existing&&!Buffer.from(existing.digest).equals(digest))throw error('runtime_evidence_conflict');
        captured+=Number(insert.run(key,p.response?responseKey(salt,p.thread,p.response):null,
          localDigest(salt,'runtime-thread',p.thread),p.turn?localDigest(salt,'runtime-turn',JSON.stringify([p.thread,p.turn])):null,
          p.atMs,p.kind,model,previous,digest).changes);
      }
      const next={identity:batch.identity,lastId:batch.lastId,status:batch.status==='unavailable'?'unavailable':batch.more?'catching_up':'available',
        errorCode:c.errorCode==='runtime_evidence_conflict'?'runtime_evidence_conflict':oversized?'runtime_evidence_oversized':null,
        checkedAt:new Date(now()).toISOString(),coverageGap:c.coverageGap===true||batch.gap===true||batch.restarted===true,captured:(c.captured??0)+captured};
      if(next.errorCode)next.status='partial';
      db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(CURSOR,JSON.stringify(next));
      if(applied)pruneEmptyRollups(db);
      writer.commit({sourcesChanged:0,bumpSeq:applied>0});
      return {...readRuntimeModelEvidenceStatus(db),more:batch.more,capturedNow:captured,applied,readRows:batch.rows.length};
    }catch(e){writer.rollback();throw e;}
  }finally{db?.close();}
}

function impactRange(oldImpact, newImpact) {
  const values = [oldImpact.min, oldImpact.max, newImpact.min, newImpact.max]
    .filter((value) => value !== null);
  return values.length === 0
    ? { lower: null, upper: null }
    : { lower: Math.min(...values), upper: Math.max(...values) };
}

function correctionPartitions({ sourceId, sessionId }, oldImpact, newImpact) {
  const range = impactRange(oldImpact.usage, newImpact.usage);
  const partitions = [{
    partitionKind: "usage_time_range",
    partitionKey: `usage_time_range:${sourceId}`,
    lowerMs: range.lower,
    upperMs: range.upper,
    sessionId,
    basisKind: "fact_delta",
    status: "dirty",
  }, {
    partitionKind: "work_time_range",
    partitionKey: `work_time_range:${sourceId}`,
    lowerMs: range.lower,
    upperMs: range.upper,
    sessionId,
    basisKind: "fact_delta",
    status: "dirty",
  }, {
    partitionKind: "accounting_window",
    partitionKey: "current",
    lowerMs: range.lower,
    upperMs: range.upper,
    sessionId,
    basisKind: "fact_delta",
    status: "pending",
  }];
  if (sessionId !== null) {
    partitions.push({
      partitionKind: "session",
      partitionKey: `session:${sessionId}`,
      sessionId,
      basisKind: "fact_delta",
      status: "pending",
    });
  }
  return partitions;
}

/** Reconcile only at the foreground index publication boundary, never from the capture timer. */
export function reconcileRuntimeModelEvidence({indexFile,signal}={}){
  signal?.throwIfAborted();if(!existsSync(indexFile))return {applied:0,errorCode:null};
  const db=openLocalIndexStore(indexFile);let writer;
  try{
    if(!db.prepare("SELECT 1 FROM runtime_model_evidence WHERE kind='response_completed' LIMIT 1").get())return {applied:0,errorCode:null};
    writer=createLocalIndexWriter(db);writer.begin();let applied=0;
      // Exact success receipts may fill an unknown model, never replace a known model.
      // Context and fallback receipts without a response identity remain evidence only.
      const candidates=db.prepare(`SELECT u.event_key,u.flags,u.source_id,u.session_id,e.model,e.observed_at_ms
        FROM usage_event u JOIN model m ON m.id=u.model_id JOIN runtime_model_evidence e ON e.response_key=u.event_key
        WHERE e.kind='response_completed' AND (u.flags&16)<>0 AND u.source_offset<=(SELECT scanned_bytes FROM source WHERE id=u.source_id)
        AND ABS(e.observed_at_ms-u.observed_at_ms)<=300000 LIMIT 10001`).all();
      if(candidates.length>10000)throw error('runtime_evidence_limit');
      const sourceStates=new Map();
      for(const r of candidates){
        const sourceId=Number(r.source_id);
        if(!sourceStates.has(sourceId))sourceStates.set(sourceId,{sourceId,
          sessionId:r.session_id===null||r.session_id===undefined?null:Number(r.session_id)});
      }
      const oldImpacts=new Map([...sourceStates.values()]
        .map(state=>[state.sourceId,sourceImpactSummary(db,state)]));
      const affected=new Set();
      const byKey=new Map();for(const r of candidates){const k=Buffer.from(r.event_key).toString('hex'),list=byKey.get(k)??[];list.push(r);byKey.set(k,list);}
      let conflict=false;
      for(const rows of byKey.values()){
        const models=new Set(rows.map(r=>r.model));if(models.size!==1){conflict=true;
          if(rows[0].flags&EVENT_FLAG_RUNTIME_MODEL){
            const changed=Number(db.prepare('UPDATE usage_event SET model_id=?,flags=flags&? WHERE event_key=?')
              .run(writer.internModel('unknown','missing'),~EVENT_FLAG_RUNTIME_MODEL,rows[0].event_key).changes);
            applied+=changed;if(changed>0)affected.add(Number(rows[0].source_id));
          }
          continue;}
        const r=rows[0],wanted=[...models][0];
        const current=db.prepare('SELECT m.model_id FROM usage_event u JOIN model m ON m.id=u.model_id WHERE u.event_key=? AND (u.flags&16)<>0').get(r.event_key)?.model_id;
        if(current==='unknown'){
          const changed=Number(db.prepare('UPDATE usage_event SET model_id=?,flags=flags|? WHERE event_key=? AND (flags&16)<>0').run(writer.internModel(wanted,'recognized'),EVENT_FLAG_RUNTIME_MODEL,r.event_key).changes);
          applied+=changed;if(changed>0)affected.add(Number(r.source_id));
        } else if(current!==wanted)conflict=true;
      }

    signal?.throwIfAborted();
    const c=checkpoint(db);
    if(c.checkedAt){c.errorCode=conflict?'runtime_evidence_conflict':null;if(conflict)c.status='partial';
      db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify(c),CURSOR);}
    if(applied)pruneEmptyRollups(db);
    if(applied){
      const sourceRow=db.prepare('SELECT file_id,size_bytes,scanned_bytes FROM source WHERE id=?');
      const recorded=[...affected].slice(0,256);
      for(const sourceId of recorded){
        const state=sourceStates.get(sourceId);
        const oldImpact=oldImpacts.get(sourceId)??sourceImpactSummary(db,state);
        const newImpact=sourceImpactSummary(db,state);
        const source=sourceRow.get(sourceId)??{};
        writer.recordSourceChange({
          sourceId,mode:'fact_correction',reason:'runtime_model_evidence',
          oldFileId:source.file_id??null,newFileId:source.file_id??null,
          oldScannedBytes:Number(source.scanned_bytes??0),newScannedBytes:Number(source.scanned_bytes??0),
          oldSizeBytes:Number(source.size_bytes??0),newSizeBytes:Number(source.size_bytes??0),
          oldEventCount:oldImpact.usage.count,newEventCount:newImpact.usage.count,
          confidence:'exact',
          factCounts:[{factKind:'usage',oldCount:oldImpact.usage.count,newCount:newImpact.usage.count,
            oldMinAtMs:oldImpact.usage.min,oldMaxAtMs:oldImpact.usage.max,
            newMinAtMs:newImpact.usage.min,newMaxAtMs:newImpact.usage.max}],
          partitions:correctionPartitions(state,oldImpact,newImpact),
          gaps:[],createdAtMs:Date.now(),
        });
      }
      if(affected.size===0||affected.size>recorded.length)writer.markManifestIncomplete();
    }
    writer.commit({sourcesChanged:0,bumpSeq:applied>0});return {applied,errorCode:conflict?'runtime_evidence_conflict':null};
  }catch(e){writer?.rollback();throw e;}finally{db.close();}
}

/** Background collection does not publish UI reports or run a rollout scan. */
export function createRuntimeModelEvidenceCapture(options){
  let timer=null,running=null,closed=false,started=false,controller=null,failures=0;
  let state={status:'pending',errorCode:null};
  async function tick(){
    if(closed)return state;if(running)return running;
    if(timer){clearTimeout(timer);timer=null;}
    controller=new AbortController();
    running=(async()=>{try{
      for(let i=0;i<4;i++){
        state=await captureRuntimeModelEvidence({...options,signal:controller.signal});
        if(!state.more)break;
      }
      failures=0;
    }catch(e){if(!controller.signal.aborted){failures++;state={status:'failed',errorCode:/^runtime_evidence_[a-z_]+$/u.test(e?.code??'')?e.code:'runtime_evidence_capture_failed'};}
    }finally{running=null;if(!closed&&started&&failures<3){timer=setTimeout(tick,state.more?1000:30000);timer.unref?.();}}return state;})();
    return running;
  }
  return {start(){if(!started&&!closed){started=true;void tick();}},tick,status:()=>({...state}),
    async close(){closed=true;if(timer)clearTimeout(timer);controller?.abort();await running;}};
}
