import test from "node:test";
import assert from "node:assert/strict";
import {createOverviewRefreshScheduler} from "./overview-refresh-scheduler.js";
import { attachOverviewRefreshIntervalChannel } from "./overview-refresh-scheduler.js";
import { EventEmitter } from "node:events";
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

test("disabled scheduling preserves manual refresh and does not rearm on its completion", async () => {
  const timers = new Map(); let id = 0, finish, count = 0;
  const scheduler = createOverviewRefreshScheduler({ intervalSeconds: -1, refresh: {
    start() { count++; return true; }, whenSettled() { return new Promise(resolve => { finish = resolve; }); },
  }, setTimer(fn, ms) { const key = ++id; timers.set(key, { fn, ms }); return key; }, clearTimer: key => timers.delete(key) });
  scheduler.start(); assert.equal(timers.size, 0);
  assert.equal(scheduler.request(), true); assert.equal(count, 1);
  finish(); await settle(); assert.equal(timers.size, 0);
  scheduler.setIntervalSeconds(120); assert.equal([...timers.values()][0].ms, 120_000);
  const stale = [...timers.values()][0];
  scheduler.setIntervalSeconds(-1); stale.fn(); await settle();
  assert.equal(count, 1); assert.equal(timers.size, 0); scheduler.close();
});

test("changes during work apply once at completion and long durations do not overflow Node timers", async () => {
  const timers = new Map(); let id = 0, finish, starts = 0;
  const scheduler = createOverviewRefreshScheduler({ refresh: {
    start() { starts++; return true; }, whenSettled() { return new Promise(resolve => { finish = resolve; }); },
  }, setTimer(fn, ms) { const key = ++id; timers.set(key, { fn, ms }); return key; }, clearTimer: key => timers.delete(key) });
  scheduler.start(); scheduler.request(); scheduler.setIntervalSeconds(60); scheduler.setIntervalSeconds(180);
  assert.equal(timers.size, 0); finish(); await settle();
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0].ms, 180_000);
  scheduler.setIntervalSeconds(3_000_000);
  const [key, first] = [...timers][0];
  assert.equal(first.ms, 2_147_483_647); timers.delete(key); first.fn();
  assert.equal(starts, 1); assert.equal([...timers.values()][0].ms, 852_516_353);
  scheduler.close();
});

test("parent schedule channel validates exact messages and leaves broker traffic untouched", () => {
  const channel = new EventEmitter(), values = [];
  const detach = attachOverviewRefreshIntervalChannel({ channel, scheduler: { setIntervalSeconds: value => values.push(value) } });
  for (const message of [null, [], { type: "credential.request", seconds: 60 },
    { type: "tibotattle.refresh-interval.v1", seconds: 0 },
    { type: "tibotattle.refresh-interval.v1", seconds: 61 },
    { type: "tibotattle.refresh-interval.v1", seconds: "60" },
    { type: "tibotattle.refresh-interval.v1", seconds: 60, extra: true }]) channel.emit("message", message);
  assert.deepEqual(values, []);
  channel.emit("message", { type: "tibotattle.refresh-interval.v1", seconds: -1 });
  channel.emit("message", { type: "tibotattle.refresh-interval.v1", seconds: 120 });
  assert.deepEqual(values, [-1, 120]); detach(); assert.equal(channel.listenerCount("message"), 0);
});
