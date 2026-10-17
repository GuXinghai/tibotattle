import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createLocalCodexMetadataFilesystem} from './local-codex-metadata-filesystem.js';

const fail=code=>Object.assign(new Error(code),{code});
/** A bounded read transaction, including committed WAL. Raw bodies live only in this call's result. */
export async function readCodexRuntimeLogBatch({codexHome,afterId=0,identity=null,signal,
  filesystem=createLocalCodexMetadataFilesystem(),databaseFactory=path=>new DatabaseSync(path,{readOnly:true,timeout:1000})}={}){
  if(typeof codexHome!=='string'||!Number.isSafeInteger(afterId)||afterId<0)throw new TypeError('Invalid runtime log query');
  signal?.throwIfAborted();let guard,db;
  try{
    guard=await filesystem.guardDatabase(join(codexHome,'logs_2.sqlite'));
    if(!await guard.validate())throw fail('runtime_evidence_source_changed');
    db=databaseFactory(guard.databasePath);db.exec('PRAGMA query_only=ON;BEGIN');
    const generation=db.prepare("SELECT COALESCE(MAX(installed_on),'') installed FROM _sqlx_migrations").get().installed;
    const range=db.prepare('SELECT MIN(id) lo,MAX(id) hi FROM logs').get();
    // Physical identity is leased by the filesystem; a replaced log DB resets only its read cursor.
    const stamp=createHash('sha256').update(`${guard.identity??guard.databasePath}\0${generation}`).digest('hex');
    const restarted=identity!==null&&identity!==stamp||range.hi!==null&&range.hi<afterId;
    const cursor=restarted?0:afterId;
    const rows=[];let bytes=0,lastId=cursor;
    for(const row of db.prepare(`SELECT id,ts,ts_nanos,
      CASE WHEN length(target)<=160 THEN target END target,
      CASE WHEN length(thread_id)<=256 THEN thread_id END thread_id,
      CASE WHEN length(CAST(feedback_log_body AS BLOB))<=1048576 THEN feedback_log_body END body,
      length(CAST(feedback_log_body AS BLOB)) bytes FROM logs WHERE id>? ORDER BY id LIMIT 1000`).iterate(cursor)){
      signal?.throwIfAborted();if(bytes+(row.bytes??0)>8*1024*1024&&rows.length)break;
      bytes+=Math.min(row.bytes??0,1048576);lastId=row.id;rows.push(row);
    }
    db.exec('COMMIT');if(!await guard.validate())throw fail('runtime_evidence_source_changed');
    return {identity:stamp,lastId,rows,more:range.hi!==null&&lastId<range.hi,
      restarted,gap:cursor>0&&range.lo!==null&&range.lo>cursor+1,bytes};
  }catch(error){if(signal?.aborted)throw signal.reason;
    if(error?.code?.startsWith('runtime_evidence_'))throw error;
    if(['ENOENT','WINDOWS_FILESYSTEM_NOT_FOUND'].includes(error?.code))return {status:'unavailable',rows:[],more:false,lastId:afterId,identity};
    throw fail('runtime_evidence_read_failed');
  }finally{db?.close();await guard?.release();}
}
