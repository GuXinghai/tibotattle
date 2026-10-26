import test from 'node:test';
import assert from 'node:assert/strict';
import {mountWeeklyApiChart} from '../public/weekly-api-chart.js';
import {translate,SUPPORTED_LOCALES} from '../public/localization.js';
import {normalizeWeeklyApiIntervals} from '../public/weekly-api-intervals.js';

class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes=new Map();this.style={};this.dataset={};this.listeners={};this.clientWidth=900;this.value='';this.textContent='';this.isConnected=true;}
 append(...values){this.children.push(...values);}
 replaceChildren(...values){this.children=[...values];}
 setAttribute(k,v){this.attributes.set(k,String(v));}
 getAttribute(k){return this.attributes.get(k)??null;}
 addEventListener(k,f){this.listeners[k]=f;}
 querySelector(tag){return this.children.find(e=>e.tagName===tag)??null;}
 getBoundingClientRect(){return {left:0,width:900};}
}
function fixture(){
 const storage=new Map(),events=[];
 const documentRef={createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),
  documentElement:{lang:'en-US'},defaultView:{addEventListener:(type,fn)=>events.push([type,fn]),
   localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)}}};
 const calls=[];const chart=mountWeeklyApiChart({documentRef,t:(key,values)=>translate(key,values,documentRef.documentElement.lang),
  formatMoney:n=>String(n),formatInstant:n=>new Date(n).toISOString(),onDetails:()=>calls.push('details'),onRetry:()=>calls.push('retry')});
 const find=(id,e=chart.root)=>e.id===id?e:e.children.map(c=>typeof c==='object'?find(id,c):null).find(Boolean);
 return {chart,find,storage,events,calls,documentRef};
}
const start=Date.parse('2026-10-10T00:00:00.000Z'),hour=3_600_000;
const rows=[{startMs:start,endMs:start+hour,weeklyUsd:100,segment:1,reason:null},
 {startMs:start+hour,endMs:start+3*hour,weeklyUsd:200,segment:1,reason:null},
 {startMs:start+3*hour,endMs:start+4*hour,weeklyUsd:null,segment:2,reason:'awaiting_change'}];
const data=(extra={})=>({period:'24h',planType:'plus',projection:{status:'available',rows},
 generatedAt:new Date(start+4*hour).toISOString(),startMs:start,endMs:start+4*hour,...extra});
test('chart publishes latest valid time, exact pixel-aligned selection and explicit gaps without a timer',()=>{
 const {chart,find,events,calls}=fixture();chart.update(data());
 assert.equal(chart.reading().sigma,30);assert.ok(chart.reading().selected<rows[2].startMs);
 const time=find('weekly-api-time');time.value='979167';time.oninput();
 assert.ok(Math.abs(chart.reading().selected-(start+3.5*hour))<100);
 const svg=chart.root.children.at(-1).children[0],guide=svg.children.at(-1);
 assert.ok(Math.abs(Number(guide.getAttribute('x1'))-(62+.979167*(900-76)))<.001);
 assert.equal(chart.root.children[1].children[0].textContent,'—');
 assert.deepEqual(events.map(e=>e[0]),['resize']);find('weekly-api-details').onclick();assert.deepEqual(calls,['details']);
});
test('sigma is display-only, remembered by period, and explicit off survives switching and refresh',()=>{
 const {chart,find,storage}=fixture();chart.update(data());const sigma=find('weekly-api-sigma');
 sigma.value='0';sigma.onchange();assert.equal(chart.reading().sigma,0);
 chart.update(data({period:'7d'}));assert.equal(chart.reading().sigma,60);
 sigma.value='240';sigma.onchange();chart.update(data());assert.equal(chart.reading().sigma,0);
 assert.match(storage.get('usagemonitor.weekly-api-sigma'),/"24h":0/);
 chart.update(data({projection:{status:'available',rows:[...rows]},generatedAt:new Date(start+5*hour).toISOString(),endMs:start+5*hour}));
 assert.equal(chart.reading().sigma,0);
});
test('regressed responses preserve previous plot; invalid smoothing and unavailable data stay visible',()=>{
 const {chart,find}=fixture();chart.update(data());const canvas=chart.root.children.at(-1),svg=canvas.children[0];
 const before=svg.children;chart.update(data({generatedAt:new Date(start).toISOString()}));
 assert.equal(chart.reading().failure,'weekly_api_report_regressed');assert.equal(svg.children,before);
 chart.update(data({projection:{status:'unavailable',reason:'weekly_api_source_mismatch',rows:[]}}));
 const sigma=find('weekly-api-sigma');sigma.value='15';sigma.onchange();
 assert.equal(chart.reading().failure,'weekly_api_source_mismatch');
 chart.update(data({projection:{status:'available',rows:[rows[0],{...rows[1],startMs:start+1}]}}));
 assert.equal(chart.reading().failure,'weekly_api_smoothing_invalid');
});
test('the closed browser contract rejects malformed evidence and every new status is translated',()=>{
 assert.equal(normalizeWeeklyApiIntervals(undefined).reason,'weekly_api_intervals_unavailable');
 assert.equal(normalizeWeeklyApiIntervals({rows:[],privatePath:'synthetic'}).reason,'weekly_api_validation_failed');
 for(const locale of SUPPORTED_LOCALES)for(const name of ['title','details','off','smoothing','reason.review_origin_unresolved',
  'loading','recalculating','updating','readFailed','failure.smoothing','failure.validation','failure.sourceUnavailable','failure.sourceMismatch','failure.stale','failure.resource','failure.pending','failure.projection']){
  const key=`allowance.interval.${name}`;assert.notEqual(translate(key,{code:'synthetic',value:30},locale),key);
 }
});

test('missing source verification and genuine source mismatch have distinct messages and keep plots unavailable',()=>{
 const {chart}=fixture();chart.setLoadState('ready');
 for(const [reason,key]of [['weekly_api_source_unavailable','sourceUnavailable'],['weekly_api_source_mismatch','sourceMismatch']]){
  chart.update(data({projection:{status:'unavailable',reason,rows:[]}}));
  const canvas=chart.root.children.at(-1);
  assert.equal(canvas.children[2].children[0].textContent,translate(`allowance.interval.failure.${key}`,{},'en-US'));
  assert.equal(canvas.children[0].children.length,0);
  assert.equal(chart.reading().failure,reason);
 }
});

test('loading, unavailable, failure and confirmed empty states never render fabricated zero evidence',()=>{
 const {chart,find,calls}=fixture();
 const canvas=chart.root.children.at(-1),svg=canvas.children[0],panel=canvas.children[2];
 const check=(state,message,retry)=>{
  assert.equal(chart.root.dataset.state,state);
  assert.equal(svg.children.length,0,'no axes, zero line, guide or empty verdict in an unavailable plot');
  assert.equal(svg.getAttribute('viewBox'),'0 0 900 300','plot bounds remain reserved');
  assert.equal(chart.root.children[1].style.visibility,'hidden');
  assert.equal(panel.hidden,false);assert.equal(panel.children[0].textContent,message);
  assert.equal(find('weekly-api-time').hidden,true);assert.equal(find('weekly-api-time').disabled,true);
  assert.equal(find('weekly-api-sigma').disabled,true);
  assert.equal(chart.root.children[2].hidden,true,'only one status is visible');
  assert.equal(find('weekly-api-state-retry').hidden,!retry);
 };
 check('loading','Loading interval data…',false);
 chart.update(data({projection:{status:'unavailable',reason:'weekly_api_source_pending',rows:[]}}));
 check('loading','Recalculating interval data; no previous chart is available to display.',false);
 chart.setLoadState('ready');
 check('unavailable','Interval data is unavailable for now',true);
 find('weekly-api-state-retry').onclick();assert.deepEqual(calls,['retry']);
 chart.setLoadState('error');check('error','Interval data could not be loaded',true);
 chart.setLoadState('loading');check('loading','Recalculating interval data; no previous chart is available to display.',false);
 chart.update(data({projection:{status:'unavailable',reason:'weekly_api_validation_failed',rows:[]}}));
 check('error','Interval validation failed',false);
 chart.setLoadState('ready');check('error','Interval validation failed',true);
 chart.update(data({projection:{status:'available',rows:[]}}));
 check('empty','No calculable intervals in this range',false);
 chart.update(data());
 assert.equal(chart.root.dataset.state,'ready');assert.equal(panel.hidden,true);
 assert.equal(chart.root.children[1].style.visibility,'');
 assert.equal(find('weekly-api-sigma').disabled,false);assert.equal(find('weekly-api-time').hidden,false);
 assert.ok(svg.children.some(e=>e.tagName==='path'&&e.getAttribute('d')));
});

test('a failed first read offers retry and a real zero value remains usable evidence',()=>{
 const {chart,find}=fixture();chart.setLoadState('error');
 assert.equal(chart.root.dataset.state,'error');assert.equal(find('weekly-api-state-retry').hidden,false);
 chart.setLoadState('ready');chart.update(data({projection:{status:'available',rows:[{...rows[0],weeklyUsd:0}]}}));
 assert.equal(chart.root.dataset.state,'ready');assert.equal(chart.root.children[1].children[0].textContent,'0');
 assert.equal(find('weekly-api-time').hidden,false);
});

test('saved language applies to loading and unavailable states before any data exists',()=>{
 const {chart,find,documentRef}=fixture();
 documentRef.documentElement.lang='zh-Hans';chart.setLoadState('loading');
 assert.equal(chart.root.children.at(-1).children[2].children[0].textContent,'正在加载区间数据…');
 assert.equal(find('weekly-api-sigma').children[0].textContent,'不平滑');
 chart.setLoadState('error');
 assert.equal(chart.root.children.at(-1).children[2].children[0].textContent,'无法读取区间数据');
});

test('pending recalculation without a prior curve stays explicit in every shipped locale',()=>{
 const {chart,find,documentRef}=fixture();
 for(const locale of SUPPORTED_LOCALES){
  documentRef.documentElement.lang=locale;chart.setLoadState('loading');
  for(const reason of ['weekly_api_source_pending','weekly_api_intervals_unavailable']){
   chart.update(data({projection:{status:'unavailable',reason,rows:[]}}));
   const canvas=chart.root.children.at(-1),panel=canvas.children[2];
   assert.equal(panel.children[0].textContent,translate('allowance.interval.recalculating',{},locale));
   assert.equal(canvas.children[0].children.length,0,'a retained summary cannot invent a curve or zero axis');
   assert.equal(find('weekly-api-time').disabled,true);
   assert.equal(chart.root.children[2].hidden,true,'no previous-report-retained notice accompanies an absent curve');
  }
 }
 chart.setLoadState('ready');chart.update(data());
 assert.equal(chart.root.dataset.state,'ready');
 assert.equal(chart.root.children.at(-1).children[2].hidden,true);
 assert.equal(find('weekly-api-time').disabled,false);
});

test('retained evidence stays selectable through updates and raw diagnostics stay out of the primary status',()=>{
 const {chart,find}=fixture();chart.setLoadState('ready');chart.update(data());
 const reading=chart.reading().selected,value=chart.root.children[1].children[0].textContent;
 chart.setLoadState('loading');chart.update(data({failure:'weekly_api_source_pending'}));
 assert.equal(chart.root.dataset.state,'ready');assert.equal(chart.reading().selected,reading);
 assert.equal(chart.root.children[1].children[0].textContent,value,'pending refresh preserves the displayed smoothed reading');
 assert.equal(find('weekly-api-sigma').disabled,false);
 const warning=chart.root.children[2];assert.equal(warning.hidden,false);
 assert.equal(warning.children[0].textContent,'Updating intervals; previous report retained');
 assert.equal(warning.children[1].hidden,true);
 chart.setLoadState('ready');assert.equal(warning.children[0].textContent,'Previous report retained');
 assert.equal(chart.reading().failure,'weekly_api_source_pending','the diagnostic remains available to details');
});
