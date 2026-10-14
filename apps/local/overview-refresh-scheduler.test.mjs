import test from "node:test";
import assert from "node:assert/strict";
import {createOverviewRefreshScheduler} from "./overview-refresh-scheduler.js";
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
test("manual completion restarts five minutes, invalidates the old deadline and joins duplicate requests",async()=>{
  let now=0,id=0,busy=false,complete,starts=0,promise=Promise.resolve();const timers=new Map();
  const refresh={start({mode}){assert.equal(mode,"overview");if(busy)return false;starts++;busy=true;promise=new Promise(r=>{complete=()=>{busy=false;r();};});return true;},whenSettled:()=>promise};
  const scheduler=createOverviewRefreshScheduler({refresh,clock:()=>now,setTimer:(fn,ms)=>{timers.set(++id,{fn,at:now+ms});return id;},clearTimer:(key)=>timers.delete(key)});
  const advance=async(to)=>{now=to;for(const [key,t]of [...timers])if(t.at<=now){timers.delete(key);t.fn();}await settle();};
  scheduler.start();assert.equal(timers.size,1);
  await advance(100000);assert.equal(scheduler.request(),true);assert.equal(scheduler.request(),false);assert.equal(starts,1);assert.equal(timers.size,0);
  now=120000;complete();await settle();assert.equal(timers.size,1);assert.equal([...timers.values()][0].at,420000);
  await advance(300000);assert.equal(starts,1);await advance(420000);assert.equal(starts,2);
  now=421000;complete();await settle();assert.equal([...timers.values()][0].at,721000);
  scheduler.close();assert.equal(timers.size,0);
});
test("a schedule failure is observable and backs off five minutes",()=>{
  const errors=[],timers=[];
  const scheduler=createOverviewRefreshScheduler({refresh:{start(){throw Error("private exception");}},clock:()=>0,
    setTimer:(fn,ms)=>{timers.push(ms);return 1;},clearTimer:()=>{},onError:code=>errors.push(code)});
  assert.equal(scheduler.request(),false);assert.deepEqual(errors,["overview_refresh_schedule_failed"]);
  assert.equal(scheduler.status().errorCode,errors[0]);assert.deepEqual(timers,[300000]);scheduler.close();
});
