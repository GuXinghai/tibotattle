import test from "node:test";
import assert from "node:assert/strict";
import {createOverviewRefreshScheduler} from "./overview-refresh-scheduler.js";
import { attachOverviewRefreshIntervalChannel } from "./overview-refresh-scheduler.js";
import { EventEmitter } from "node:events";
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};

test("persistent pause blocks all modes, retains interval, cancels work and resumes only after settlement", async () => {
  const timers = new Map(); let id = 0, starts = 0, cancels = 0, finish;
  const scheduler = createOverviewRefreshScheduler({ paused: true, intervalSeconds: 420,
    refresh: { request() { starts++; return { started: true }; }, cancel() { cancels++; },
      whenSettled: () => new Promise(resolve => { finish = resolve; }) },
    setTimer(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimer: key => timers.delete(key) });
  scheduler.start();
  for (const mode of ["quick", "overview", "detailed"]) assert.equal(scheduler.submit({ mode }).started, false);
  assert.equal(starts, 0); assert.equal(timers.size, 0);
  scheduler.setIntervalSeconds(60); assert.equal(timers.size, 0);
  scheduler.setPaused(false); assert.equal([...timers.values()][0].ms, 60_000);
  scheduler.submit({ mode: "overview" });
  scheduler.setPaused(true); assert.equal(cancels, 1); assert.equal(timers.size, 0);
  assert.equal(scheduler.status().paused, true);
  scheduler.setIntervalSeconds(180); scheduler.setPaused(false);
  assert.equal(timers.size, 0, "resume cannot race the cancelling writer");
  finish(); await settle();
  assert.equal(timers.size, 1); assert.equal([...timers.values()][0].ms, 180_000);
  assert.equal(starts, 1); scheduler.close();
});

test("pause invalidates an automatic permission check even after immediate resume", async () => {
  let permit, starts = 0; const timers = new Map(); let id = 0;
  const scheduler = createOverviewRefreshScheduler({ refresh: { start() { starts++; }, whenSettled: async () => {} },
    canAutomaticallyRefresh: () => new Promise(resolve => { permit = resolve; }),
    setTimer(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimer: key => timers.delete(key) });
  scheduler.start(); const [key, timer] = [...timers][0]; timers.delete(key); timer.fn();
  scheduler.setPaused(true); scheduler.setPaused(false); permit(true); await settle();
  assert.equal(starts, 0); assert.equal(timers.size, 1); scheduler.close();
});
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
  const pauses = [];
  const detach = attachOverviewRefreshIntervalChannel({ channel, scheduler: { setIntervalSeconds: value => values.push(value), setPaused: value => pauses.push(value) } });
  for (const message of [null, [], { type: "credential.request", seconds: 60 },
    { type: "tibotattle.refresh-interval.v2", seconds: 0, paused: false },
    { type: "tibotattle.refresh-interval.v2", seconds: 61, paused: false },
    { type: "tibotattle.refresh-interval.v2", seconds: "60", paused: false },
    { type: "tibotattle.refresh-interval.v2", seconds: 60, paused: "false" },
    { type: "tibotattle.refresh-interval.v2", seconds: 60 },
    { type: "tibotattle.refresh-interval.v2", seconds: 60, paused: false, extra: true }]) channel.emit("message", message);
  assert.deepEqual(values, []);
  channel.emit("message", { type: "tibotattle.refresh-interval.v2", seconds: -1, paused: true });
  channel.emit("message", { type: "tibotattle.refresh-interval.v2", seconds: 120, paused: false });
  assert.deepEqual(pauses, [true, false]);
  assert.deepEqual(values, [-1, 120]); detach(); assert.equal(channel.listenerCount("message"), 0);
});


test("automatic cadence checks analysis permission and does not accumulate denied ticks", async () => {
  const timers = new Map(); let key = 0, allowed = false, calls = 0;
  const scheduler = createOverviewRefreshScheduler({
    refresh: { start() { calls++; return true; }, whenSettled: () => Promise.resolve() },
    canAutomaticallyRefresh: async () => allowed,
    setTimer(fn, ms) { timers.set(++key, { fn, ms }); return key; }, clearTimer: id => timers.delete(id),
  });
  const tick = async () => { const [id, timer] = [...timers][0]; timers.delete(id); timer.fn(); await settle(); };
  scheduler.start(); await tick(); assert.equal(calls, 0); assert.equal(timers.size, 1);
  allowed = true; await tick(); assert.equal(calls, 1); await settle();
  assert.equal(timers.size, 1); scheduler.close();
});

test("all modes use the scheduler submission and completion deadline", async () => {
  let finish; const options = [], timers = new Map(); let key = 0;
  const scheduler = createOverviewRefreshScheduler({ refresh: {
    request(value) { options.push(value); return { started: true, joined: false, pending: false, refresh: { mode: value.mode } }; },
    whenSettled: () => new Promise(resolve => { finish = resolve; }),
  }, setTimer(fn, ms) { timers.set(++key, { fn, ms }); return key; }, clearTimer: id => timers.delete(id) });
  scheduler.start(); const result = scheduler.submit({ mode: "quick", reason: "manual" });
  assert.equal(result.refresh.mode, "quick"); assert.deepEqual(options, [{ mode: "quick", reason: "manual" }]);
  assert.equal(timers.size, 0); finish(); await settle();
  assert.equal([...timers.values()][0].ms, 300_000); scheduler.close();
});
