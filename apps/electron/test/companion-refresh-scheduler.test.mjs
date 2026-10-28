import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, EventEmitter } from "node:events";
import test from "node:test";
import { createCompanionSupervisor } from "../companion-supervisor.js";

test("owned child receives initial cadence and live disabled/reenabled values over fixed IPC", async t => {
  const moduleUrl = new URL("../../local/overview-refresh-scheduler.js", import.meta.url).href;
  const source = `
    const {attachOverviewRefreshIntervalChannel} = await import(${JSON.stringify(moduleUrl)});
    let seconds = Number(process.env.USAGE_MONITOR_REFRESH_INTERVAL_SECONDS);
    let paused = process.env.USAGE_MONITOR_REFRESH_PAUSED === 'true';
    attachOverviewRefreshIntervalChannel({channel:process,scheduler:{setIntervalSeconds(value){seconds=value;},setPaused(value){paused=value;}}});
    process.on('message', message => {if(message?.type==='test.status') process.send({seconds,paused});});
    process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4546/\\n');
  `;
  let child, selected;
  const supervisor = createCompanionSupervisor({ command: process.execPath,
    args: ["--input-type=module", "--eval", source], environment: {},
    spawnChild(command, args, options) { selected = options; child = spawn(command, args, options); return child; },
  });
  t.after(async () => { await supervisor.stop().catch(() => {}); });
  assert.equal(supervisor.setRefreshInterval(420), false);
  await supervisor.start();
  assert.equal(selected.env.USAGE_MONITOR_REFRESH_INTERVAL_SECONDS, "420");
  assert.deepEqual(selected.stdio, ["ignore", "pipe", "pipe", "ipc"]);
  const status = async () => { const next = once(child, "message"); child.send({ type: "test.status" }); return (await next)[0]; };
  assert.deepEqual(await status(), { seconds: 420, paused: false });
  assert.equal(await supervisor.setRefreshInterval(-1), true);
  assert.deepEqual(await status(), { seconds: -1, paused: false });
  assert.equal(await supervisor.setRefreshInterval(60), true);
  assert.deepEqual(await status(), { seconds: 60, paused: false });
  await supervisor.setRefreshInterval(60, true);
  assert.deepEqual(await status(), { seconds: 60, paused: true });
  assert.throws(() => supervisor.setRefreshInterval(60, "true"), /refresh pause is invalid/u);
  for (const value of [0, 61, "60", Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => supervisor.setRefreshInterval(value), /refresh interval is invalid/u);
  }
  await supervisor.stop();
  await supervisor.start();
  assert.equal(selected.env.USAGE_MONITOR_REFRESH_INTERVAL_SECONDS, "60");
  assert.equal(selected.env.USAGE_MONITOR_REFRESH_PAUSED, "true");
  assert.deepEqual(await status(), { seconds: 60, paused: true });
});

test("unknown speed policy reaches initial and restarted child and live IPC without refresh messages", async t => {
 const source = `
  let policy=JSON.parse(process.env.USAGE_MONITOR_UNKNOWN_SPEED_POLICY);
  const messages=[];
  process.on('message',m=>{if(m.type==='usagemonitor.unknown-speed-policy.v1'){policy=m.policy;messages.push(m.type);process.send({type:'usagemonitor.unknown-speed-policy-applied.v1',requestId:m.requestId});}if(m.type==='test.status')process.send({policy,messages});});
  process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4546/\\n');
 `;
 let child, selected;
 const supervisor=createCompanionSupervisor({command:process.execPath,args:["--eval",source],environment:{},spawnChild(command,args,options){selected=options;child=spawn(command,args,options);return child;}});
 t.after(async()=>{await supervisor.stop().catch(()=>{});});
 const initial={mode:"custom",customFastRatioBps:303};
 assert.equal(supervisor.setUnknownSpeedPolicy(initial),false);
 await supervisor.start();
 assert.deepEqual(selected.stdio,["ignore","pipe","pipe","ipc"]);
 assert.deepEqual(JSON.parse(selected.env.USAGE_MONITOR_UNKNOWN_SPEED_POLICY),initial);
 const status=async()=>{const next=once(child,"message");child.send({type:"test.status"});return(await next)[0];};
 assert.deepEqual(await status(),{policy:initial,messages:[]});
 const next={mode:"fast",customFastRatioBps:303};
 await supervisor.setUnknownSpeedPolicy(next);
 assert.deepEqual(await status(),{policy:next,messages:["usagemonitor.unknown-speed-policy.v1"]});
 assert.throws(()=>supervisor.setUnknownSpeedPolicy({mode:"custom",customFastRatioBps:null}),TypeError);
 await supervisor.stop();await supervisor.start();
 assert.deepEqual(await status(),{policy:next,messages:[]});
});


test("policy save remains pending until the child applies policy and acknowledges its request", async t => {
 const source=`
 let policy=JSON.parse(process.env.USAGE_MONITOR_UNKNOWN_SPEED_POLICY);
 process.on('message',m=>{if(m.type==='usagemonitor.unknown-speed-policy.v1'){
   process.send({type:'usagemonitor.unknown-speed-policy-applied.v1',requestId:m.requestId,extra:true});
   setTimeout(()=>{policy=m.policy;process.send({type:'usagemonitor.unknown-speed-policy-applied.v1',requestId:m.requestId});},150);
 }if(m.type==='test.status')process.send({policy});});
 process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4546/\\n');`;
 let child;
 const supervisor=createCompanionSupervisor({command:process.execPath,args:["--eval",source],environment:{},spawnChild(command,args,options){child=spawn(command,args,options);return child;}});
 t.after(async()=>{await supervisor.stop().catch(()=>{});});
 const initial={mode:"standard",customFastRatioBps:null},next={mode:"custom",customFastRatioBps:303};
 supervisor.setUnknownSpeedPolicy(initial);await supervisor.start();
 let settled=false;const saving=supervisor.setUnknownSpeedPolicy(next).then(value=>{settled=true;return value;});
 const status=async()=>{const nextMessage=once(child,"message");child.send({type:"test.status"});let message=(await nextMessage)[0];if(message.type){return new Promise(resolve=>{const listener=m=>{if(!m.type){child.off('message',listener);resolve(m);}};child.on('message',listener);});}return message;};
 // Ignore malformed ACKs while checking the child still holds its old policy.
 const snapshot=await new Promise(resolve=>{const listener=m=>{if(!m.type){child.off('message',listener);resolve(m);}};child.on('message',listener);child.send({type:'test.status'});});
 assert.deepEqual(snapshot.policy,initial);assert.equal(settled,false);
 await saving;assert.equal(settled,true);assert.deepEqual((await status()).policy,next);
 assert.equal(child.listenerCount('message'),0);
});

test("policy ACK timeout and stop reject pending updates, clean listeners, and preserve restart configuration", async t => {
 const source=`let policy=JSON.parse(process.env.USAGE_MONITOR_UNKNOWN_SPEED_POLICY);process.on('message',m=>{if(m.type==='test.status')process.send({policy});});process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4546/\\n');`;
 let child;
 const supervisor=createCompanionSupervisor({command:process.execPath,args:["--eval",source],environment:{},unknownSpeedPolicyTimeoutMs:40,spawnChild(command,args,options){child=spawn(command,args,options);return child;}});
 t.after(async()=>{await supervisor.stop().catch(()=>{});});
 supervisor.setUnknownSpeedPolicy({mode:"standard",customFastRatioBps:null});await supervisor.start();
 await assert.rejects(supervisor.setUnknownSpeedPolicy({mode:"fast",customFastRatioBps:404}),{code:"electron_shell_companion_unknown_speed_policy_unavailable"});
 assert.equal(child.listenerCount('message'),0);assert.equal(child.listenerCount('disconnect'),0);
 const next={mode:"custom",customFastRatioBps:505};
 const saving=supervisor.setUnknownSpeedPolicy(next);const refused=assert.rejects(saving,{code:"electron_shell_companion_unknown_speed_policy_unavailable"});
 await supervisor.stop();await refused;assert.equal(child.listenerCount('message'),0);
 await supervisor.start();const response=once(child,"message");child.send({type:'test.status'});assert.deepEqual((await response)[0].policy,next);
});


test("policy updates during delayed startup apply the latest desired value after READY and ACK", async t => {
 const source=`let policy=JSON.parse(process.env.USAGE_MONITOR_UNKNOWN_SPEED_POLICY);const applied=[];process.on('message',m=>{if(m.type==='usagemonitor.unknown-speed-policy.v1'){policy=m.policy;applied.push(policy);process.send({type:'usagemonitor.unknown-speed-policy-applied.v1',requestId:m.requestId});}if(m.type==='test.status')process.send({policy,applied});});setTimeout(()=>process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4546/\\n'),100);`;
 let child;
 const supervisor=createCompanionSupervisor({command:process.execPath,args:["--eval",source],environment:{},spawnChild(command,args,options){child=spawn(command,args,options);return child;}});
 t.after(async()=>{await supervisor.stop().catch(()=>{});});
 const initial={mode:"standard",customFastRatioBps:null},first={mode:"fast",customFastRatioBps:303},latest={mode:"custom",customFastRatioBps:505};
 supervisor.setUnknownSpeedPolicy(initial);const starting=supervisor.start();
 const firstUpdate=supervisor.setUnknownSpeedPolicy(first);const lastUpdate=supervisor.setUnknownSpeedPolicy(latest);
 assert.equal(typeof firstUpdate.then,'function');await starting;await Promise.all([firstUpdate,lastUpdate]);
 const response=once(child,'message');child.send({type:'test.status'});const status=(await response)[0];
 assert.deepEqual(status.policy,latest);assert.deepEqual(status.applied,[latest,latest]);
 assert.equal(child.listenerCount('message'),0);
});

test("stopping while waiting for startup rejects the pending policy synchronization", async t => {
 const source=`process.on('message',()=>{});setTimeout(()=>process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4546/\\n'),100);`;
 const supervisor=createCompanionSupervisor({command:process.execPath,args:["--eval",source],environment:{}});
 t.after(async()=>{await supervisor.stop().catch(()=>{});});
 supervisor.setUnknownSpeedPolicy({mode:'standard',customFastRatioBps:null});const starting=supervisor.start();
 const updating=supervisor.setUnknownSpeedPolicy({mode:'fast',customFastRatioBps:303});
 const rejected=assert.rejects(updating,{code:'electron_shell_companion_unknown_speed_policy_unavailable'});
 await supervisor.stop().catch(()=>{});await rejected;await starting;
});


test("startup policy synchronization rejects unavailable IPC without hanging or unhandled rejection", async t => {
 for (const failure of ["send_missing", "disconnected"]) {
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.connected=true;
  child.kill=()=>{queueMicrotask(()=>child.emit('exit',0,null));return true;};
  if(failure==='disconnected')child.send=(_message,callback)=>callback?.();
  const supervisor=createCompanionSupervisor({command:process.execPath,environment:{},spawnChild:()=>child});
  supervisor.setUnknownSpeedPolicy({mode:'standard',customFastRatioBps:null});const starting=supervisor.start();
  const updating=supervisor.setUnknownSpeedPolicy({mode:'custom',customFastRatioBps:303});
  if(failure==='disconnected')child.connected=false;
  let timer;
  const bounded=Promise.race([updating,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('policy_sync_hung')),300);})]);
  const refused=assert.rejects(bounded,{code:'electron_shell_companion_unknown_speed_policy_unavailable'});
  child.stdout.emit('data',Buffer.from('USAGE_MONITOR_READY http://127.0.0.1:4546/\n'));
  try{await starting;await refused;await new Promise(resolve=>setImmediate(resolve));assert.equal(child.listenerCount('message'),0);}finally{clearTimeout(timer);await supervisor.stop();}
 }
});
