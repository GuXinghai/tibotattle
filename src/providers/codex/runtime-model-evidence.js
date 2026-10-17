// Explicit diagnostic fields only. Settings and span models are retained as context,
// never promoted to a successful response model. No body or raw identity is persisted.
const ID=/^[a-zA-Z0-9_.:-]{1,256}$/u;
const MODEL=/^gpt-[0-9][a-zA-Z0-9_.-]{0,95}$/u;
function field(body,name){
  const values=[...body.matchAll(new RegExp(`(?:^|[\\s,{])${name}=(?:"([^"\\\\]{1,256})"|([a-zA-Z0-9_.:-]{1,256}))(?=$|[\\s,}])`,'gu'))].map(m=>m[1]??m[2]);
  const unique=new Set(values);return unique.size===1?values[0]:null;
}
export function projectRuntimeModelEvidence(row){
  const body=row?.body;if(typeof body!=='string'||body.length>1048576||typeof row.target!=='string')return null;
  if(!Number.isSafeInteger(row.ts)||row.ts<0||!(row.ts_nanos==null||Number.isSafeInteger(row.ts_nanos)&&row.ts_nanos>=0&&row.ts_nanos<1000000000))return null;
  if(!/^(?:codex_core::|codex_api::|feedback_tags$)/u.test(row.target))return null;
  const marker='SSE event: ',markerOffset=row.target==='codex_api::sse::responses'?body.indexOf(marker):-1;
  const fields=markerOffset>=0?body.slice(0,markerOffset):body;
  const thread=row.thread_id,embedded=field(fields,'thread_id');
  if(typeof thread!=='string'||!ID.test(thread)||embedded!==null&&embedded!==thread)return null;
  if(row.target==='codex_api::sse::responses'){
    const offset=markerOffset;
    if(offset>=0){
      let event;try{event=JSON.parse(body.slice(offset+marker.length));}catch{return null;}
      const response=event?.response;
      if(event?.type==='response.completed'&&response?.status==='completed'
        &&ID.test(response.id??'')&&MODEL.test(response.model??'')){
        const atMs=row.ts*1000+Math.floor((row.ts_nanos??0)/1e6);
        if(!Number.isSafeInteger(atMs)||atMs<0)return null;
        return {kind:'response_completed',model:response.model,previousModel:null,thread,turn:field(fields,'turn_id'),response:response.id,atMs};
      }
      // Text inside other SSE event payloads cannot forge a completion receipt.
      return null;
    }
  }
  const turn=field(body,'turn_id');let response=field(body,'response_id');
  let kind=null,model=null,previousModel=null;
  if(row.target==='codex_core::compact_model_fallback'&&body.includes('previous-model compaction failed; retried with current model')){
    const outcome=field(body,'outcome');model=field(body,'current_model');previousModel=field(body,'previous_model');
    if(!turn||!MODEL.test(previousModel??'')||!['succeeded','failed'].includes(outcome))return null;
    kind=outcome==='succeeded'?'fallback_succeeded':'fallback_failed';
  }else if(turn&&field(body,'model')){model=field(body,'model');kind='request_context';}
  else if(row.target==='feedback_tags'&&field(body,'last_model_response_id')){response=field(body,'last_model_response_id');model='unknown';kind='response_reference';}
  else return null;
  if(!(MODEL.test(model??'')||kind==='response_reference'&&model==='unknown')||turn!==null&&!ID.test(turn)||response!==null&&!ID.test(response))return null;
  const atMs=row.ts*1000+Math.floor((row.ts_nanos??0)/1e6);
  if(!Number.isSafeInteger(atMs)||atMs<0)return null;
  return {kind,model,previousModel,thread,turn,response,atMs};
}
