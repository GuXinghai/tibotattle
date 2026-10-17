// Decode only a bounded, structurally complete payload suffix. Replacement
// history is never parsed or projected. A future/oversized receipt stays unknown.
const instant = value => typeof value==='string'&&Number.isFinite(Date.parse(value));
const identifier = value => typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/u.test(value);
const scalarModel = value => typeof value==='string'&&/^[A-Za-z0-9_.:/-]{1,128}$/u.test(value)?value:null;
const USAGE_KEYS=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const selectUsage=value=>value&&typeof value==='object'?Object.fromEntries(USAGE_KEYS.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]])):null;

export function projectCompactionUsageLine({prefix,suffix}) {
  const match=/^\{"timestamp":"([^"\r\n]{1,64})"(?:,"ordinal":(?:0|[1-9][0-9]{0,15}))?,"type":"compacted","payload":/u.exec(prefix)
    ?? /^\{"type":"compacted","timestamp":"([^"\r\n]{1,64})","payload":/u.exec(prefix);
  if(!match||!instant(match[1]))return undefined;
  const record={timestamp:match[1],type:'compacted',payload:{}};
  const matches=[...suffix.matchAll(/(?<!\\)"compaction_response_id":/gu)];
  if(matches.length>16)return JSON.stringify(record);
  for(const candidate of matches){
    let payload;try{payload=JSON.parse('{"payload":{'+suffix.slice(candidate.index)).payload;}catch{continue;}
    // Closing braces must complete exactly the original payload and root. A key
    // inside a nested history object or escaped content cannot pass this parse.
    const latest=payload.latest_token_usage_record;
    if(!identifier(payload.compaction_response_id)||!latest||!identifier(latest.response_id)
      ||!identifier(latest.thread_id)||!identifier(latest.turn_id))return JSON.stringify(record);
    record.payload={compaction_response_id:payload.compaction_response_id,
      latest_token_usage_record:{response_id:latest.response_id,thread_id:latest.thread_id,turn_id:latest.turn_id,
        usage:selectUsage(latest.usage),turn_token_usage:selectUsage(latest.turn_token_usage)},
      resume_metadata:{previous_turn_settings:{model:scalarModel(payload.resume_metadata?.previous_turn_settings?.model)}}};
    return JSON.stringify(record);
  }
  return JSON.stringify(record);
}
