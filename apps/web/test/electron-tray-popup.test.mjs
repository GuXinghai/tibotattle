import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTrayPopupProjection, renderTrayPopup, requestTrayPopupAction, observeTrayPopupContentHeight, bootstrapTrayPopup, TRAY_POPUP_ACTIONS } from "../public/electron-tray-popup.js";
import { SUPPORTED_LOCALES, translate } from "../public/localization.js";
const NOW = "2026-09-04T18:00:00.000Z";
function fixture() { return {
  freshness:{status:"live",latestObservedAt:NOW,staleAfterSeconds:1800},
  quotaWindows:[300,10080].map((durationMinutes,i)=>({limitId:"codex",slot:"primary",durationMinutes,usedPercent:25+i*15,remainingPercent:75-i*15,observedAt:NOW,status:"live",resetAt:i?"2026-09-07T20:00:00.000Z":"2026-09-04T20:00:00.000Z"})),
  workload:{schemaVersion:"overview-workload-v9",status:"available",generatedAt:NOW,unallocated:{totalIntervals:0,plans:[],records:[],truncated:false},
    current:{windowMinutes:15,state:"available",usdPerHour:12.8,level:"medium"},
    trend:{windowMinutes:60,state:"available",ratePpPerHour:1,usdPerHour:8.4,level:"light",observedFrom:"2026-09-04T17:40:00Z",observedThrough:NOW,coveredMinutes:20,inferred:false}}
}; }
const project=data=>createTrayPopupProjection(data,{now:NOW});
class FakeElement {
  constructor(dataset = {}) {
    this.dataset = { ...dataset };
    this.children = [];
    this.listeners = new Map();
    this.classList = { toggle() {} };
    this.style = {};
    this.attributes = new Map();
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
    this.nodeType = 1;
    this.rect = { height: 480 };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getBoundingClientRect() {
    return this.rect;
  }
}

class FakeDocument {
  constructor(visibilityState = "visible") {
    this.visibilityState = visibilityState;
    this.listeners = new Map();
    this.documentElement = new FakeElement();
    this.elements = new Map();
    for (const id of ["tray-popup", "allowance-lanes", "allowance-unavailable", "tray-popup-freshness", "tray-popup-live", "tray-popup-open-label", "tray-short-level", "tray-short-value", "tray-trend-level", "tray-trend-value"]) this.elements.set(id, new FakeElement());
    this.ranges = [new FakeElement({ historyRange: "7d" }), new FakeElement({ historyRange: "30d" })];
    this.actions = [new FakeElement({ action: "open" })];
  }

  createElement() {
    return new FakeElement();
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-history-range]") return this.ranges;
    if (selector === "[data-action]") return this.actions;
    return [];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) listener({ target: this });
  }
}

function fakeWindow() {
  const listeners = new Map();
  return {
    navigator: { language: "en-US", languages: ["en-US"] },
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? [];
      values.push(listener);
      listeners.set(type, values);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}


test("compact assets expose only the existing open action with local CSP and neutral theme roles", async()=>{
  const html=await readFile(new URL('../public/electron-tray-popup.html',import.meta.url),'utf8');
  const css=await readFile(new URL('../public/electron-tray-popup.css',import.meta.url),'utf8');
  assert.deepEqual([...html.matchAll(/data-action="([^"]+)"/g)].map(x=>x[1]),['open']);
  assert.doesNotMatch(html,/data-history-range|<details|pace-section|history-bars|data-action="refresh"|https?:/);
  assert.match(html,/script-src 'self'/);assert.doesNotMatch(html,/<script[^>]*>[^<]+/);
  assert.match(css,/currentColor 0 2px,transparent 2px 3px/);assert.match(css,/background-size:100% 1px/);
  assert.match(css,/span:hover/);assert.match(css,/focus-visible/);assert.match(css,/prefers-color-scheme:dark/);
  assert.match(css,/--tray-tertiary:#888/);assert.doesNotMatch(css,/content:.*↗|100vh|#174f45|#e52b21/i);
});
test("single and missing allowance windows never invent an unreported lane",()=>{
  for(const durations of [[300,10080],[10080],[300],[]]){
    const f=fixture();f.quotaWindows=f.quotaWindows.filter(x=>durations.includes(x.durationMinutes));
    const p=project(f);assert.deepEqual(p.allowances.map(x=>x.durationMinutes),durations);
    assert.equal(p.workload.current.usdPerHour,12.8);
    const doc=new FakeDocument();renderTrayPopup(doc,p);
    assert.equal(doc.getElementById('allowance-lanes').children.length,durations.length);
    assert.equal(doc.getElementById('allowance-unavailable').hidden,durations.length>0);
  }
});
test("independent stale lanes hide numeric claims without hiding a valid sibling",()=>{
  const f=fixture();f.quotaWindows[0].observedAt='2026-09-04T17:29:59.000Z';
  const p=project(f);assert.equal(p.allowances[0].state,'stale');assert.equal(p.allowances[0].remainingPercent,null);
  assert.equal(p.allowances[1].remainingPercent,60);
  const doc=new FakeDocument();renderTrayPopup(doc,p);
  assert.equal(doc.getElementById('allowance-lanes').children[0].children[1].textContent,'—');
  assert.equal(doc.getElementById('allowance-lanes').children[0].children[2].textContent,'Out of date');
});
test("quota admission rejects invalid percentages, dates, future observations and passed resets",()=>{
  for(const mutate of [x=>x.usedPercent=90,x=>x.remainingPercent=-1,x=>x.resetAt='bad',x=>x.resetAt='2026-10-04T18:00:00.000Z',x=>x.resetAt='2026-09-04T17:59:59.000Z',x=>x.observedAt='2026-09-04T18:01:00.000Z']){
    const f=fixture();mutate(f.quotaWindows[0]);const p=project(f);
    assert.notEqual(p.allowances[0].state,'available');assert.equal(p.allowances[0].remainingPercent,null);
    assert.equal(p.allowances[1].remainingPercent,60);
  }
});
test("quota admission selects the explicit primary before recency and never borrows a sibling",()=>{
  const f=fixture();const other={...f.quotaWindows[1],slot:'secondary',remainingPercent:80,usedPercent:20};
  f.quotaWindows.push(other,{...other,limitId:'codex_bengalfox'});assert.equal(project(f).allowances[1].remainingPercent,60);
  f.quotaWindows[1].observedAt='2026-09-04T17:20:00.000Z';assert.equal(project(f).allowances[1].state,'stale');
  f.quotaWindows=f.quotaWindows.filter(x=>x.slot!=='primary');assert.equal(project(f).allowances[0].remainingPercent,80);
});
test("freshness follows the clock rather than serialized age, and all stale pools use one notice",()=>{
  const f=fixture();f.freshness.ageSeconds=1;
  const p=createTrayPopupProjection(f,{now:'2026-09-04T18:30:00.001Z'});
  assert.equal(p.freshness.status,'stale');assert.equal(p.allowances[0].remainingPercent,null);
  const doc=new FakeDocument();renderTrayPopup(doc,p);assert.equal(doc.getElementById('allowance-lanes').children.length,0);
  assert.equal(doc.getElementById('allowance-unavailable').textContent,'Out of date');
});
test("both rates use the shared v9 contract and preserve unknown grades, zero and inference",()=>{
  const f=fixture();f.workload.current.usdPerHour=0;f.workload.current.level='unclassified';f.workload.trend.inferred=true;
  const p=project(f);assert.equal(p.workload.current.usdPerHour,0);assert.equal(p.workload.current.level,null);
  const doc=new FakeDocument();renderTrayPopup(doc,p);
  assert.equal(doc.getElementById('tray-short-level').textContent,'—');assert.equal(doc.getElementById('tray-short-value').textContent,'US$0');
  assert.match(doc.getElementById('tray-trend-value').textContent,/≈ US\$8.4 \*/);
  assert.deepEqual(Object.keys(p.workload.current),['windowMinutes','state','usdPerHour','level','inferred']);
  assert.ok(Object.isFrozen(p.workload.current));
});
test("each rate fails closed independently on missing price, old contract and stale or future evidence",()=>{
  for(const mutate of [f=>f.workload.schemaVersion='overview-workload-v8',f=>f.workload.status='stale',f=>f.workload.generatedAt='2026-09-04T17:40:00.000Z',f=>f.workload.generatedAt='2026-09-04T18:01:00.000Z']){
    const f=fixture();mutate(f);assert.equal(project(f).workload.current.state,'unknown');assert.equal(project(f).workload.trend.state,'unknown');
  }
  for(const mutate of [x=>x.usdPerHour=null,x=>x.usdPerHour=-1,x=>x.windowMinutes=60]){
    const f=fixture();mutate(f.workload.current);assert.equal(project(f).workload.current.state,'unknown');assert.equal(project(f).workload.trend.state,'available');
  }
  const f=fixture();f.workload.trend.observedFrom='2026-09-04T16:00:00Z';assert.equal(project(f).workload.trend.state,'unknown');assert.equal(project(f).workload.current.state,'available');
});
test("account replacement and offline data cannot retain the prior account's displayed figures",()=>{
  const doc=new FakeDocument();renderTrayPopup(doc,project(fixture()));
  renderTrayPopup(doc,project({freshness:{status:'offline'}}));
  assert.equal(doc.getElementById('allowance-lanes').children.length,0);assert.equal(doc.getElementById('tray-short-value').textContent,'—');
  assert.equal(doc.getElementById('tray-trend-value').textContent,'—');
});
test("legacy composition preferences cannot hide the new compact evidence",()=>{
  const doc=new FakeDocument();renderTrayPopup(doc,project(fixture()),{preferences:{sections:[],metrics:[],density:'compact'}});
  assert.equal(doc.getElementById('allowance-lanes').children.length,2);assert.equal(doc.getElementById('tray-short-level').textContent,'Medium');
});
test("compact copy is translated and the only bridge action has no extra arguments",()=>{
  for(const locale of SUPPORTED_LOCALES)for(const key of ['title','fiveHour','weekly','shortTerm','trend','unit','open','unknown','stale','offline'])assert.notEqual(translate('electron.trayCompact.'+key,{},locale),'electron.trayCompact.'+key);
  const calls=[];const bridge={requestAction:x=>calls.push(x)};
  assert.deepEqual(TRAY_POPUP_ACTIONS,['open']);assert.equal(requestTrayPopupAction(bridge,'open'),true);
  for(const action of ['refresh','more','customize','usage','file:///private'])assert.equal(requestTrayPopupAction(bridge,action),false);
  assert.equal(requestTrayPopupAction(bridge,'open','secret'),false);assert.deepEqual(calls,['open']);
});

test("tray freshness does not call startup or unknown evidence collecting",()=>{
  const doc=new FakeDocument();
  const t=(key)=>({
    "electron.trayCompact.starting":"Starting",
    "electron.trayCompact.noObservation":"No observation",
    "electron.trayPopover.headerUpdating":"Updating",
    "electron.trayPopover.headerUpdated":"Updated {age}",
  })[key]??key;
  renderTrayPopup(doc,project(fixture()),{t,mainModel:{status:"starting",refreshEnabled:false}});
  assert.equal(doc.getElementById("tray-popup-freshness").textContent,"Starting");
  renderTrayPopup(doc,project({...fixture(),freshness:{status:"unknown",latestObservedAt:null,staleAfterSeconds:1800}}),{t});
  assert.equal(doc.getElementById("tray-popup-freshness").textContent,"No observation");
  renderTrayPopup(doc,project({...fixture(),freshness:{status:"live",latestObservedAt:null,staleAfterSeconds:1800}}),{t});
  assert.equal(doc.getElementById("tray-popup-freshness").textContent,"No observation");
});

test("content-height reporting follows intrinsic changes through the narrow bridge", () => {
  class FakeResizeObserver {
    static latest = null;

    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      FakeResizeObserver.latest = this;
    }

    observe(target) {
      this.target = target;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const documentRef = new FakeDocument();
  const root = documentRef.getElementById("tray-popup");
  root.rect = { height: 489.1 };
  const reported = [];
  const cleanup = observeTrayPopupContentHeight({
    windowRef: {
      ResizeObserver: FakeResizeObserver,
      usageMonitorTrayPopover: {
        reportContentHeight(height) {
          reported.push(height);
        },
      },
    },
    documentRef,
  });
  assert.deepEqual(reported, [490]);
  FakeResizeObserver.latest.callback();
  assert.deepEqual(reported, [490]);
  root.rect = { height: 501 };
  FakeResizeObserver.latest.callback();
  assert.deepEqual(reported, [490, 501]);
  cleanup();
  assert.equal(FakeResizeObserver.latest.disconnected, true);
});

test("hidden popup model events wait for visibility before reading the companion", async () => {
  const documentRef = new FakeDocument("hidden");
  const windowRef = fakeWindow();
  let modelListener;
  let loadCalls = 0;
  const client = {
    async load() {
      loadCalls += 1;
      return {};
    },
  };
  const bridge = {
    onModel(listener) {
      modelListener = listener;
    },
    requestAction() {},
  };

  await bootstrapTrayPopup({ windowRef: { ...windowRef, usageMonitorTrayPopover: bridge }, documentRef, client });
  assert.equal(loadCalls, 0);
  modelListener();
  assert.equal(loadCalls, 0);

  documentRef.visibilityState = "visible";
  documentRef.dispatch("visibilitychange");
  await tick();
  assert.equal(loadCalls, 1);
  assert.equal(documentRef.documentElement.attributes.get("data-tray-popup-ready"), "true");
});

test("native popup visibility gates visible-DOM loads and reopens on the host signal", async () => {
  const documentRef = new FakeDocument("visible");
  const windowRef = fakeWindow();
  let modelListener;
  let visibilityListener;
  let nativeVisible = false;
  let loadCalls = 0;
  const client = {
    async load() {
      loadCalls += 1;
      return {};
    },
  };
  const bridge = {
    getVisibility() {
      return nativeVisible;
    },
    onModel(listener) {
      modelListener = listener;
    },
    onVisibility(listener) {
      visibilityListener = listener;
    },
    requestAction() {},
  };

  await bootstrapTrayPopup({
    windowRef: { ...windowRef, usageMonitorTrayPopover: bridge },
    documentRef,
    client,
  });
  assert.equal(loadCalls, 0);
  modelListener();
  documentRef.dispatch("visibilitychange");
  await tick();
  assert.equal(loadCalls, 0);

  nativeVisible = true;
  visibilityListener(true);
  await tick();
  assert.equal(loadCalls, 1);
  assert.equal(documentRef.documentElement.attributes.get("data-tray-popup-ready"), "true");
});

test("visible popup model events coalesce in-flight reads and fence one follow-up per burst", async () => {
  const documentRef = new FakeDocument("visible");
  const windowRef = fakeWindow();
  let modelListener;
  let loadCalls = 0;
  const resolvers = [];
  const client = {
    load() {
      loadCalls += 1;
      return new Promise((resolve) => resolvers.push(resolve));
    },
  };
  const bridge = {
    onModel(listener) {
      modelListener = listener;
    },
    requestAction() {},
  };

  const bootstrap = bootstrapTrayPopup({
    windowRef: { ...windowRef, usageMonitorTrayPopover: bridge },
    documentRef,
    client,
  });
  await tick();
  assert.equal(loadCalls, 1);
  modelListener();
  modelListener();
  assert.equal(loadCalls, 1);
  resolvers.shift()({});
  await tick();
  assert.equal(loadCalls, 2);
  modelListener();
  modelListener();
  assert.equal(loadCalls, 2);
  resolvers.shift()({});
  await bootstrap;
  await tick();
  assert.equal(loadCalls, 3);
  resolvers.shift()({});
  await tick();
  assert.equal(loadCalls, 3);
});

test("failed companion reads remove live claims and a retry replaces the failed snapshot",async()=>{
  const doc=new FakeDocument();const windowRef=fakeWindow();let reads=0,listener;
  const f=fixture();f.freshness.latestObservedAt=new Date().toISOString();f.quotaWindows.forEach(x=>{x.observedAt=f.freshness.latestObservedAt;x.resetAt=new Date(Date.now()+3600000).toISOString();});f.workload.generatedAt=f.freshness.latestObservedAt;
  await bootstrapTrayPopup({documentRef:doc,windowRef:{...windowRef,usageMonitorTrayPopover:{requestAction(){},onModel(x){listener=x;}}},client:{async load(){reads++;if(reads===2)throw new Error('private path');return f;}}});
  listener({status:'fresh',refreshEnabled:true});await tick();assert.equal(doc.getElementById('allowance-lanes').children.length,0);
  assert.equal(doc.getElementById('tray-short-value').textContent,'—');assert.equal(doc.getElementById('tray-popup-freshness').textContent,'Disconnected');
  listener({status:'fresh',refreshEnabled:true});await tick();assert.equal(doc.getElementById('allowance-lanes').children.length,2);
});
