import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { comparisonReading, retainedPageIndex, dashboardReadFailure, observedAllowancePoints, mountAllowancePage } from '../public/allowance-page.js';
import { translate, SUPPORTED_LOCALES } from '../public/localization.js';
import { LocalCompanionClient } from '../public/data-client.js';

test('read failures retain safe categories and never project raw error content', () => {
  for (const [error,kind] of [
    [{status:503},'request'],[{name:'TimeoutError'},'timeout'],
    [new SyntaxError('private payload'),'parse'],[{code:'report_schema_invalid'},'validation'],
    [{code:'report_expired'},'stale'],[{code:'local_index_failed'},'local'],
  ]) assert.equal(dashboardReadFailure(error).copyKey,`allowance.simple.failure.${kind}`);
  assert.equal(dashboardReadFailure({name:'AbortError'}),null);
  assert.equal(dashboardReadFailure({code:'private/path',message:'private payload'}).code,'report_read_failed');
});

test('overview failures preserve the original status and bounded code', async () => {
  const error=Object.assign(new Error('synthetic'),{status:503,code:'local_index_failed'});
  const client=new LocalCompanionClient({fetchImpl:async()=>{throw error;}});
  await assert.rejects(client.load(),value=>value===error);
});

test('secondary report failures cannot silently replace a coherent report with empty data', async () => {
  const signals=[];
  const error=Object.assign(new Error('synthetic'),{code:'report_expired',status:503});
  const client=new LocalCompanionClient({fetchImpl:async(url,options)=>{
    signals.push(options.signal);
    if(url.endsWith('/weekly'))throw error;
    return new Response('{}',{status:200,headers:{'content-type':'application/json'}});
  }});
  await assert.rejects(client.load(),value=>value===error);
  assert.equal(signals.length,4);
  assert.ok(signals.every(signal=>signal===signals[0]&&signal instanceof AbortSignal));
});

test('comparison selection never borrows future evidence or skips an explicit unavailable point', () => {
  const a={timestampMs:1000,observed:2,expected:1}, b={timestampMs:3000,observed:null,expected:2};
  assert.equal(comparisonReading([b,a],999),null);
  assert.equal(comparisonReading([b,a],2500),a);
  assert.equal(comparisonReading([b,a],3000),b);
  assert.equal(comparisonReading([a],3_601_001),null);
});

test('new records preserve a paged identity and removed records clamp the page', () => {
  const rows=Array.from({length:31},(_,id)=>({id}));
  const next=[...Array.from({length:12},(_,i)=>({id:100+i})),...rows];
  assert.equal(retainedPageIndex(rows,next,1,10,r=>r.id),2);
  assert.equal(retainedPageIndex(rows,rows.slice(0,4),3,10,r=>r.id),0);
  assert.equal(retainedPageIndex([],[],0,10,r=>r.id),0);
});

test('quota-only charts preserve exact observations, reset breaks, missing values and range boundaries', () => {
  const start=Date.parse('2026-08-01T00:00:00Z');
  const row=(hour,remainingPercent,resetAt='a')=>({observedAt:new Date(start+hour*3_600_000).toISOString(),remainingPercent,resetAt});
  const rows=[row(9,20),row(0,70),row(1,null),row(2,60),row(3,100,'b'),row(10,19)];
  const before=JSON.stringify(rows);
  const points=observedAllowancePoints(rows,{startMs:start,endMs:start+9*3_600_000},(a,b)=>a===b);
  assert.deepEqual(points.map(p=>p.allowanceRemaining),[70,null,60,100,20]);
  assert.deepEqual(points.map(p=>p.allowanceSegment),[0,0,0,1,2]);
  assert.equal(points[2].timestampMs,start+2*3_600_000);
  assert.equal(points[2].allowanceObservedAt,rows[3].observedAt);
  assert.equal(JSON.stringify(rows),before);
  assert.deepEqual(observedAllowancePoints(rows,{startMs:start+11*3_600_000,endMs:start+12*3_600_000},(a,b)=>a===b),[]);
});

test('native publication signals coalesce while busy and a failed reread is visible', async () => {
  const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  const fn=source.match(/^async function reloadLocalEvidenceAfterNativeRefresh\(\) \{[\s\S]*?^\}/mu)[0];
  let reads=0,release;const notices=[];
  const context=createContext({nativeEvidenceReloadInFlight:false,nativeEvidenceReloadPending:false,dashboardReadFailed:false,
    localActionBusy:true,localRefreshInProgress:false,
    dashboardReadFailure,
    loadQuickResultDashboard:()=>{reads++;return new Promise((resolve,reject)=>{release=reject;});},
    showConnectionNotice:value=>notices.push(value),diagnosticErrorCode:()=> 'report_invalid',
    setGlobalState:()=>{},t:key=>key});
  runInContext(fn,context);
  await context.reloadLocalEvidenceAfterNativeRefresh();
  await context.reloadLocalEvidenceAfterNativeRefresh();
  assert.equal(reads,0);assert.equal(context.nativeEvidenceReloadPending,true);
  context.localActionBusy=false;
  const work=context.reloadLocalEvidenceAfterNativeRefresh();
  assert.equal(reads,1);assert.equal(context.nativeEvidenceReloadPending,false);
  release(Object.assign(new Error('synthetic'), {code:'report_invalid'}));await work;
  assert.equal(notices[0].kind,'error');assert.equal(notices[0].copyValues.code,'report_invalid');
  assert.equal(context.nativeEvidenceReloadInFlight,false);
});

test('compact allowance actions have matching translations in all shipped locales', () => {
  for(const locale of SUPPORTED_LOCALES)for(const key of ['records','resets','estimate','drift','exceptions','comparison','method','tools','current','loadFailed','comparisonUnavailable','usageUnavailable']) {
    const full=`allowance.simple.${key}`;
    assert.notEqual(translate(full,{value:'72%'},locale),full);
  }
});

test('a prior calibration annotation follows its estimate into details instead of labeling the primary chart', () => {
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = new Map();
      this.className = ''; this.value = ''; this.scrollTop = 0; this.clientWidth = 900;
      this.classList = {add: name => {this.className += ` ${name}`;}};
    }
    get childNodes() { return this.children; }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    append(...nodes) { for (const node of nodes) {node.remove(); node.parentElement = this; this.children.push(node);} }
    prepend(...nodes) { for (const node of [...nodes].reverse()) {node.remove(); node.parentElement = this; this.children.unshift(node);} }
    before(...nodes) { const parent = this.parentElement; for (const node of nodes) {node.remove(); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this), 0, node);} }
    after(...nodes) { for (const node of [...nodes].reverse()) {node.remove(); node.parentElement = this.parentElement; this.parentElement.children.splice(this.parentElement.children.indexOf(this) + 1, 0, node);} }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener() {}
    querySelector(selector) {
      return this.children.find(child => selector.startsWith('.') ? child.className.split(/\s+/).includes(selector.slice(1)) : child.tagName === selector)
        ?? this.children.map(child => child.querySelector(selector)).find(Boolean) ?? null;
    }
    showModal() { this.open = true; }
  }
  const body = new Element('body'), nodes = new Map();
  const add = (selector, parent = body) => {
    const node = new Element();
    if (selector.startsWith('#')) node.id = selector.slice(1); else node.className = selector.slice(1);
    parent.append(node); nodes.set(selector, node); return node;
  };
  const root = add('#allowance-screen'), header = add('.dashboard-page-header', root);
  const note = add('#weekly-stale-note', header), capacity = add('.trends-capacity-panel', root);
  const comparison = add('.trends-comparison-panel', root);
  for (const selector of ['#allowance-timeline-chart','.trends-time-controls','#usage-group-controls',
    '#trends-activity-label','#usage-timeline-chart','#usage-timeline-empty','.chart-navigation',
    '#trends-replay','#trends-latest','#usage-timeline-summary','#usage-timeline-coverage']) add(selector, capacity);
  for (const selector of ['#difference-timeline-chart','.chart-heading','.calibration-legend','#timeline-chart',
    '#timeline-coverage','#residual-coverage','.trends-evidence-details']) add(selector, comparison);
  for (const selector of ['.allowance-equivalent','#allowance-window-control','.trends-drift-panel',
    '.divergence-panel','.trends-exact-panel','#weekly-plan-control','.topbar']) add(selector, root);
  const documentRef = {querySelector: selector => nodes.get(selector) ?? null,
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    createComment: () => new Element('#comment'), addEventListener() {}, documentElement: {lang: 'en-US'},
    defaultView: {addEventListener() {}, dispatchEvent() {}, localStorage: {getItem: () => null}}};
  const page = mountAllowancePage({documentRef, t: key => key, formatMoney: String, formatPp: String,
    formatInstant: String, formatPercent: String, formatReset: String, selectTime() {}, stopPlayback() {}});
  assert.equal(header.contains(note), false, 'a stale calibration cannot label the primary interval view');
  assert.equal(note.parentElement.dataset.allowanceDetail, 'estimate');
  const dialog = root.children.find(node => node.id === 'allowance-detail-dialog');
  assert.equal(dialog.contains(note), false, 'details stay hidden until requested');
  page.open('estimate');
  assert.equal(dialog.open, true);
  assert.equal(dialog.contains(note), true);
  assert.equal(dialog.contains(nodes.get('.allowance-equivalent')), true, 'provenance accompanies the retained estimate');
  page.open('complete');
  assert.equal(dialog.contains(note), false, 'the annotation cannot leak into interval-only details');
});
